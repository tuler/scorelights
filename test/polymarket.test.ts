import { describe, expect, it } from "bun:test";
import { parseScoreboard } from "../src/espn.ts";
import { eventKeys } from "../src/events.ts";
import { scoreboardPayload } from "../src/sources/feed.ts";
import { matchWatched, parsePolymarket, polymarketPayload, POLYMARKET_SOURCE, type WatchedGame } from "../src/sources/polymarket.ts";
import { createWebhookHandler, genericAdapter, signGeneric } from "../src/sources/webhook.ts";
import { Tracker } from "../src/tracker.ts";
import { board } from "./fixture.ts";

// Real messages from the sports WebSocket, 2026-11-18.
const JAZZ_AT_CLIPPERS = {
  gameId: 20024134, sportradarGameId: "d3a39159-81df-4b52-a1c4-f341884f61d8", leagueAbbreviation: "nba",
  homeTeam: "LAC", awayTeam: "UTA", status: "inprogress", score: "100-93", elapsed: "09:16", period: "Q4", live: true, ended: false,
};
const STARS_AT_KNIGHTS = {
  gameId: 30025798, leagueAbbreviation: "nhl", homeTeam: "VEG", awayTeam: "DAL", status: "InProgress",
  score: "1-2", elapsed: "08:32", period: "P3", live: true, ended: false,
};
const TENNIS = {
  gameId: 6672301, leagueAbbreviation: "challenger", homeTeam: "Dhakshineswar Suresh", awayTeam: "Hiroki Moriya",
  status: "inprogress", score: "6-7(3-7), 3-3", period: "S2", live: true, ended: false,
};
const ESPORTS = {
  gameId: 1802920, leagueAbbreviation: "val", homeTeam: "Xipto Esports", awayTeam: "Sharper Esport",
  status: "running", score: "000-000|0-0|Bo5", period: "1/5", live: true, ended: false,
};

const watch = (league: string, home: string, away: string): WatchedGame => ({
  league, home, away, key: [home, away].map((t) => t.toLowerCase()).sort().join("-"), until: Number.MAX_SAFE_INTEGER,
});
const CLIPPERS = watch("basketball/nba", "LAC", "UTAH");
const KNIGHTS = watch("hockey/nhl", "VGK", "DAL");

describe("parsePolymarket", () => {
  it("reads a game, away score first", () => {
    expect(parsePolymarket(JAZZ_AT_CLIPPERS)).toEqual({
      league: "basketball/nba", home: "LAC", away: "UTA", awayScore: 100, homeScore: 93, state: "in", detail: "Q4 09:16",
      clock: { period: 4, seconds: 556 },
    });
  });

  it("reads the clock, overtime continuing the period count", () => {
    expect(parsePolymarket(STARS_AT_KNIGHTS)?.clock).toEqual({ period: 3, seconds: 512 });
    expect(parsePolymarket({ ...STARS_AT_KNIGHTS, period: "OT", elapsed: "01:24" })?.clock).toEqual({ period: 4, seconds: 84 });
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, period: "OT" })?.clock?.period).toBe(5);
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, period: "OT2" })?.clock?.period).toBe(6);
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, period: "End Q2", elapsed: "" })?.clock).toBeUndefined();
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, live: false, ended: true, period: "FT" })?.clock).toBeUndefined();
  });

  it("maps live and ended to the game state", () => {
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, live: false, ended: true, status: "complete" })?.state).toBe("post");
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, live: false, status: "Scheduled", score: "0-0" })?.state).toBe("pre");
  });

  it("skips leagues it does not cover, and scores it cannot read", () => {
    expect(parsePolymarket(TENNIS)).toBeUndefined();
    expect(parsePolymarket(ESPORTS)).toBeUndefined();
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, score: "" })).toBeUndefined();
    expect(parsePolymarket({ ...JAZZ_AT_CLIPPERS, homeTeam: undefined })).toBeUndefined();
    expect(parsePolymarket("ping")).toBeUndefined();
  });
});

describe("matchWatched", () => {
  const parsed = (m: object) => parsePolymarket(m)!;

  it("finds the followed game through the alias table", () => {
    expect(matchWatched(parsed(JAZZ_AT_CLIPPERS), [KNIGHTS, CLIPPERS])).toBe(CLIPPERS);
    expect(matchWatched(parsed(STARS_AT_KNIGHTS), [CLIPPERS, KNIGHTS])).toBe(KNIGHTS);
  });

  it("accepts an unknown abbreviation opposite an exact match, if it starts the same", () => {
    const pelicans = watch("basketball/nba", "NO", "LAL");
    expect(matchWatched(parsed({ ...JAZZ_AT_CLIPPERS, homeTeam: "NOR", awayTeam: "LAL" }), [pelicans])).toBe(pelicans);
    expect(matchWatched(parsed({ ...JAZZ_AT_CLIPPERS, homeTeam: "XYZ", awayTeam: "LAL" }), [pelicans])).toBeUndefined();
  });

  it("does not match across leagues or with home and away swapped", () => {
    expect(matchWatched(parsed(JAZZ_AT_CLIPPERS), [{ ...CLIPPERS, league: "basketball/wnba" }])).toBeUndefined();
    expect(matchWatched(parsed(JAZZ_AT_CLIPPERS), [watch("basketball/nba", "UTAH", "LAC")])).toBeUndefined();
  });
});

describe("Polymarket through the receiver", () => {
  it("fires the play ESPN has not seen yet, once", async () => {
    const tracker = new Tracker();
    const keys: string[] = [];
    const handle = createWebhookHandler(tracker, {
      league: "basketball/nba", path: "/webhook", secret: "s", adapter: genericAdapter,
      onEvents: (events) => void keys.push(...events.map((e) => eventKeys(e)[0]!)),
    });
    const send = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      await handle(new Request("https://games/webhook", { method: "POST", body, headers: await signGeneric(body, "s") }));
    };
    const espn = (home: number, away: number) =>
      scoreboardPayload(parseScoreboard(board([{ id: "1", state: "in", home: ["LAC", home], away: ["UTAH", away] }]), "basketball/nba"));

    await send(espn(93, 100));
    const three = parsePolymarket({ ...JAZZ_AT_CLIPPERS, score: "103-93" })!;
    const payload = polymarketPayload(three, CLIPPERS);
    expect(payload).toMatchObject({ source: POLYMARKET_SOURCE, games: [{ home: { team: "LAC", score: 93 }, away: { team: "UTAH", score: 103 } }] });
    await send(payload);
    await send(espn(93, 103)); // ESPN catches up 20 s later
    expect(keys).toHaveLength(1);
    expect(tracker.games()[0]?.teams.find((t) => t.abbreviation === "UTAH")?.score).toBe(103);
  });
});
