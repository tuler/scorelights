/**
 * Polymarket's sports WebSocket as a score source. It pushes every live game
 * in every sport, a few seconds after each play; ESPN's scoreboard runs
 * 10-30 s behind it in basketball (measured 2026-11-18). No account needed.
 *
 * This module is pure and Worker-safe: it reads one message and decides which
 * followed game it is about. The Worker's Polymarket Durable Object holds the
 * connection and posts what it finds to the league's webhook receiver, signed,
 * like the ESPN feeder does.
 *
 * Polymarket names teams its own way (VEG for Vegas, UTA for Utah), and its
 * own teams API disagrees with its WebSocket (LAS, CAL). So a message is
 * matched to a game someone follows, whose ESPN abbreviations are known, and
 * is sent on with those. A team plays one game at a time, so one side that
 * matches exactly (and an other side that plausibly does) is enough.
 */
import { sportOf, type GameClock, type GameState } from "../espn.ts";

export const POLYMARKET_SOURCE = "polymarket";
/** `fetch` wants https; the server upgrades it. */
export const POLYMARKET_SPORTS_URL = "https://sports-api.polymarket.com/ws";

/** Polymarket league id -> ESPN league path. Its scores list the away team first in all of these. */
export const POLYMARKET_LEAGUES: Record<string, string> = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
};

/**
 * Polymarket abbreviations that differ from ESPN's, per ESPN league path. From
 * its WebSocket where seen (VEG, UTA), else from its teams API.
 */
export const TEAM_ALIASES: Record<string, Record<string, string>> = {
  "football/nfl": { LA: "LAR", WAS: "WSH" },
  "basketball/nba": { GSW: "GS", NOP: "NO", NYK: "NY", SAS: "SA", UTA: "UTAH", WAS: "WSH" },
  "basketball/wnba": { GSV: "GS", LAS: "LV", NYL: "NY" },
  "hockey/nhl": { CAL: "CGY", LAK: "LA", LAS: "VGK", MON: "MTL", VEG: "VGK" },
  "baseball/mlb": { CWS: "CHW", OAK: "ATH" },
};

/** One game update, as Polymarket sent it. */
export interface PolymarketGame {
  /** ESPN league path. */
  league: string;
  /** Polymarket's team abbreviations. */
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  state: GameState;
  /** Period and clock, e.g. "Q4 08:51". */
  detail: string;
  /**
   * The game clock. On a score it is the clock of the play itself, not of the
   * moment the message was sent (checked against ESPN's play-by-play).
   */
  clock?: GameClock;
}

/** A game someone follows, by ESPN's abbreviations. */
export interface WatchedGame {
  /** ESPN league path. */
  league: string;
  /** The game's `gameKey`. */
  key: string;
  home: string;
  away: string;
  /** Stop watching after this, ms since epoch. */
  until: number;
}

const SCORE = /^(\d+)-(\d+)$/;
const PERIOD = /^(?:Q|P|H)(\d)$|^(\d)H$|^OT(\d*)$/;
const MM_SS = /^(\d{1,3}):(\d{2})(?:\.\d+)?$/;
/** Regular periods before overtime, which continues the count as ESPN does. */
const REGULAR_PERIODS: Record<string, number> = { basketball: 4, football: 4, hockey: 3 };

/** "Q4" + "05:14" as a clock. Breaks ("End Q2", "HT") and finals have none. */
function parseClock(league: string, period: unknown, elapsed: unknown): GameClock | undefined {
  const p = PERIOD.exec(String(period ?? "").trim());
  const t = MM_SS.exec(String(elapsed ?? "").trim());
  if (!p || !t) return undefined;
  const regular = REGULAR_PERIODS[sportOf(league)];
  const numbered = p[1] ?? p[2];
  const n = numbered !== undefined ? Number(numbered) : regular !== undefined ? regular + Math.max(1, Number(p[3] || 1)) : undefined;
  if (!n) return undefined;
  return { period: n, seconds: Number(t[1]) * 60 + Number(t[2]) };
}

/** Reads one message. Anything else (other sports, tennis sets, esports maps, malformed) is undefined. */
export function parsePolymarket(raw: unknown): PolymarketGame | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const league = POLYMARKET_LEAGUES[String(m.leagueAbbreviation ?? "").toLowerCase()];
  if (!league || typeof m.homeTeam !== "string" || typeof m.awayTeam !== "string") return undefined;
  const score = SCORE.exec(String(m.score ?? "").trim());
  if (!score) return undefined;
  const state: GameState = m.ended === true ? "post" : m.live === true ? "in" : "pre";
  const detail = [m.period, m.elapsed].filter((v) => typeof v === "string" && v).join(" ") || String(m.status ?? state);
  const clock = state === "in" ? parseClock(league, m.period, m.elapsed) : undefined;
  return {
    league,
    home: m.homeTeam.trim().toUpperCase(),
    away: m.awayTeam.trim().toUpperCase(),
    awayScore: Number(score[1]),
    homeScore: Number(score[2]),
    state,
    detail,
    ...(clock ? { clock } : {}),
  };
}

/** ESPN's abbreviation for a Polymarket one, as far as the alias table knows. */
export const espnAbbreviation = (league: string, team: string): string => TEAM_ALIASES[league]?.[team] ?? team;

const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
/** Close enough to be the other side of a game whose first side matched: same first letter. */
const plausible = (a: string, b: string) => a[0]?.toUpperCase() === b[0]?.toUpperCase();

/** The watched game `game` is about, if any. */
export function matchWatched(game: PolymarketGame, watched: Iterable<WatchedGame>): WatchedGame | undefined {
  const home = espnAbbreviation(game.league, game.home);
  const away = espnAbbreviation(game.league, game.away);
  for (const w of watched) {
    if (w.league !== game.league) continue;
    const homeMatches = same(home, w.home);
    const awayMatches = same(away, w.away);
    if ((homeMatches && awayMatches) || (homeMatches && plausible(away, w.away)) || (awayMatches && plausible(home, w.home))) return w;
  }
  return undefined;
}

/** The generic webhook payload for `game`, named with the watched game's ESPN abbreviations. */
export function polymarketPayload(game: PolymarketGame, watched: WatchedGame) {
  return {
    source: POLYMARKET_SOURCE,
    games: [
      {
        state: game.state,
        detail: game.detail,
        ...(game.clock ? { clock: game.clock } : {}),
        home: { team: watched.home, score: game.homeScore },
        away: { team: watched.away, score: game.awayScore },
      },
    ],
  };
}
