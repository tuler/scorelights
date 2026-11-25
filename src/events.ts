import { type GameSnapshot, type Sport, type TeamSide } from "./espn.ts";

export type ScoreKind =
  | "touchdown"
  | "field_goal"
  | "extra_point"
  | "two_points"
  | "goal"
  | "run"
  | "basket"
  | "score";

/**
 * Something that happened in a game, said the same way for everyone. Who
 * cares about it is decided later, per viewer, by `forGame`.
 */
export type SportsEvent = (
  | { type: "game_start"; game: GameSnapshot }
  | { type: "score"; kind: ScoreKind; points: number; team: TeamSide; game: GameSnapshot }
  /** `winner` is absent for a draw. */
  | { type: "game_end"; winner?: TeamSide; game: GameSnapshot }
) & {
  /**
   * When it happened, on the game's timeline (ms since epoch; see
   * `Timeline`). Set by the tracker; absent where events are made directly.
   */
  playAt?: number;
};

/**
 * Name a score change from the size of the jump alone.
 * In football, 2 points is either a conversion or a safety, and 7 or 8 means
 * a touchdown and its conversion both landed between two polls.
 */
export function classifyScore(sport: Sport, delta: number): ScoreKind {
  switch (sport) {
    case "football":
      if (delta >= 6) return "touchdown";
      if (delta === 3) return "field_goal";
      if (delta === 2) return "two_points";
      if (delta === 1) return "extra_point";
      return "score";
    case "soccer":
    case "hockey":
      return "goal";
    case "baseball":
      return "run";
    case "basketball":
      return "basket";
    default:
      return "score";
  }
}

/**
 * Compare two polls of the same game and report what happened in between.
 *
 * The first poll (no `prev`) only sets the baseline, so starting the service
 * mid-game does not replay the existing score. Score decreases (an overturned
 * touchdown, a goal disallowed on review) are ignored and become the new
 * baseline.
 */
export function detectEvents(prev: GameSnapshot | undefined, next: GameSnapshot): SportsEvent[] {
  if (!prev || prev.id !== next.id) return [];
  const [home, away] = next.teams;
  if (!home || !away) return [];
  const events: SportsEvent[] = [];

  if (prev.state === "pre" && next.state === "in") events.push({ type: "game_start", game: next });

  for (const side of next.teams) {
    const before = prev.teams.find((t) => t.id === side.id);
    if (!before) continue;
    const points = side.score - before.score;
    if (points > 0) {
      events.push({ type: "score", kind: classifyScore(next.sport, points), points, team: side, game: next });
    }
  }

  if (prev.state !== "post" && next.state === "post") {
    const winner = home.score === away.score ? undefined : home.score > away.score ? home : away;
    events.push({ type: "game_end", winner, game: next });
  }

  return events;
}

/** Config keys for an event, most specific first. */
export function eventKeys(event: SportsEvent): string[] {
  switch (event.type) {
    case "game_start":
      return ["game_start"];
    case "game_end":
      return [event.winner ? "win" : "draw"];
    case "score":
      return [event.kind, "score"];
  }
}

/** Every key an effect can be configured under. */
export const EFFECT_KEYS: readonly string[] = [
  "touchdown",
  "field_goal",
  "extra_point",
  "two_points",
  "goal",
  "run",
  "basket",
  "score",
  "game_start",
  "win",
  "draw",
] satisfies readonly (ScoreKind | "game_start" | "win" | "draw")[];

export function describe(event: SportsEvent): string {
  const score = event.game.teams.map((t) => `${t.abbreviation} ${t.score}`).join(" - ");
  switch (event.type) {
    case "game_start":
      return `Game started: ${event.game.name}`;
    case "game_end":
      return `Final (${event.winner ? `${event.winner.abbreviation} win` : "draw"}): ${score}`;
    case "score":
      return `${event.team.abbreviation} ${event.kind.replace("_", " ")} (+${event.points}): ${score} [${event.game.detail}]`;
  }
}
