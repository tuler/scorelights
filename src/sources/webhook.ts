/**
 * Receives score updates pushed over HTTP.
 *
 * `createWebhookHandler` is a plain `Request -> Response` function using only
 * Web APIs (WebCrypto for signatures), so the same handler sits behind
 * `Bun.serve` locally and inside the Worker's Games Durable Object.
 */
import { sportOf, type GameClock, type GameSnapshot, type GameState } from "../espn.ts";
import type { SportsEvent } from "../events.ts";
import { canonicalAbbreviation, findNflTeam, NFL_LEAGUE } from "../nfl.ts";
import type { Tracker } from "../tracker.ts";

export const WEBHOOK_SOURCE = "webhook";
const MAX_BODY_BYTES = 256 * 1024;
/** A signed request older or newer than this is refused, to limit replays. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

/** What one webhook delivery says. */
export interface WebhookUpdate {
  games: GameSnapshot[];
  /** Tracker source name; defaults to "webhook". A feeder names itself, e.g. "espn". */
  source?: string;
  /** `games` is the sender's whole scoreboard, so games missing from it have left it. */
  complete?: boolean;
}

/** Translates one provider's webhook into game snapshots. */
export interface WebhookAdapter {
  name: string;
  /** Whether the request was signed with `secret`. `body` is the raw text. */
  verify(headers: Headers, body: string, secret: string, nowMs: number): Promise<boolean>;
  /** Throw `WebhookError` for a payload this adapter cannot read. */
  parse(payload: unknown, league: string): WebhookUpdate;
}

export class WebhookError extends Error {}

const utf8 = new TextEncoder();

export async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares in time that depends only on the length, to not leak the signature. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signature headers for the generic adapter. */
export async function signGeneric(body: string, secret: string, nowMs = Date.now()): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return { "x-timestamp": timestamp, "x-signature": `sha256=${await hmac(secret, `${timestamp}.${body}`)}` };
}

const HEX_COLOR = /^[0-9a-f]{6}$/i;
const SOURCE_NAME = /^[a-z0-9_-]{1,32}$/;

function parseGenericGame(raw: unknown, league: string): GameSnapshot {
  const g = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const side = (key: "home" | "away") => {
    const s = (typeof g[key] === "object" && g[key] !== null ? g[key] : {}) as Record<string, unknown>;
    if (typeof s.team !== "string" || s.team.trim() === "") throw new WebhookError(`"${key}.team" must be a team name`);
    if (typeof s.score !== "number" || !Number.isInteger(s.score) || s.score < 0) {
      throw new WebhookError(`"${key}.score" must be a non-negative integer`);
    }
    if (league === NFL_LEAGUE && !findNflTeam(s.team)) throw new WebhookError(`"${s.team}" is not an NFL team`);
    const abbreviation = canonicalAbbreviation(league, s.team);
    const color = (k: "color" | "alternateColor") => {
      const v = s[k];
      if (v === undefined) return undefined;
      if (typeof v !== "string" || !HEX_COLOR.test(v)) throw new WebhookError(`"${key}.${k}" must be a hex colour like "0b2265"`);
      return v;
    };
    return {
      id: abbreviation,
      abbreviation,
      name: abbreviation,
      homeAway: key,
      score: s.score,
      color: color("color"),
      alternateColor: color("alternateColor"),
    };
  };
  if (g.state !== "pre" && g.state !== "in" && g.state !== "post") {
    throw new WebhookError('"state" must be "pre", "in" or "post"');
  }
  const at = g.at === undefined ? undefined : Date.parse(String(g.at));
  if (at !== undefined && Number.isNaN(at)) throw new WebhookError('"at" must be an ISO 8601 time');
  const teams = [side("home"), side("away")];
  if (teams[0]!.abbreviation.toLowerCase() === teams[1]!.abbreviation.toLowerCase()) {
    throw new WebhookError("home and away are the same team");
  }
  const state: GameState = g.state;
  const clock = parseClock(g.clock);
  return {
    id: "",
    name: `${teams[1]!.abbreviation} @ ${teams[0]!.abbreviation}`,
    sport: sportOf(league),
    state,
    detail: typeof g.detail === "string" && g.detail ? g.detail : state,
    ...(clock ? { clock } : {}),
    teams,
    asOf: at,
  };
}

function parseClock(raw: unknown): GameClock | undefined {
  if (raw === undefined || raw === null) return undefined;
  const c = (typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { period, seconds } = c;
  if (typeof period !== "number" || !Number.isInteger(period) || period < 1 || period > 20) {
    throw new WebhookError('"clock.period" must be a period number from 1');
  }
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 10_000) {
    throw new WebhookError('"clock.seconds" must be the seconds on the clock');
  }
  return { period, seconds };
}

/**
 * This project's own payload: the current state of one game, a list of them,
 * or `{ "games": [...], "source": "espn", "complete": true }`. It is what a
 * small relay in front of any provider, or the ESPN feeder, sends.
 *
 *   { "state": "in", "detail": "4:12 - 3rd", "at": "2026-11-22T18:41:07Z",
 *     "clock": { "period": 3, "seconds": 252 },
 *     "home": { "team": "NYG", "score": 7, "color": "0b2265" },
 *     "away": { "team": "DAL", "score": 0 } }
 *
 * `clock` is the game clock as the TV shows it, at the moment the update is
 * about: for a score, the clock of the play itself if the sender knows it.
 *
 * Signed with `X-Timestamp` (Unix seconds) and
 * `X-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`.
 */
export const genericAdapter: WebhookAdapter = {
  name: "generic",
  async verify(headers, body, secret, nowMs) {
    const timestamp = headers.get("x-timestamp") ?? "";
    const given = (headers.get("x-signature") ?? "").replace(/^sha256=/, "");
    if (!/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
    return sameText(given, await hmac(secret, `${timestamp}.${body}`));
  },
  parse(payload, league) {
    if (Array.isArray(payload)) return { games: payload.map((g) => parseGenericGame(g, league)) };
    const envelope = payload as { games?: unknown; source?: unknown; complete?: unknown } | null;
    if (!Array.isArray(envelope?.games)) return { games: [parseGenericGame(payload, league)] };
    const { source, complete } = envelope;
    if (source !== undefined && (typeof source !== "string" || !SOURCE_NAME.test(source))) {
      throw new WebhookError('"source" must be a short lowercase name like "espn"');
    }
    if (complete !== undefined && typeof complete !== "boolean") throw new WebhookError('"complete" must be true or false');
    return { games: envelope.games.map((g) => parseGenericGame(g, league)), source, complete };
  },
};

export const ADAPTERS: Record<string, WebhookAdapter> = { generic: genericAdapter };

export interface WebhookOptions {
  league: string;
  path: string;
  secret: string;
  adapter: WebhookAdapter;
  onEvents: (events: SportsEvent[]) => void;
  now?: () => number;
}

const reply = (status: number, body: Record<string, unknown>): Response => Response.json(body, { status });

/** Builds the request handler: verify, parse, update the tracker, answer fast. */
export function createWebhookHandler(tracker: Tracker, options: WebhookOptions): (req: Request) => Promise<Response> {
  const { league, path, secret, adapter, onEvents, now = Date.now } = options;
  return async (req) => {
    if (new URL(req.url).pathname !== path) return reply(404, { error: "not found" });
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const body = await req.text();
    if (body.length > MAX_BODY_BYTES) return reply(413, { error: "payload too large" });
    if (!(await adapter.verify(req.headers, body, secret, now()))) return reply(401, { error: "bad signature" });

    let update: WebhookUpdate;
    try {
      update = adapter.parse(JSON.parse(body), league);
    } catch (err) {
      const invalid = err instanceof WebhookError;
      return reply(invalid ? 422 : 400, { error: invalid ? err.message : "body is not JSON" });
    }
    const events = tracker.update(update.games, update.source ?? WEBHOOK_SOURCE, update.complete ?? false);
    // Effects are queued, not awaited: providers retry a slow answer.
    onEvents(events);
    return reply(200, { games: update.games.length, events: events.length });
  };
}
