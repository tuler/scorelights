/**
 * The ESPN feeder: turns a polled scoreboard into a generic webhook payload,
 * so polling is just one more sender to the webhook receiver. The Worker's
 * Feeder Durable Object runs this on an alarm; it could equally run on any
 * other host that can reach ESPN and sign a request.
 */
import type { GameSnapshot, TeamSide } from "../espn.ts";

export const ESPN_SOURCE = "espn";

/** Seconds until the next poll: fast while any game is live, slow otherwise. */
export function nextPollSeconds(games: Iterable<GameSnapshot>, liveSeconds: number): number {
  const states = new Set([...games].map((g) => g.state));
  if (states.has("in")) return liveSeconds;
  if (states.has("pre")) return 60;
  return 300;
}

const HEX_COLOR = /^[0-9a-f]{6}$/i;

const team = (t: TeamSide) => ({
  team: t.abbreviation,
  score: t.score,
  // A malformed colour would get the whole delivery refused, so drop it instead.
  ...(t.color && HEX_COLOR.test(t.color) ? { color: t.color } : {}),
  ...(t.alternateColor && HEX_COLOR.test(t.alternateColor) ? { alternateColor: t.alternateColor } : {}),
});

/** The whole scoreboard as one generic payload (see `genericAdapter`). */
export function scoreboardPayload(games: GameSnapshot[], source = ESPN_SOURCE) {
  const playable = games.flatMap((g) => {
    const home = g.teams.find((t) => t.homeAway === "home");
    const away = g.teams.find((t) => t.homeAway === "away");
    if (!home || !away) return [];
    return [{ state: g.state, detail: g.detail, ...(g.clock ? { clock: g.clock } : {}), home: team(home), away: team(away) }];
  });
  return { source, complete: true, games: playable };
}
