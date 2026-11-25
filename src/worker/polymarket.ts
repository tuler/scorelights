/**
 * The Polymarket relay: one object holding a WebSocket to Polymarket's sports
 * feed while anyone follows a game it covers. Each update for a followed game
 * whose score, state or clock changed is posted, signed, to that league's webhook
 * receiver, like the ESPN feeder's deliveries; the tracker merges the two, so
 * whichever is first fires the play.
 *
 * Following a game calls `watch`. The socket stays open until every watched
 * game has ended or lapsed. An alarm every half minute reconnects a dropped or
 * silent socket (a deploy or an eviction closes it) and closes it when nothing
 * is left to watch.
 */
import { DurableObject } from "cloudflare:workers";
import {
  matchWatched,
  parsePolymarket,
  polymarketPayload,
  POLYMARKET_LEAGUES,
  POLYMARKET_SPORTS_URL,
  type WatchedGame,
} from "../sources/polymarket.ts";
import { signGeneric } from "../sources/webhook.ts";
import type { Env } from "./env.ts";
import { WEBHOOK_PATH } from "./games.ts";

/** The one relay's Durable Object name. */
export const POLYMARKET_RELAY = "relay";
const CHECK_MS = 30_000;
/** Some sport is nearly always live somewhere, so this much silence means the socket is dead. */
const SILENT_MS = 120_000;
const COVERED = new Set(Object.values(POLYMARKET_LEAGUES));
const MAX_UNMATCHED = 20;

type Watched = Record<string, WatchedGame>;
const idOf = (g: Pick<WatchedGame, "league" | "key">) => `${g.league}|${g.key}`;

export class Polymarket extends DurableObject<Env> {
  private socket?: WebSocket;
  private watching?: Watched;
  /** Last forwarded "state score clock" per watched game, so repeats are not posted. */
  private readonly sent = new Map<string, string>();
  private connectedAt?: number;
  private lastMessageAt = 0;
  private forwarded = 0;
  private lastError?: string;
  /** Recent games in covered leagues that matched nothing, to grow the alias table from. */
  private readonly unmatched = new Map<string, string>();

  private async watched(): Promise<Watched> {
    this.watching ??= (await this.ctx.storage.get<Watched>("watched")) ?? {};
    return this.watching;
  }

  private async saveWatched(watched: Watched): Promise<void> {
    this.watching = watched;
    await this.ctx.storage.put("watched", watched);
  }

  /** Watches `game` until it ends or `game.until`, connecting if need be. */
  async watch(game: WatchedGame): Promise<void> {
    if (!COVERED.has(game.league)) return;
    const watched = await this.watched();
    const old = watched[idOf(game)];
    await this.saveWatched({ ...watched, [idOf(game)]: { ...game, until: Math.max(game.until, old?.until ?? 0) } });
    if (!this.socket) await this.openSocket();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
  }

  private async openSocket(): Promise<void> {
    this.closeSocket();
    try {
      const res = await fetch(POLYMARKET_SPORTS_URL, { headers: { upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`Polymarket answered HTTP ${res.status} without a WebSocket`);
      ws.accept();
      ws.addEventListener("message", (e) => this.onMessage(ws, e.data));
      ws.addEventListener("close", () => {
        if (this.socket === ws) this.socket = undefined;
      });
      ws.addEventListener("error", () => {
        if (this.socket === ws) this.socket = undefined;
      });
      this.socket = ws;
      this.connectedAt = this.lastMessageAt = Date.now();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error("Polymarket connect failed:", this.lastError);
    }
  }

  private closeSocket(): void {
    const ws = this.socket;
    this.socket = undefined;
    try {
      ws?.close(1000, "done");
    } catch {
      // Already closed.
    }
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    this.lastMessageAt = Date.now();
    if (typeof data !== "string") return;
    if (data === "ping") {
      ws.send("pong");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const game = parsePolymarket(item);
      if (!game) continue;
      // Kept in memory by `watch` and the alarm; never waits on storage here.
      const watched = matchWatched(game, Object.values(this.watching ?? {}));
      if (!watched) {
        if (Object.values(this.watching ?? {}).some((w) => w.league === game.league)) this.noteUnmatched(`${game.league} ${game.away} @ ${game.home}`);
        continue;
      }
      // Clock changes too: they are the samples the game's timeline reads the clock from.
      const seen = `${game.state} ${game.awayScore}-${game.homeScore} ${game.clock?.period}/${game.clock?.seconds}`;
      if (this.sent.get(watched.key) === seen) continue;
      this.sent.set(watched.key, seen);
      this.ctx.waitUntil(this.forward(polymarketPayload(game, watched), watched, game.state === "post"));
    }
  }

  private noteUnmatched(name: string): void {
    this.unmatched.delete(name);
    this.unmatched.set(name, new Date().toISOString());
    while (this.unmatched.size > MAX_UNMATCHED) this.unmatched.delete(this.unmatched.keys().next().value!);
  }

  private async forward(payload: ReturnType<typeof polymarketPayload>, watched: WatchedGame, ended: boolean): Promise<void> {
    try {
      const body = JSON.stringify(payload);
      const url = `https://games${WEBHOOK_PATH}?league=${encodeURIComponent(watched.league)}`;
      const res = await this.env.GAMES.getByName(watched.league).fetch(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await signGeneric(body, this.env.WEBHOOK_SECRET)) },
          body,
        }),
      );
      if (!res.ok) throw new Error(`Receiver answered HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      this.forwarded++;
      if (ended) {
        const { [idOf(watched)]: _, ...rest } = await this.watched();
        await this.saveWatched(rest);
        this.sent.delete(watched.key);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`Polymarket relay for ${watched.key} failed:`, this.lastError);
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const all = await this.watched();
    const current = Object.fromEntries(Object.entries(all).filter(([, g]) => g.until > now));
    if (Object.keys(current).length !== Object.keys(all).length) await this.saveWatched(current);
    if (Object.keys(current).length === 0) {
      this.closeSocket();
      this.sent.clear();
      return;
    }
    if (!this.socket || now - this.lastMessageAt > SILENT_MS) await this.openSocket();
    await this.ctx.storage.setAlarm(now + CHECK_MS);
  }

  async status() {
    const alarm = await this.ctx.storage.getAlarm();
    const iso = (t: number | undefined) => (t ? new Date(t).toISOString() : undefined);
    return {
      connected: Boolean(this.socket),
      connectedAt: iso(this.connectedAt),
      lastMessageAt: iso(this.lastMessageAt || undefined),
      forwarded: this.forwarded,
      lastError: this.lastError,
      watched: Object.values(await this.watched()).map((g) => ({ ...g, until: new Date(g.until).toISOString() })),
      unmatched: Object.fromEntries(this.unmatched),
      nextCheckAt: alarm === null ? undefined : new Date(alarm).toISOString(),
    };
  }
}
