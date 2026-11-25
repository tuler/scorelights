/**
 * The shared game state for one league. Every score source, the ESPN feeder
 * included, posts to its webhook receiver; the tracker merges them so each
 * play fires once. Each user follows one game, and gets that game's events
 * until its final. Nothing else here depends on any user's choices.
 */
import { DurableObject } from "cloudflare:workers";
import type { GameClock } from "../espn.ts";
import type { SportsEvent } from "../events.ts";
import { createWebhookHandler, genericAdapter } from "../sources/webhook.ts";
import { gameKey, Tracker, type TrackerState } from "../tracker.ts";
import type { Env } from "./env.ts";

export const WEBHOOK_PATH = "/webhook";
/**
 * A game the feed last reported on longer ago than this is stale: the feeder
 * polls a listed game at least every minute, so it was idle meanwhile.
 */
const STALE_GAME_MS = 10 * 60_000;

/** Who follows which game: the game's key, and when following lapses. */
type Subscribers = Record<string, { key: string; until: number }>;

export class Games extends DurableObject<Env> {
  private tracker?: Tracker;

  private async load(): Promise<Tracker> {
    this.tracker ??= Tracker.restore(await this.ctx.storage.get<TrackerState>("tracker"));
    return this.tracker;
  }

  /** Current subscribers, lapsed ones dropped. */
  private async subscribers(): Promise<Subscribers> {
    const all = (await this.ctx.storage.get<Subscribers>("subscribers")) ?? {};
    const now = Date.now();
    const current = Object.fromEntries(Object.entries(all).filter(([, s]) => s.until > now));
    if (Object.keys(current).length !== Object.keys(all).length) await this.ctx.storage.put("subscribers", current);
    return current;
  }

  /** The webhook receiver. The request URL carries the league as `?league=`. */
  override async fetch(req: Request): Promise<Response> {
    const league = new URL(req.url).searchParams.get("league") ?? "";
    const tracker = await this.load();
    const events: SportsEvent[] = [];
    const handle = createWebhookHandler(tracker, {
      league,
      path: WEBHOOK_PATH,
      secret: this.env.WEBHOOK_SECRET,
      adapter: genericAdapter,
      onEvents: (e) => void events.push(...e),
    });
    const res = await handle(req);
    if (res.ok) await this.ctx.storage.put("tracker", tracker.save());
    if (events.length) await this.fanOut(events);
    return res;
  }

  /**
   * Hands each subscriber its game's events, then lets go of games that
   * ended. Each user only queues them, so this is quick; a user that fails is
   * logged and does not hold up the rest.
   */
  private async fanOut(events: SportsEvent[]): Promise<void> {
    const subs = await this.subscribers();
    const deliveries = Object.entries(subs).flatMap(([id, { key }]) => {
      const theirs = events.filter((e) => gameKey(e.game) === key);
      return theirs.length ? [{ id, events: theirs }] : [];
    });
    const results = await Promise.allSettled(deliveries.map((d) => this.env.USER.getByName(d.id).deliver(d.events)));
    results.forEach((r, i) => {
      if (r.status === "rejected") console.error(`Delivering to user ${deliveries[i]!.id} failed:`, r.reason);
    });

    const ended = new Set(events.filter((e) => e.type === "game_end").map((e) => gameKey(e.game)));
    if (ended.size === 0) return;
    const after = await this.subscribers();
    await this.ctx.storage.put("subscribers", Object.fromEntries(Object.entries(after).filter(([, s]) => !ended.has(s.key))));
  }

  /** `userId` now follows the game `key` (and no other) until its final or `until`. */
  async subscribe(userId: string, key: string, until: number): Promise<void> {
    // After the feed sat idle, the tracker's memory of this game is old: start
    // it afresh rather than flash every score since.
    const tracker = await this.load();
    tracker.forgetStale(key, STALE_GAME_MS);
    await this.ctx.storage.put("tracker", tracker.save());
    await this.ctx.storage.put("subscribers", { ...(await this.subscribers()), [userId]: { key, until } });
  }

  async unsubscribe(userId: string): Promise<void> {
    const { [userId]: _, ...rest } = await this.subscribers();
    await this.ctx.storage.put("subscribers", rest);
  }

  /** The game `key`'s clock at timeline time `t`. */
  async clockAt(key: string, t: number) {
    return (await this.load()).clockAt(key, t);
  }

  /** When, on the game `key`'s timeline, its clock showed `clock`. */
  async timeOf(key: string, clock: GameClock): Promise<number | undefined> {
    return (await this.load()).timeOf(key, clock);
  }

  async hasSubscribers(): Promise<boolean> {
    return Object.keys(await this.subscribers()).length > 0;
  }

  async status() {
    const tracker = await this.load();
    return {
      subscribers: Object.entries(await this.subscribers()).map(([id, s]) => ({
        id,
        game: s.key,
        until: new Date(s.until).toISOString(),
      })),
      games: tracker.games().map((g) => ({
        key: g.id,
        name: g.name,
        state: g.state,
        detail: g.detail,
        score: g.teams.map((t) => `${t.abbreviation} ${t.score}`).join(" - "),
      })),
    };
  }
}
