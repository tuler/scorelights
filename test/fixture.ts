/** Hand-built in the shape of ESPN's scoreboard response, trimmed to the fields the parser reads. */
import type { FollowedGame } from "../src/follow.ts";

type State = "pre" | "in" | "post";

export interface FakeGame {
  id: string;
  state: State;
  /** [abbreviation, score] */
  home: [string, number];
  away: [string, number];
  /** Scheduled start, ms since epoch. */
  startsAt?: number;
  /** ESPN's `status.period` and `status.clock` (seconds). */
  clock?: [number, number];
}

const competitor = (homeAway: "home" | "away", [abbr, score]: [string, number]) => ({
  homeAway,
  score: String(score),
  team: { id: `id-${abbr}`, abbreviation: abbr, displayName: `Team ${abbr}`, color: "003c7f", alternateColor: "c9243f" },
});

/** A scoreboard with any number of games, plus one malformed entry the parser must skip. */
export function board(games: FakeGame[]) {
  return {
    events: [
      ...games.map((g) => ({
        id: g.id,
        shortName: `${g.away[0]} @ ${g.home[0]}`,
        ...(g.startsAt === undefined ? {} : { date: new Date(g.startsAt).toISOString().replace(/:00\.000Z$/, "Z") }),
        competitions: [
          {
            status: {
              type: { state: g.state, shortDetail: g.state === "in" ? "4:12 - 3rd" : g.state },
              ...(g.clock ? { period: g.clock[0], clock: g.clock[1] } : {}),
            },
            competitors: [competitor("home", g.home), competitor("away", g.away)],
          },
        ],
      })),
      { id: "broken", competitions: [{ competitors: [{ team: {} }] }] },
    ],
  };
}

/** Following `away` at `home`, without lapsing. */
export const following = (home: string, away: string, league = "nfl"): FollowedGame => ({
  league,
  key: [home, away].map((t) => t.toLowerCase()).sort().join("-"),
  name: `${away} @ ${home}`,
  home: { abbreviation: home, name: home },
  away: { abbreviation: away, name: away },
  until: Number.MAX_SAFE_INTEGER,
});

/** One game, NYG at home, as game "401". */
export function scoreboard(state: State, home: number, away: number, awayAbbr = "DAL") {
  return board([{ id: "401", state, home: ["NYG", home], away: [awayAbbr, away] }]);
}
