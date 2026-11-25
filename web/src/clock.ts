/** Game clocks as a TV shows them, for the sync card. Mirrors src/timeline.ts's readings. */
import type { ClockReading, League } from "./api.ts";

type Sport = League["sport"];

/** Soccer's clock counts up; every other clocked sport counts down. */
export const countsUp = (sport: Sport): boolean => sport === "soccer";

/** How far past its reading a running clock is carried on, as the server does. */
const MAX_CARRY_S = 60;

/** `reading`, `elapsedMs` later: a running clock moves one second per second. */
export function advance(reading: ClockReading, elapsedMs: number, sport: Sport): ClockReading {
  if (!reading.running) return reading;
  const by = Math.min(Math.max(0, elapsedMs / 1000), MAX_CARRY_S);
  const seconds = countsUp(sport) ? reading.seconds + by : Math.max(0, reading.seconds - by);
  return { ...reading, seconds };
}

/** "Q4", "P3", "OT", "2nd half". */
export function periodLabel(sport: Sport, period: number): string {
  const regular = sport === "hockey" ? 3 : sport === "basketball" || sport === "football" ? 4 : undefined;
  if (sport === "soccer") return period === 1 ? "1st half" : period === 2 ? "2nd half" : "Extra time";
  if (regular === undefined) return `Period ${period}`;
  if (period <= regular) return `${sport === "hockey" ? "P" : "Q"}${period}`;
  const ot = period - regular;
  return ot === 1 ? "OT" : `${ot}OT`;
}

/** The clock's face: "5:04", basketball's "49.1" in the last minute, soccer's "67:12". */
export function clockFace(sport: Sport, seconds: number): string {
  if (sport === "basketball" && seconds < 60) return seconds.toFixed(1);
  const whole = countsUp(sport) ? Math.floor(seconds) : Math.ceil(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export const clockText = (sport: Sport, r: Pick<ClockReading, "period" | "seconds">): string =>
  `${periodLabel(sport, r.period)} ${clockFace(sport, r.seconds)}`;

/**
 * A round clock value the TV will show in a little while: about `leadS`
 * seconds after `reading`, on a multiple of 5 seconds. Undefined too close to
 * the end of a period.
 */
export function targetAfter(reading: ClockReading, sport: Sport, leadS = 8): Pick<ClockReading, "period" | "seconds"> | undefined {
  if (countsUp(sport)) return { period: reading.period, seconds: Math.ceil((reading.seconds + leadS) / 5) * 5 };
  const seconds = Math.floor((reading.seconds - leadS) / 5) * 5;
  return seconds >= 10 ? { period: reading.period, seconds } : undefined;
}
