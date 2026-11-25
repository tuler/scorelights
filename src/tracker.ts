import { type GameClock, type GameSnapshot, type GameState, type TeamSide } from "./espn.ts";
import { detectEvents, type SportsEvent } from "./events.ts";
import { Timeline, type ClockReading, type TimelineState } from "./timeline.ts";

/**
 * How long a lower score from a different source is treated as stale rather
 * than as a correction. Feeds lag each other by up to a minute.
 */
export const STALE_SCORE_MS = 90_000;
/** A game nobody has reported on for this long is forgotten. */
export const IDLE_GAME_MS = 12 * 60 * 60 * 1000;

const RANK: Record<GameState, number> = { pre: 0, in: 1, post: 2 };
const teamKey = (t: TeamSide): string => t.abbreviation.toLowerCase();

/**
 * Identity of a game across sources. Feeds number games differently, so a
 * game is known by its two teams. (Two games between the same teams on one
 * scoreboard, such as a baseball doubleheader, would be read as one.)
 */
export const gameKey = (g: GameSnapshot): string => g.teams.map(teamKey).sort().join("-");

/** A tracker's memory as plain JSON, for a Durable Object to store between requests. */
export interface TrackerState {
  games: {
    game: GameSnapshot;
    scoredBy: [string, ScoredBy][];
    sources: [string, number][];
    seenAt: number;
    timeline?: TimelineState;
  }[];
}

/** Which source set a team's current score, when, and which other sources have reported it since. */
interface ScoredBy {
  source: string;
  at: number;
  confirmedBy?: string[];
  /** Set by the game's first sighting rather than a score change, so nothing to learn a lag from. */
  baseline?: true;
}

interface Tracked {
  game: GameSnapshot;
  scoredBy: Map<string, ScoredBy>;
  /** Sources that currently list this game, and the newest `asOf` each sent. */
  sources: Map<string, number>;
  seenAt: number;
  timeline: Timeline;
}

/**
 * Holds the last known state of every game and turns updates from any number
 * of sources into events. It follows every game it is told about, so one
 * tracker can serve everyone; who cares about an event is `forGame`'s call.
 *
 * Sources disagree for a while after every play, because some are faster
 * than others. The tracker merges them so each event fires once:
 *  - a score rises as soon as any source reports it;
 *  - a lower score is believed only from the source that reported the higher
 *    one (a real correction), or once it has outlasted `STALE_SCORE_MS`;
 *  - a game never moves backwards from live to scheduled or final to live;
 *  - an update older than one already applied from the same source is dropped.
 */
export class Tracker {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly now: () => number = Date.now) {}

  static restore(state: TrackerState | undefined, now?: () => number): Tracker {
    const tracker = new Tracker(now);
    for (const t of state?.games ?? []) {
      tracker.tracked.set(t.game.id, {
        game: t.game,
        scoredBy: new Map(t.scoredBy),
        sources: new Map(t.sources),
        seenAt: t.seenAt,
        timeline: new Timeline(t.game.sport, t.timeline),
      });
    }
    return tracker;
  }

  save(): TrackerState {
    return {
      games: [...this.tracked.values()].map((t) => ({
        game: t.game,
        scoredBy: [...t.scoredBy],
        sources: [...t.sources],
        seenAt: t.seenAt,
        timeline: t.timeline.save(),
      })),
    };
  }

  games(): GameSnapshot[] {
    return [...this.tracked.values()].map((t) => t.game);
  }

  /** The game `key`'s clock at timeline time `t`, if known. */
  clockAt(key: string, t: number): ClockReading | undefined {
    return this.tracked.get(key)?.timeline.clockAt(t);
  }

  /** When, on the game `key`'s timeline, its clock showed `clock` (see `Timeline.timeOf`). */
  timeOf(key: string, clock: GameClock, now = this.now()): number | undefined {
    return this.tracked.get(key)?.timeline.timeOf(clock, now);
  }

  /**
   * Forgets the game `key` if no source has reported on it for `maxAgeMs`, so
   * its next update sets a fresh baseline instead of replaying every score
   * since then. For when someone starts listening after the feed was idle.
   */
  forgetStale(key: string, maxAgeMs: number): void {
    const known = this.tracked.get(key);
    if (known && this.now() - known.seenAt > maxAgeMs) this.tracked.delete(key);
  }

  /**
   * Apply an update from `source`. Set `complete` when `games` is the
   * source's whole scoreboard, so games it no longer lists can be dropped.
   * The first sighting of a game only sets its baseline.
   */
  update(games: GameSnapshot[], source: string, complete = false): SportsEvent[] {
    const now = this.now();
    const events: SportsEvent[] = [];
    const listed = new Set<string>();

    for (const incoming of games) {
      const key = gameKey(incoming);
      listed.add(key);
      const asOf = incoming.asOf ?? now;
      const known = this.tracked.get(key);
      if (!known) {
        const timeline = new Timeline(incoming.sport);
        if (incoming.clock && incoming.state === "in") timeline.observe(source, incoming.clock, now);
        this.tracked.set(key, {
          game: { ...incoming, id: key },
          scoredBy: new Map(incoming.teams.map((t) => [teamKey(t), { source, at: now, baseline: true as const }])),
          sources: new Map([[source, asOf]]),
          seenAt: now,
          timeline,
        });
        continue;
      }
      if (asOf < (known.sources.get(source) ?? 0)) continue; // a late redelivery
      known.sources.set(source, asOf);
      known.seenAt = now;
      const playAt = known.timeline.playAt(source, now, incoming.clock);
      if (incoming.clock && incoming.state === "in") known.timeline.observe(source, incoming.clock, now);
      const merged = this.merge(known, incoming, source, now);
      events.push(...detectEvents(known.game, merged).map((e) => ({ ...e, playAt })));
      known.game = merged;
    }

    for (const [key, t] of this.tracked) {
      if (complete && !listed.has(key)) t.sources.delete(source);
      if (t.sources.size === 0 || now - t.seenAt > IDLE_GAME_MS) this.tracked.delete(key);
    }
    return events;
  }

  private merge(known: Tracked, incoming: GameSnapshot, source: string, now: number): GameSnapshot {
    const forward = RANK[incoming.state] >= RANK[known.game.state];
    const teams = known.game.teams.map((mine) => {
      const theirs = incoming.teams.find((t) => teamKey(t) === teamKey(mine));
      if (!theirs) return mine;
      const set = known.scoredBy.get(teamKey(mine));
      if (theirs.score === mine.score) {
        // A second source catching up on a score: how far behind it runs.
        if (set && !set.baseline && set.source !== source && !set.confirmedBy?.includes(source)) {
          set.confirmedBy = [...(set.confirmedBy ?? []), source];
          if (now - set.at < STALE_SCORE_MS) known.timeline.noteLag(source, set.source, now - set.at);
        }
        return mine;
      }
      const lower = theirs.score < mine.score;
      if (lower && set && set.source !== source && now - set.at < STALE_SCORE_MS) return mine;
      known.scoredBy.set(teamKey(mine), { source, at: now });
      return { ...mine, score: theirs.score };
    });
    return {
      ...known.game,
      state: forward ? incoming.state : known.game.state,
      detail: forward ? incoming.detail : known.game.detail,
      ...(forward && incoming.clock ? { clock: incoming.clock } : {}),
      teams,
    };
  }
}
