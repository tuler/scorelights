/** The Worker's `/api`, as the settings page sees it. Shapes mirror src/config.ts and src/worker/index.ts. */

export type Signal = "alternating" | "on_off_color";

export interface Effect {
  enabled: boolean;
  seconds: number;
  signal: Signal;
  colors?: string[];
}

/** Lasting choices. The game to follow is picked separately, per game. */
export interface Settings {
  group: string;
  delaySeconds: number;
  effectMode: "signal" | "pulse";
  effects: Record<string, Effect>;
}

export interface League {
  id: string;
  name: string;
  sport: "football" | "soccer" | "hockey" | "baseball" | "basketball" | "other";
  /** Logo image URLs for light and dark backgrounds, if the league has one. */
  logo?: { light: string; dark: string };
}

/** Games open to follow in one league: live now, and starting within a day. */
export interface LeagueCount {
  live: number;
  upcoming: number;
}

/** Per league id; `null` where the server could not read that league's scoreboard. */
export type LeagueCounts = Record<string, LeagueCount | null>;

export interface Me {
  bridge: string;
  connected: boolean;
  settings?: Settings;
  /** The game being followed, until its final. */
  game?: FollowedGame;
  leagues: League[];
  effectKeys: string[];
  defaults: Omit<Settings, "group">;
}

export interface Team {
  abbreviation: string;
  name: string;
  /** CSS colours for the swatches. */
  colors: string[];
  color?: string;
  alternateColor?: string;
}

export interface GameTeam extends Team {
  score?: number;
}

/** A game that can be followed: live, or starting within a day. */
export interface Game {
  /** The game's identity: its two teams, e.g. "dal-nyg". */
  key: string;
  /** League id, as in `Me.leagues`. */
  league: string;
  name: string;
  state: "pre" | "in";
  /** ESPN's short status: the clock while live, the kickoff time before. */
  detail: string;
  /** ISO time. */
  startsAt?: string;
  home: GameTeam;
  away: GameTeam;
}

/** The followed game as saved: no live score or status. */
export type FollowedGame = Pick<Game, "key" | "league" | "name" | "startsAt" | "home" | "away">;

export interface Group {
  name: string;
  kind: "room" | "zone";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** A game clock reading: period from 1 (overtime continues the count) and the seconds shown. */
export interface ClockReading {
  period: number;
  seconds: number;
  running: boolean;
}

/** The followed game's clock, from `GET /api/clock`. */
export interface ClockState {
  /** Server time of the readings (ms since epoch). */
  at: number;
  delaySeconds: number;
  /** The newest the feeds know. */
  live?: ClockReading;
  /** As the viewer's TV should show it, `delaySeconds` behind. */
  tv?: ClockReading;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  groups: () => call<Group[]>("GET", "/api/groups"),
  games: (league: string) => call<Game[]>("GET", `/api/games?league=${encodeURIComponent(league)}`),
  leagueCounts: () => call<LeagueCounts>("GET", "/api/leagues/counts"),
  save: (settings: Settings) => call<{ settings: Settings }>("PUT", "/api/settings", settings),
  follow: (game: Pick<Game, "league" | "key">) => call<{ game: FollowedGame }>("PUT", "/api/game", { league: game.league, key: game.key }),
  unfollow: () => call<{ ok: true }>("DELETE", "/api/game"),
  /** Without a team, the server uses the followed game's colours. */
  test: (effect: string, team?: Pick<Team, "abbreviation" | "color" | "alternateColor">) =>
    call<{ result: string }>("POST", "/api/test", { effect, team }),
  clock: () => call<ClockState>("GET", "/api/clock"),
  /** "My TV's clock shows this now": sets the TV delay. `ahead`: the TV runs ahead of every feed. */
  sync: (clock: Pick<ClockReading, "period" | "seconds">) =>
    call<{ delaySeconds: number; ahead: boolean }>("POST", "/api/sync", { clock }),
  setDelay: (delaySeconds: number) => call<{ delaySeconds: number }>("PUT", "/api/delay", { delaySeconds }),
  disconnect: () => call<{ ok: true }>("DELETE", "/api/me"),
  signOut: () => fetch("/auth/signout", { method: "POST" }),
};
