/**
 * Client for ESPN's public scoreboard JSON.
 * The endpoint is undocumented and unsupported, so parsing is defensive:
 * anything unexpected is skipped rather than thrown.
 */

import { canonicalAbbreviation } from "./nfl.ts";

export type GameState = "pre" | "in" | "post";
export type Sport = "football" | "soccer" | "hockey" | "baseball" | "basketball" | "other";

export interface TeamSide {
  id: string;
  abbreviation: string;
  name: string;
  homeAway: "home" | "away";
  score: number;
  /** Hex without "#", as ESPN reports it. */
  color?: string;
  alternateColor?: string;
}

/**
 * A game clock reading: the period (1-based; overtime continues the count) and
 * the seconds on the clock, as a TV shows it. Soccer's clock counts up from
 * kickoff; every other clocked sport counts down to zero each period.
 */
export interface GameClock {
  period: number;
  seconds: number;
}

/** Whether this sport's clock counts up (soccer) rather than down. */
export const clockCountsUp = (sport: Sport): boolean => sport === "soccer";

export interface GameSnapshot {
  id: string;
  name: string;
  sport: Sport;
  state: GameState;
  /** Human-readable clock, e.g. "4:12 - 3rd". */
  detail: string;
  /** The game clock, when the source gives one (not in baseball). */
  clock?: GameClock;
  teams: TeamSide[];
  /** When the source observed this state (ms since epoch), if it says. */
  asOf?: number;
  /** Scheduled start (ms since epoch), if the source says. */
  startsAt?: number;
}

/** Short aliases for ESPN's "sport/league" path segments. */
export const LEAGUES: Record<string, string> = {
  nfl: "football/nfl",
  ncaaf: "football/college-football",
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  mls: "soccer/usa.1",
  epl: "soccer/eng.1",
  laliga: "soccer/esp.1",
  bundesliga: "soccer/ger.1",
  seriea: "soccer/ita.1",
  ligue1: "soccer/fra.1",
  brasileirao: "soccer/bra.1",
  ucl: "soccer/uefa.champions",
};

/** Display names for the aliases in `LEAGUES`. */
export const LEAGUE_NAMES: Record<string, string> = {
  nfl: "NFL",
  ncaaf: "College football",
  nba: "NBA",
  wnba: "WNBA",
  nhl: "NHL",
  mlb: "MLB",
  mls: "MLS",
  epl: "Premier League",
  laliga: "LaLiga",
  bundesliga: "Bundesliga",
  seriea: "Serie A",
  ligue1: "Ligue 1",
  brasileirao: "Brasileirão",
  ucl: "Champions League",
};

/**
 * ESPN's league logos for the aliases in `LEAGUES`: image paths for light and dark backgrounds, as the
 * scoreboard's `leagues[0].logos` lists them. College football has one generic icon for both.
 */
const LEAGUE_LOGOS: Record<string, { light: string; dark: string }> = {
  nfl: { light: "/i/teamlogos/leagues/500/nfl.png", dark: "/i/teamlogos/leagues/500-dark/nfl.png" },
  ncaaf: { light: "/redesign/assets/img/icons/NCAASports_Football.png", dark: "/redesign/assets/img/icons/NCAASports_Football.png" },
  nba: { light: "/i/teamlogos/leagues/500/nba.png", dark: "/i/teamlogos/leagues/500-dark/nba.png" },
  wnba: { light: "/i/teamlogos/leagues/500/wnba.png", dark: "/i/teamlogos/leagues/500-dark/wnba.png" },
  nhl: { light: "/i/teamlogos/leagues/500/nhl.png", dark: "/i/teamlogos/leagues/500-dark/nhl.png" },
  mlb: { light: "/i/teamlogos/leagues/500/mlb.png", dark: "/i/teamlogos/leagues/500-dark/mlb.png" },
  mls: { light: "/i/leaguelogos/soccer/500/19.png", dark: "/i/leaguelogos/soccer/500-dark/19.png" },
  epl: { light: "/i/leaguelogos/soccer/500/23.png", dark: "/i/leaguelogos/soccer/500-dark/23.png" },
  laliga: { light: "/i/leaguelogos/soccer/500/15.png", dark: "/i/leaguelogos/soccer/500-dark/15.png" },
  bundesliga: { light: "/i/leaguelogos/soccer/500/10.png", dark: "/i/leaguelogos/soccer/500-dark/10.png" },
  seriea: { light: "/i/leaguelogos/soccer/500/12.png", dark: "/i/leaguelogos/soccer/500-dark/12.png" },
  ligue1: { light: "/i/leaguelogos/soccer/500/9.png", dark: "/i/leaguelogos/soccer/500-dark/9.png" },
  brasileirao: { light: "/i/leaguelogos/soccer/500/85.png", dark: "/i/leaguelogos/soccer/500-dark/85.png" },
  ucl: { light: "/i/leaguelogos/soccer/500/2.png", dark: "/i/leaguelogos/soccer/500-dark/2.png" },
};

/** The CDN the logos come from; the settings page's Content-Security-Policy allows images from it. */
export const ESPN_IMAGE_ORIGIN = "https://a.espncdn.com";

/**
 * Logo URLs for a league alias, resized by ESPN's image combiner to `size` pixels square
 * (an 80px logo is ~4 KB; the originals are 500px and up to ~56 KB).
 */
export function leagueLogos(alias: string, size = 80): { light: string; dark: string } | undefined {
  const logos = LEAGUE_LOGOS[alias];
  if (!logos) return undefined;
  const url = (img: string) => `${ESPN_IMAGE_ORIGIN}/combiner/i?img=${img}&w=${size}&h=${size}&transparent=true`;
  return { light: url(logos.light), dark: url(logos.dark) };
}

/** Accepts an alias ("nfl") or a raw ESPN path ("soccer/eng.1"). */
export function resolveLeague(league: string): string {
  const key = league.trim().toLowerCase();
  const path = LEAGUES[key] ?? key;
  if (!/^[a-z-]+\/[a-z0-9.-]+$/.test(path)) {
    throw new Error(
      `Unknown league "${league}". Use one of ${Object.keys(LEAGUES).join(", ")} or an ESPN path like "soccer/eng.1".`,
    );
  }
  return path;
}

export function sportOf(leaguePath: string): Sport {
  const sport = leaguePath.split("/")[0];
  switch (sport) {
    case "football":
    case "soccer":
    case "hockey":
    case "baseball":
    case "basketball":
      return sport;
    default:
      return "other";
  }
}

export function scoreboardUrl(leaguePath: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/scoreboard`;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;

function parseScore(v: unknown): number {
  // Usually a string ("21"); some ESPN endpoints use { value: 21 }.
  const raw = obj(v)?.value ?? v;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseTeam(v: unknown, leaguePath: string): TeamSide | undefined {
  const c = obj(v);
  const team = obj(c?.team);
  const id = str(team?.id) ?? str(c?.id);
  const raw = str(team?.abbreviation);
  if (!c || !team || !id || !raw) return undefined;
  const abbreviation = canonicalAbbreviation(leaguePath, raw);
  return {
    id,
    abbreviation,
    name: str(team.displayName) ?? str(team.name) ?? abbreviation,
    homeAway: c.homeAway === "away" ? "away" : "home",
    score: parseScore(c.score),
    color: str(team.color),
    alternateColor: str(team.alternateColor),
  };
}

/** ESPN's `status.clock` (seconds, fractions in the last minute) and `status.period`. */
function clockOf(status: Json | undefined): { clock?: GameClock } {
  const period = status?.period;
  const seconds = status?.clock;
  if (typeof period !== "number" || !Number.isInteger(period) || period < 1) return {};
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return {};
  return { clock: { period, seconds } };
}

export function parseScoreboard(json: unknown, leaguePath: string): GameSnapshot[] {
  const sport = sportOf(leaguePath);
  const games: GameSnapshot[] = [];
  for (const e of arr(obj(json)?.events)) {
    const event = obj(e);
    const competition = obj(arr(event?.competitions)[0]);
    const id = str(event?.id);
    if (!event || !competition || !id) continue;
    const teams = arr(competition.competitors)
      .map((c) => parseTeam(c, leaguePath))
      .filter((t): t is TeamSide => t !== undefined);
    if (teams.length !== 2) continue;
    const status = obj(competition.status ?? event.status);
    const type = obj(status?.type);
    const state = type?.state === "in" || type?.state === "post" ? type.state : "pre";
    const startsAt = Date.parse(str(event.date) ?? str(competition.date) ?? "");
    games.push({
      id,
      name: str(event.shortName) ?? str(event.name) ?? teams.map((t) => t.abbreviation).join(" v "),
      sport,
      state,
      detail: str(type?.shortDetail) ?? str(type?.detail) ?? state,
      ...(state === "in" && sport !== "baseball" ? clockOf(status) : {}),
      teams,
      ...(Number.isNaN(startsAt) ? {} : { startsAt }),
    });
  }
  return games;
}

/**
 * ESPN's CDN (Akamai) answers 403 to Bun's default User-Agent ("Bun/x.y"),
 * so always send our own.
 */
export const USER_AGENT = "scorelights/0.1";

export async function fetchScoreboard(
  leaguePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GameSnapshot[]> {
  const res = await fetchImpl(scoreboardUrl(leaguePath), {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ESPN scoreboard returned HTTP ${res.status}`);
  return parseScoreboard(await res.json(), leaguePath);
}

export function isTeam(side: TeamSide, team: string): boolean {
  const q = team.trim().toLowerCase();
  return side.abbreviation.toLowerCase() === q || side.name.toLowerCase() === q;
}
