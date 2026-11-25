/**
 * What one viewer's lights should do about a batch of events. Pure, so the
 * local dispatcher and the Worker's User Durable Object decide the same way.
 */
import type { XY } from "./color.ts";
import { effectFor, type Effect, type Settings } from "./config.ts";
import { colorsFor, MAX_LAG_SECONDS } from "./effects.ts";
import { resolveLeague } from "./espn.ts";
import { describe, type SportsEvent } from "./events.ts";
import { forGame, type FollowedGame } from "./follow.ts";

export interface PlannedEffect {
  /** When to start, after the viewer's TV delay (ms since epoch). */
  dueAt: number;
  label: string;
  effect: Effect;
  colors: XY[];
}

/**
 * The followed game's events, as effects due `delaySeconds` after each play
 * (its `playAt` on the game's timeline, or `now` if unknown). Disabled ones
 * are left out.
 */
export function planEffects(
  events: SportsEvent[],
  settings: Settings,
  game: Pick<FollowedGame, "league" | "key">,
  now: number,
): PlannedEffect[] {
  const league = resolveLeague(game.league);
  return events.flatMap((event) => {
    // From the play, not from when it reached us: a late report is not flashed late.
    const dueAt = Math.round((event.playAt ?? now) + settings.delaySeconds * 1000);
    const mine = forGame(event, game.key);
    const effect = mine && effectFor(settings, mine.keys);
    if (!mine || !effect) return [];
    const colors = colorsFor(effect, league, mine.team ? [mine.team] : event.game.teams);
    return [{ dueAt, label: describe(event), effect, colors }];
  });
}

/** Whether an effect due at `dueAt` is now too late to be worth playing. */
export const isLate = (dueAt: number, now: number): boolean => now - dueAt > MAX_LAG_SECONDS * 1000;
