import { describe, expect, it } from "bun:test";
import { fetchScoreboard, leagueLogos, LEAGUES, parseScoreboard, resolveLeague, sportOf } from "../src/espn.ts";
import { board, scoreboard } from "./fixture.ts";

describe("espn", () => {
  it("sends its own User-Agent, since ESPN's CDN rejects Bun's default", async () => {
    let sent: Headers | undefined;
    const fake = (async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return Response.json(scoreboard("in", 14, 7));
    }) as unknown as typeof fetch;
    await fetchScoreboard("football/nfl", fake);
    expect(sent?.get("user-agent")).toMatch(/^scorelights\//);
  });

  it("resolves aliases and raw paths", () => {
    expect(resolveLeague("NFL")).toBe("football/nfl");
    expect(resolveLeague("soccer/eng.1")).toBe("soccer/eng.1");
    expect(() => resolveLeague("../etc")).toThrow(/Unknown league/);
    expect(sportOf("soccer/eng.1")).toBe("soccer");
  });

  it("parses games and skips malformed entries", () => {
    const games = parseScoreboard(scoreboard("in", 14, 7), "football/nfl");
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ id: "401", state: "in", sport: "football", detail: "4:12 - 3rd" });
    expect(games[0]?.teams.map((t) => [t.abbreviation, t.score])).toEqual([["NYG", 14], ["DAL", 7]]);
  });

  it("reads the game clock of a live game, but not baseball's or a final's", () => {
    const games = [
      { id: "1", state: "in" as const, home: ["NYG", 7] as [string, number], away: ["DAL", 3] as [string, number], clock: [3, 252] as [number, number] },
      { id: "2", state: "post" as const, home: ["KC", 7] as [string, number], away: ["BUF", 3] as [string, number], clock: [4, 0] as [number, number] },
    ];
    const [live, final] = parseScoreboard(board(games), "football/nfl");
    expect(live?.clock).toEqual({ period: 3, seconds: 252 });
    expect(final?.clock).toBeUndefined();
    expect(parseScoreboard(board(games), "baseball/mlb")[0]?.clock).toBeUndefined();
  });

  it("returns nothing for junk input", () => {
    expect(parseScoreboard(null, "football/nfl")).toEqual([]);
    expect(parseScoreboard({ events: "nope" }, "football/nfl")).toEqual([]);
  });

  it("reads the scheduled start", () => {
    const at = Date.UTC(2026, 10, 22, 18, 0);
    const [game] = parseScoreboard(board([{ id: "1", state: "pre", home: ["NYG", 0], away: ["DAL", 0], startsAt: at }]), "football/nfl");
    expect(game?.startsAt).toBe(at);
    expect(parseScoreboard(scoreboard("pre", 0, 0), "football/nfl")[0]?.startsAt).toBeUndefined();
  });
});

describe("leagueLogos", () => {
  it("has light and dark logos for every league alias", () => {
    for (const alias of Object.keys(LEAGUES)) {
      const logos = leagueLogos(alias);
      expect(logos, alias).toBeDefined();
      expect(logos!.light).toStartWith("https://a.espncdn.com/combiner/i?img=/");
      expect(logos!.dark).toStartWith("https://a.espncdn.com/combiner/i?img=/");
    }
  });

  it("resizes through ESPN's combiner and knows nothing of raw paths", () => {
    expect(leagueLogos("nfl", 40)?.light).toBe("https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/nfl.png&w=40&h=40&transparent=true");
    expect(leagueLogos("soccer/eng.1")).toBeUndefined();
  });
});
