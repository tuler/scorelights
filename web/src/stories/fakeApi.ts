/**
 * A stand-in for the Worker's `/api`, so stories can show any state without a
 * server. Each story sets `parameters.api` to override routes; the rest
 * answer from the fixtures below.
 */
import type { ClockState, FollowedGame, Game, GameTeam, Group, LeagueCounts, Me, Settings } from "../api.ts";

/** A route's answer: a JSON body (status 200), `{ status, body }`, or "pending" for a request that never settles. */
export type FakeReply = unknown;
/** Keys are "METHOD /path", e.g. "GET /api/groups". Query strings are matched too when given. */
export type FakeRoutes = Record<string, FakeReply | ((url: URL, body: unknown) => FakeReply)>;

const effect = (enabled: boolean, seconds: number, signal: "alternating" | "on_off_color" = "on_off_color") => ({
  enabled,
  seconds,
  signal,
});

export const DEFAULT_EFFECTS: Settings["effects"] = {
  touchdown: effect(true, 10, "alternating"),
  goal: effect(true, 10, "alternating"),
  field_goal: effect(true, 5),
  run: effect(true, 5),
  two_points: effect(true, 3),
  extra_point: effect(false, 0),
  basket: effect(false, 0),
  score: effect(true, 5),
  game_start: effect(true, 5, "alternating"),
  win: effect(true, 10, "alternating"),
  draw: effect(true, 5, "alternating"),
};

/** ESPN's logo URLs, as `leagueLogos` in src/espn.ts builds them. */
const logo = (light: string, dark: string) => {
  const url = (img: string) => `https://a.espncdn.com/combiner/i?img=${img}&w=80&h=80&transparent=true`;
  return { light: url(light), dark: url(dark) };
};
const usLogo = (id: string) => logo(`/i/teamlogos/leagues/500/${id}.png`, `/i/teamlogos/leagues/500-dark/${id}.png`);
const soccerLogo = (n: number) => logo(`/i/leaguelogos/soccer/500/${n}.png`, `/i/leaguelogos/soccer/500-dark/${n}.png`);

const ncaa = "/redesign/assets/img/icons/NCAASports_Football.png";

/** The Worker's full list, in its order. */
const LEAGUES: Me["leagues"] = [
  { id: "nfl", name: "NFL", sport: "football", logo: usLogo("nfl") },
  { id: "ncaaf", name: "College football", sport: "football", logo: logo(ncaa, ncaa) },
  { id: "nba", name: "NBA", sport: "basketball", logo: usLogo("nba") },
  { id: "wnba", name: "WNBA", sport: "basketball", logo: usLogo("wnba") },
  { id: "nhl", name: "NHL", sport: "hockey", logo: usLogo("nhl") },
  { id: "mlb", name: "MLB", sport: "baseball", logo: usLogo("mlb") },
  { id: "mls", name: "MLS", sport: "soccer", logo: soccerLogo(19) },
  { id: "epl", name: "Premier League", sport: "soccer", logo: soccerLogo(23) },
  { id: "laliga", name: "LaLiga", sport: "soccer", logo: soccerLogo(15) },
  { id: "bundesliga", name: "Bundesliga", sport: "soccer", logo: soccerLogo(10) },
  { id: "seriea", name: "Serie A", sport: "soccer", logo: soccerLogo(12) },
  { id: "ligue1", name: "Ligue 1", sport: "soccer", logo: soccerLogo(9) },
  { id: "brasileirao", name: "Brasileirão", sport: "soccer", logo: soccerLogo(85) },
  { id: "ucl", name: "Champions League", sport: "soccer", logo: soccerLogo(2) },
];

export const SAVED: Settings = {
  group: "Living Room",
  delaySeconds: 20,
  effectMode: "signal",
  effects: DEFAULT_EFFECTS,
};

const team = (abbreviation: string, name: string, colors: string[], score?: number): GameTeam => ({
  abbreviation,
  name,
  colors: colors.map((c) => `#${c}`),
  color: colors[0],
  alternateColor: colors[1],
  ...(score === undefined ? {} : { score }),
});

/** Hours from now, as an ISO time, so "Today" and "Tomorrow" stay true whenever the story is opened. */
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

const key = (a: string, b: string) => [a, b].map((t) => t.toLowerCase()).sort().join("-");

const live = (league: string, away: GameTeam, home: GameTeam, detail: string): Game => ({
  key: key(away.abbreviation, home.abbreviation),
  league,
  name: `${away.abbreviation} @ ${home.abbreviation}`,
  state: "in",
  detail,
  startsAt: inHours(-1.5),
  home,
  away,
});

const upcoming = (league: string, away: GameTeam, home: GameTeam, hours: number): Game => ({
  key: key(away.abbreviation, home.abbreviation),
  league,
  name: `${away.abbreviation} @ ${home.abbreviation}`,
  state: "pre",
  detail: "Scheduled",
  startsAt: inHours(hours),
  home: { ...home, score: 0 },
  away: { ...away, score: 0 },
});

export const GAMES: Record<string, Game[]> = {
  nfl: [
    live("nfl", team("KC", "Kansas City Chiefs", ["E31837", "FFB81C"], 17), team("LAC", "Los Angeles Chargers", ["0080C6", "FFC20E"], 14), "8:41 - 3rd"),
    live("nfl", team("DAL", "Dallas Cowboys", ["003594", "FFFFFF"], 3), team("NYG", "New York Giants", ["0B2265", "A71930"], 10), "Halftime"),
    upcoming("nfl", team("SF", "San Francisco 49ers", ["AA0000", "B3995D"]), team("GB", "Green Bay Packers", ["00703C", "FFB612"]), 3),
    upcoming("nfl", team("BUF", "Buffalo Bills", ["00338D", "C60C30"]), team("PHI", "Philadelphia Eagles", ["004C54", "FFFFFF"]), 22),
  ],
  nba: [
    upcoming("nba", team("BOS", "Boston Celtics", ["007A33", "BA9653"]), team("LAL", "Los Angeles Lakers", ["552583", "FDB927"]), 8),
  ],
  epl: [
    live("epl", team("ARS", "Arsenal", ["E20520", "FFFFFF"], 1), team("LIV", "Liverpool", ["D11317", "F6EB61"], 1), "67'"),
    upcoming("epl", team("TOT", "Tottenham Hotspur", ["132257"]), team("MCI", "Manchester City", ["99C5EA", "FFFFFF"]), 5),
  ],
};

const bare = ({ score: _, ...t }: GameTeam): GameTeam => t;
const followed = ({ key, league, name, startsAt, home, away }: Game): FollowedGame => ({
  key,
  league,
  name,
  startsAt,
  home: bare(home),
  away: bare(away),
});

/** Following the Chiefs at the Chargers, live. */
export const FOLLOWING = followed(GAMES.nfl![0]!);

const me = (settings?: Settings, game?: FollowedGame): Me => ({
  bridge: "001788fffe4dbe1a",
  connected: true,
  settings,
  game,
  leagues: LEAGUES,
  effectKeys: Object.keys(DEFAULT_EFFECTS),
  defaults: { delaySeconds: 0, effectMode: "signal", effects: DEFAULT_EFFECTS },
});

export const ME_SAVED = me(SAVED, FOLLOWING);
export const ME_NOT_FOLLOWING = me(SAVED);
export const ME_NEW = me(undefined);

export const GROUPS: Group[] = [
  { name: "Living Room", kind: "room" },
  { name: "Kitchen", kind: "room" },
  { name: "Bedroom", kind: "room" },
  { name: "TV area", kind: "zone" },
];

/**
 * Open games per league, as `GET /api/leagues/counts` answers: from `GAMES`, so the picker and the
 * lists agree. Ligue 1 stands for a league whose scoreboard could not be read.
 */
export const LEAGUE_COUNTS: LeagueCounts = Object.fromEntries(
  LEAGUES.map((l) => {
    const games = GAMES[l.id] ?? [];
    const live = games.filter((g) => g.state === "in").length;
    return [l.id, l.id === "ligue1" ? null : { live, upcoming: games.length - live }];
  }),
);

/**
 * `GET /api/clock` for the followed Chiefs at Chargers game (8:41 in the 3rd), the TV `delaySeconds` behind.
 * A function, so `at` is the time of each request and the clock ticks in the story.
 */
export const clockReply =
  ({ running = true, delaySeconds = SAVED.delaySeconds, live = 8 * 60 + 41, period = 3 } = {}) =>
  (): ClockState => ({
    at: Date.now(),
    delaySeconds,
    live: { period, seconds: live, running },
    tv: { period, seconds: running ? live + delaySeconds : live, running },
  });

/** What a working Worker answers. */
export const DEFAULT_ROUTES: FakeRoutes = {
  "GET /api/me": ME_SAVED,
  "GET /api/groups": GROUPS,
  "GET /api/games": (url: URL) => GAMES[url.searchParams.get("league") ?? "nfl"] ?? [],
  "GET /api/leagues/counts": LEAGUE_COUNTS,
  "PUT /api/settings": (_url: URL, body: unknown) => ({ settings: body }),
  "PUT /api/game": (_url: URL, body: unknown) => {
    const { league, key } = body as { league: string; key: string };
    const game = GAMES[league]?.find((g) => g.key === key);
    return game ? { game: followed(game) } : { status: 404, body: { error: "That game is not live or coming up any more." } };
  },
  "DELETE /api/game": { ok: true },
  "POST /api/test": { result: 'Played "touchdown" on Living Room for 10s' },
  "GET /api/clock": clockReply(),
  "POST /api/sync": { delaySeconds: 23.4, ahead: false },
  "PUT /api/delay": (_url: URL, body: unknown) => ({ delaySeconds: (body as { delaySeconds: number }).delaySeconds }),
  "DELETE /api/me": { ok: true },
  "POST /auth/signout": { ok: true },
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `fetch` that answers `/api` and `/auth` from `routes`, after a short, realistic pause. */
export function fakeFetch(routes: FakeRoutes, delayMs = 250): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href);
    const method = (init?.method ?? "GET").toUpperCase();
    const route = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    let reply = typeof route === "function" ? route(url, body) : route;
    if (route === undefined) reply = { status: 404, body: { error: "not found" } };
    if (reply === "pending") return new Promise<Response>(() => {});
    await pause(delayMs);
    const explicit = typeof reply === "object" && reply !== null && "status" in reply && typeof reply.status === "number";
    const status = explicit ? (reply as { status: number }).status : 200;
    const json = explicit ? (reply as { body?: unknown }).body : reply;
    return Response.json(json ?? {}, { status });
  }) as typeof fetch;
}

/** Shorthand for a failing route. */
export const failWith = (status: number, error: string): FakeReply => ({ status, body: { error } });
