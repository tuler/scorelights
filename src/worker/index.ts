/**
 * Cloudflare Worker entry. Data flows the same way as locally:
 * score sources -> Games (one per league: tracker, who follows which game) ->
 * User (one per bridge: the followed game's effects, delay, Hue Remote API).
 *
 * Public
 *   GET  /                         the settings page: the React app in web/, served as static assets
 *   GET  /auth/start               sign in with Hue (OAuth); the bridge id becomes the user id
 *   GET  /auth/callback            Hue's redirect back; sets the session cookie
 *   POST /auth/signout
 *   POST /webhook/<league>         signed score updates (the ESPN feeder and the Polymarket relay post here too)
 *
 * Signed in (session cookie)
 *   GET  /api/me                   settings, the followed game, defaults and the league list
 *   GET  /api/groups               rooms and zones on the bridge
 *   GET  /api/games?league=nfl     games to pick from: live, and starting within a day
 *   GET  /api/leagues/counts       { <league>: { live, upcoming } | null } for every league, kept a minute
 *   PUT  /api/settings             save settings
 *   PUT  /api/game                 follow one game, { "league", "key" }, until its final
 *   DELETE /api/game               stop following
 *   GET  /api/clock                the followed game's clock as the TV should show it now
 *   POST /api/sync                 "my TV shows this now", { "clock": { "period", "seconds" } }: sets the TV delay
 *   PUT  /api/delay                set the TV delay alone, { "delaySeconds" }
 *   POST /api/test                 play one effect now, { "effect", "team"? }
 *   DELETE /api/me                 disconnect and forget this bridge
 *
 * Admin (Authorization: Bearer $ADMIN_TOKEN)
 *   GET|PUT|DELETE /users/<id>, PUT|DELETE /users/<id>/game, PUT /users/<id>/tokens,
 *   POST /users/<id>/test, GET /leagues/<league>, GET /polymarket
 */
import { DEFAULT_EFFECTS } from "../config.ts";
import { fetchScoreboard, LEAGUE_NAMES, leagueLogos, LEAGUES, resolveLeague, sportOf, type GameSnapshot, type TeamSide } from "../espn.ts";
import { EFFECT_KEYS } from "../events.ts";
import { followable, followGame, type FollowedGame, type FollowedTeam } from "../follow.ts";
import { HueRemoteAuth, type RemoteTokens } from "../hue-remote.ts";
import { findNflTeam, fullName, NFL_LEAGUE } from "../nfl.ts";
import { gameKey } from "../tracker.ts";
import type { Env } from "./env.ts";
import { WEBHOOK_PATH } from "./games.ts";
import { leagueCounter } from "./league-counts.ts";
import { POLYMARKET_RELAY } from "./polymarket.ts";
import {
  checkState,
  clearCookie,
  oauthState,
  sessionCookie,
  sessionUser,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "./session.ts";

export { Feeder } from "./feeder.ts";
export { Games } from "./games.ts";
export { Polymarket } from "./polymarket.ts";
export { User } from "./user.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function league(raw: string): string {
  try {
    return resolveLeague(decodeURIComponent(raw));
  } catch (err) {
    throw new HttpError(404, err instanceof Error ? err.message : "unknown league");
  }
}

function requireAdmin(req: Request, env: Env): void {
  const given = req.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || given !== `Bearer ${env.ADMIN_TOKEN}`) throw new HttpError(401, "admin token required");
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

/** Refuses a state-changing request from another site (the session cookie alone would let it through). */
function sameOrigin(req: Request, url: URL): void {
  if (req.method !== "GET" && req.headers.get("origin") !== url.origin) throw new HttpError(403, "cross-site request");
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

const hueAuth = (env: Env, tokens: { current?: RemoteTokens } = {}) =>
  new HueRemoteAuth({
    clientId: env.HUE_CLIENT_ID,
    clientSecret: env.HUE_CLIENT_SECRET,
    store: { load: async () => tokens.current, save: async (t) => void (tokens.current = t) },
  });

/** The bridge behind a fresh access token, read before any app key exists. */
async function bridgeId(accessToken: string): Promise<string> {
  const res = await fetch("https://api.meethue.com/route/api/config", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const config = (await res.json().catch(() => ({}))) as { bridgeid?: unknown };
  if (!res.ok || typeof config.bridgeid !== "string" || !/^[0-9A-Fa-f]{16}$/.test(config.bridgeid)) {
    throw new Error(`Could not read the bridge id (HTTP ${res.status}).`);
  }
  return config.bridgeid.toLowerCase();
}

/** Open games per league, shared by every request this isolate serves. */
const leagueCounts = leagueCounter();

const leagueList = () =>
  Object.entries(LEAGUES).map(([id, path]) => ({ id, name: LEAGUE_NAMES[id] ?? id, sport: sportOf(path), logo: leagueLogos(id) }));

/** A team as the page shows it: the NFL's lamp colours from the built-in table, ESPN's otherwise. */
function teamView(path: string, t: FollowedTeam & { score?: number }) {
  const nfl = path === NFL_LEAGUE ? findNflTeam(t.abbreviation) : undefined;
  const hex = nfl ? nfl.colors : [t.color, t.alternateColor].filter((c): c is string => Boolean(c));
  return {
    abbreviation: t.abbreviation,
    name: nfl ? fullName(nfl) : t.name,
    colors: hex.map((c) => `#${c}`),
    ...(t.color ? { color: t.color } : {}),
    ...(t.alternateColor ? { alternateColor: t.alternateColor } : {}),
    ...(t.score === undefined ? {} : { score: t.score }),
  };
}

const side = (g: GameSnapshot, homeAway: TeamSide["homeAway"]) => g.teams.find((t) => t.homeAway === homeAway) ?? g.teams[0]!;

/** The league's games that can be followed now, as the page shows them. */
async function gamesFor(leagueId: string) {
  const path = league(leagueId);
  return followable(await fetchScoreboard(path), Date.now()).map((g) => ({
    key: gameKey(g),
    league: leagueId,
    name: g.name,
    state: g.state,
    detail: g.detail,
    ...(g.startsAt === undefined ? {} : { startsAt: new Date(g.startsAt).toISOString() }),
    home: teamView(path, side(g, "home")),
    away: teamView(path, side(g, "away")),
  }));
}

/** The followed game as the page shows it. */
const followedView = (game: FollowedGame) => {
  const path = resolveLeague(game.league);
  return {
    key: game.key,
    league: game.league,
    name: game.name,
    ...(game.startsAt === undefined ? {} : { startsAt: new Date(game.startsAt).toISOString() }),
    home: teamView(path, game.home),
    away: teamView(path, game.away),
  };
};

/** Looks the game `{ league, key }` up on the scoreboard, so only a live or upcoming game can be followed. */
async function pickGame(b: Record<string, unknown>): Promise<FollowedGame> {
  if (typeof b.league !== "string" || typeof b.key !== "string") throw new HttpError(400, 'need { "league", "key" }');
  const leagueId = b.league;
  const now = Date.now();
  const game = followable(await fetchScoreboard(league(leagueId)), now).find((g) => gameKey(g) === b.key);
  if (!game) throw new HttpError(404, "That game is not live or coming up any more.");
  return followGame(leagueId, game, now);
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const hook = /^\/webhook\/(.+)$/.exec(path);
  if (hook) {
    const name = league(hook[1]!);
    const target = `https://games${WEBHOOK_PATH}?league=${encodeURIComponent(name)}`;
    return env.GAMES.getByName(name).fetch(new Request(target, req));
  }

  if (path === "/auth/start") {
    const { state, cookie } = await oauthState(env.SESSION_SECRET);
    return redirect(hueAuth(env).authorizeUrl(state), [cookie]);
  }

  if (path === "/auth/callback") {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    if (!code) return redirect(`/?error=${encodeURIComponent(url.searchParams.get("error") ?? "not authorized")}`);
    if (!(await checkState(req, state, env.SESSION_SECRET))) return redirect("/?error=sign-in+expired%2C+try+again");
    const tokens: { current?: RemoteTokens } = {};
    const signedIn = await hueAuth(env, tokens).exchangeCode(code);
    const id = await bridgeId(signedIn.accessToken);
    await env.USER.getByName(id).adopt(signedIn);
    return redirect("/", [await sessionCookie(id, env.SESSION_SECRET), clearCookie(STATE_COOKIE)]);
  }

  if (path === "/auth/signout" && req.method === "POST") {
    sameOrigin(req, url);
    return redirect("/", [clearCookie(SESSION_COOKIE)]);
  }

  if (path.startsWith("/api/")) {
    sameOrigin(req, url);
    const id = await sessionUser(req, env.SESSION_SECRET);
    if (!id) throw new HttpError(401, "not signed in");
    const user = env.USER.getByName(id);
    const action = `${req.method} ${path}`;
    switch (action) {
      case "GET /api/me": {
        const { game, ...rest } = await user.me();
        return json({
          bridge: id,
          ...rest,
          ...(game ? { game: followedView(game) } : {}),
          leagues: leagueList(),
          effectKeys: EFFECT_KEYS,
          defaults: { delaySeconds: 0, effectMode: "signal", effects: DEFAULT_EFFECTS },
        });
      }
      case "GET /api/groups":
        return json(await user.groups());
      case "GET /api/games":
        return json(await gamesFor(url.searchParams.get("league") ?? "nfl"));
      case "GET /api/leagues/counts":
        return json(await leagueCounts());
      case "PUT /api/settings":
        try {
          return json({ settings: await user.configure(id, await body(req)) });
        } catch (err) {
          throw new HttpError(422, err instanceof Error ? err.message : String(err));
        }
      case "PUT /api/game": {
        const game = await pickGame(await body(req));
        try {
          return json({ game: followedView(await user.follow(game)) });
        } catch (err) {
          throw new HttpError(422, err instanceof Error ? err.message : String(err));
        }
      }
      case "DELETE /api/game":
        await user.unfollow();
        return json({ ok: true });
      case "GET /api/clock":
        return json({ at: Date.now(), ...(await user.clock(Date.now())) });
      case "POST /api/sync": {
        // The tap's moment is when it reached us; the trip here is a fraction of a second.
        const tappedAt = Date.now();
        const b = await body(req);
        const clock = b.clock as { period?: unknown; seconds?: unknown } | undefined;
        const period = Number(clock?.period);
        const seconds = Number(clock?.seconds);
        if (!Number.isInteger(period) || period < 1 || !Number.isFinite(seconds) || seconds < 0) {
          throw new HttpError(400, 'need { "clock": { "period", "seconds" } }');
        }
        try {
          return json(await user.sync({ period, seconds }, tappedAt));
        } catch (err) {
          throw new HttpError(422, err instanceof Error ? err.message : String(err));
        }
      }
      case "PUT /api/delay":
        try {
          return json({ delaySeconds: await user.setDelay(Number((await body(req)).delaySeconds)) });
        } catch (err) {
          throw new HttpError(422, err instanceof Error ? err.message : String(err));
        }
      case "POST /api/test": {
        const b = await body(req);
        const team = (b.team ?? {}) as { abbreviation?: unknown; color?: unknown; alternateColor?: unknown };
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const abbreviation = str(team.abbreviation);
        return json({
          result: await user.test(
            String(b.effect ?? "touchdown"),
            abbreviation ? { abbreviation, color: str(team.color), alternateColor: str(team.alternateColor) } : undefined,
          ),
        });
      }
      case "DELETE /api/me": {
        await user.remove();
        const res = json({ ok: true });
        res.headers.append("set-cookie", clearCookie(SESSION_COOKIE));
        return res;
      }
    }
    return fail(404, "not found");
  }

  const admin = /^\/users\/([A-Za-z0-9_-]{1,64})(\/[a-z-]+)?$/.exec(path);
  if (admin) {
    requireAdmin(req, env);
    const id = admin[1]!;
    const stub = env.USER.getByName(id);
    switch (`${req.method} ${admin[2] ?? ""}`) {
      case "PUT ":
        return json({ settings: await stub.configure(id, await body(req)) });
      case "GET ":
        return json(await stub.status());
      case "DELETE ":
        await stub.remove();
        return json({ ok: true });
      case "PUT /game":
        return json({ game: await stub.follow(await pickGame(await body(req))) });
      case "DELETE /game":
        await stub.unfollow();
        return json({ ok: true });
      case "PUT /tokens": {
        const b = await body(req);
        if (typeof b.appKey !== "string" || typeof b.tokens !== "object") throw new HttpError(400, 'need { "tokens", "appKey" }');
        await stub.importTokens(b.tokens as RemoteTokens, b.appKey);
        return json({ ok: true });
      }
      case "POST /test": {
        const b = await body(req);
        const team = typeof b.team === "string" && b.team ? { abbreviation: b.team } : undefined;
        return json({ result: await stub.test(String(b.effect ?? "touchdown"), team) });
      }
    }
  }

  const leaguePath = /^\/leagues\/(.+)$/.exec(path);
  if (leaguePath && req.method === "GET") {
    requireAdmin(req, env);
    const name = league(leaguePath[1]!);
    const [games, feeder] = await Promise.all([env.GAMES.getByName(name).status(), env.FEEDER.getByName(name).status()]);
    return json({ league: name, ...games, feeder });
  }

  if (path === "/polymarket" && req.method === "GET") {
    requireAdmin(req, env);
    return json(await env.POLYMARKET.getByName(POLYMARKET_RELAY).status());
  }

  return fail(404, "not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      return fail(500, message);
    }
  },
} satisfies ExportedHandler<Env>;
