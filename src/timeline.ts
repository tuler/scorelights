/**
 * One game's timeline: when things happened, as best the feeds can tell, and
 * what the game clock read at any moment. Team-neutral, like the tracker that
 * holds one per game.
 *
 * Feeds report late, each by its own amount. Times here are on the timeline
 * of the fastest feed (Polymarket, or any source without a learned lag): an
 * arrival from a slower source is moved back by how far that source runs
 * behind, which is measured live from scores both reported. A viewer's TV
 * delay is then one number on this timeline, set by matching the clock on
 * their TV (`timeOf`), so how late any one score arrived stops mattering.
 *
 * The clock is read from sparse samples (Polymarket sends one per event,
 * ESPN one per poll). While it runs it moves one second per second, so
 * readings between and just after samples are worked out from the last one.
 */
import { clockCountsUp, type GameClock, type Sport } from "./espn.ts";
import { ESPN_SOURCE } from "./sources/feed.ts";

/**
 * Sources whose lag behind the fastest feed is learned, and what it counts as
 * until measured (ms). Zero, so a game only ESPN reports (soccer, college)
 * times flashes from ESPN's arrivals as before. Sources not listed are the reference.
 */
export const DEFAULT_LAG_MS: Record<string, number> = { [ESPN_SOURCE]: 0 };
const MAX_LAG_MS = 120_000;
const LAG_SAMPLES = 15;
const MAX_SAMPLES = 80;
const KEEP_MS = 20 * 60_000;
/** A source whose last clock sample is older than this is not used for reading the clock. */
const FRESH_MS = 3 * 60_000;
/** How far past its last sample a running clock is carried on. Polymarket can be quiet this long in open play. */
const MAX_EXTRAPOLATE_MS = 90_000;
/**
 * Two samples further apart in time than on the clock by more than this
 * mean it stopped in between (feeds jitter by a second or two).
 */
const STOP_SLACK_S = 3;
/** The furthest back the clock may place a play from its arrival. */
const MAX_SHIFT_MS = MAX_LAG_MS;

export interface ClockSample extends GameClock {
  source: string;
  /** Arrival (ms since epoch). */
  at: number;
}

export interface ClockReading extends GameClock {
  /** Whether the clock was last seen running. */
  running: boolean;
}

export interface TimelineState {
  samples: ClockSample[];
  lags: Record<string, number[]>;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export class Timeline {
  private samples: ClockSample[];
  private readonly lags: Record<string, number[]>;
  /** +1 if the clock counts up, -1 if down. */
  private readonly dir: number;

  constructor(
    private readonly sport: Sport,
    state?: TimelineState,
  ) {
    this.samples = state?.samples.map((s) => ({ ...s })) ?? [];
    this.lags = Object.fromEntries(Object.entries(state?.lags ?? {}).map(([k, v]) => [k, [...v]]));
    this.dir = clockCountsUp(sport) ? 1 : -1;
  }

  save(): TimelineState {
    return { samples: this.samples.map((s) => ({ ...s })), lags: Object.fromEntries(Object.entries(this.lags).map(([k, v]) => [k, [...v]])) };
  }

  /** A clock reading `source` delivered at `at`. */
  observe(source: string, clock: GameClock, at: number): void {
    this.samples.push({ source, period: clock.period, seconds: clock.seconds, at });
    const keepFrom = at - KEEP_MS;
    this.samples = this.samples.filter((s) => s.at >= keepFrom).slice(-MAX_SAMPLES);
  }

  /**
   * `late` reported something `ms` after `early` did. Only sources with a
   * default lag are learned; the others are the reference.
   */
  noteLag(late: string, early: string, ms: number): void {
    const learn = (source: string, value: number) => {
      if (DEFAULT_LAG_MS[source] === undefined || Math.abs(value) > MAX_LAG_MS) return;
      this.lags[source] = [...(this.lags[source] ?? []), value].slice(-LAG_SAMPLES);
    };
    if (DEFAULT_LAG_MS[late] !== undefined && DEFAULT_LAG_MS[early] === undefined) learn(late, ms);
    else if (DEFAULT_LAG_MS[early] !== undefined && DEFAULT_LAG_MS[late] === undefined) learn(early, -ms);
  }

  /** How far `source` runs behind the fastest feed (ms). */
  lagOf(source: string): number {
    const learned = this.lags[source];
    if (learned?.length) return Math.max(0, median(learned));
    return DEFAULT_LAG_MS[source] ?? 0;
  }

  /** `at`, an arrival from `source`, moved onto the timeline. */
  toTime(source: string, at: number): number {
    return at - this.lagOf(source);
  }

  /**
   * When a play `source` reported at `at`, with the game clock `clock`,
   * happened on the timeline. Call it before `observe`-ing the same report.
   *
   * A score's clock places it better than its arrival does: if the clock was
   * running, the play happened when the clock showed that value, however late
   * the report came. If the clock had stopped there, hockey and football
   * stopped it for the score, so the play is when the stop was first seen;
   * anywhere else (free throws) the clock only says "during this stoppage",
   * and the arrival is the best there is.
   */
  playAt(source: string, at: number, clock?: GameClock): number {
    const arrived = this.toTime(source, at);
    if (!clock) return arrived;
    const reading = this.clockAt(arrived);
    if (!reading || reading.period !== clock.period) return arrived;
    if (!reading.running && reading.seconds === clock.seconds) {
      if (this.sport !== "hockey" && this.sport !== "football") return arrived;
      const stoppedAt = this.stoppedSince(clock, arrived);
      return stoppedAt === undefined ? arrived : Math.min(arrived, stoppedAt);
    }
    const shown = this.timeOf(clock, arrived);
    if (shown === undefined || arrived - shown > MAX_SHIFT_MS) return arrived;
    return Math.min(arrived, shown);
  }

  /** When the clock was first seen stopped at `clock`, if every reading since says so. */
  private stoppedSince(clock: GameClock, before: number): number | undefined {
    for (const group of [this.reference(before), this.samples]) {
      let first: number | undefined;
      for (const s of this.timed(group)) {
        if (s.time > before) break;
        if (s.period === clock.period && s.seconds === clock.seconds) first ??= s.time;
        else first = undefined;
      }
      if (first !== undefined) return first;
    }
    return undefined;
  }

  /** Samples as timeline times, oldest first. */
  private timed(samples: ClockSample[]): (ClockSample & { time: number })[] {
    return samples.map((s) => ({ ...s, time: this.toTime(s.source, s.at) })).sort((a, b) => a.time - b.time);
  }

  /** The samples to read the clock from: the fastest source with a fresh sample by `t`, alone. */
  private reference(t: number): ClockSample[] {
    const fresh = this.samples.filter((s) => s.at <= t + this.lagOf(s.source) && t - this.toTime(s.source, s.at) < FRESH_MS);
    if (fresh.length === 0) return this.samples;
    const best = fresh.reduce((a, b) => (this.lagOf(b.source) < this.lagOf(a.source) ? b : a)).source;
    return this.samples.filter((s) => s.source === best);
  }

  /** The game clock at timeline time `t`, if the samples cover it. */
  clockAt(t: number): ClockReading | undefined {
    const samples = this.timed(this.reference(t));
    let i = -1;
    for (let k = 0; k < samples.length; k++) if (samples[k]!.time <= t) i = k;
    const s0 = samples[i];
    if (!s0) return undefined;
    const next = samples[i + 1];
    const prev = samples[i - 1];
    const dt = (t - s0.time) / 1000;
    const ahead = (from: number, by: number) => from + this.dir * by;
    if (next && next.period === s0.period) {
      // Running if it moved by the next sample; never past where it was then.
      if (next.seconds === s0.seconds) return { period: s0.period, seconds: s0.seconds, running: false };
      const moved = ahead(s0.seconds, dt);
      const seconds = this.dir < 0 ? Math.max(next.seconds, moved) : Math.min(next.seconds, moved);
      return { period: s0.period, seconds: Math.max(0, seconds), running: true };
    }
    // The newest sample, or the last of its period: running if it ran into it
    // without stopping on the way (which a stop at s0, for a foul or a goal, would look like).
    // After a known stop (Polymarket repeats the stopped value while it lasts), s0 is the restart.
    const moved = prev && prev.period === s0.period ? this.dir * (s0.seconds - prev.seconds) : 0;
    const before = samples[i - 2];
    const restarted = before !== undefined && before.period === prev?.period && before.seconds === prev.seconds;
    const wasRunning = moved > 0 && s0.seconds > 0 && (restarted || (s0.time - prev!.time) / 1000 - moved <= STOP_SLACK_S);
    if (!wasRunning) return { period: s0.period, seconds: s0.seconds, running: false };
    const capped = Math.min(dt, MAX_EXTRAPOLATE_MS / 1000);
    const seconds = Math.max(0, ahead(s0.seconds, capped));
    return { period: s0.period, seconds, running: seconds > 0 && dt < MAX_EXTRAPOLATE_MS / 1000 };
  }

  /**
   * When, on the timeline, the clock showed `clock`: the moment it ran into
   * that value. Undefined if the samples do not reach it, or that period is
   * not in them. Past the newest sample, a running clock is carried on, so
   * the answer can be in the future.
   */
  timeOf(clock: GameClock, now: number): number | undefined {
    const samples = this.timed(this.reference(now)).filter((s) => s.period === clock.period);
    if (samples.length === 0) return undefined;
    // `reached`: the clock is at or past `clock.seconds` by this sample.
    const reached = (s: ClockSample) => this.dir * (s.seconds - clock.seconds) >= 0;
    const j = samples.findIndex(reached);
    if (j === 0) return samples[0]!.seconds === clock.seconds ? samples[0]!.time : undefined;
    if (j > 0) {
      // Running into the first sample at or past it (a stop, if any, came at an earlier event).
      const s = samples[j]!;
      return Math.max(samples[j - 1]!.time, s.time - Math.abs(s.seconds - clock.seconds) * 1000);
    }
    const last = samples[samples.length - 1]!;
    const reading = this.clockAt(last.time + 1);
    if (!reading?.running) return undefined;
    return last.time + Math.abs(last.seconds - clock.seconds) * 1000;
  }
}
