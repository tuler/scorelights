# Scorelights

Scorelights (one word, lowercase L; "Scorelights for Philips Hue") flashes Philips Hue lights on live sports events. A Bun + TypeScript CLI that learns scores from ESPN's scoreboard (polling) and/or pushed webhooks, infers events from score changes, and plays effects through the Hue Bridge's local API (CLIP v2). See `README.md` for user-facing setup and config.

## Commands

```sh
bun install
bun run typecheck      # tsc three times: Bun types (CLI), Workers types (src/worker and its imports), DOM types (web/)
bun test               # all tests; Hue client tests need `openssl`, skipped without it
bun start <command>    # discover | pair | remote-auth | groups | games | teams | test | emit | run (bridge commands take --remote)
bun run compile        # standalone binary at dist/scorelights
bun run worker:dev     # the Worker locally (needs .dev.vars); builds web/ first. worker:deploy publishes both (pushes to main do this automatically)
bun run web:dev        # the settings page with hot reload, proxying /api and /auth to worker:dev on :8787
bun run storybook      # every UI component and screen on :6006, against a fake /api (web/src/stories/fakeApi.ts)
```

Run `bun run typecheck` and `bun test` before committing. The CLI has no build step: Bun runs the TypeScript directly and loads `.env` itself. Only `web/` is built (Vite), and wrangler runs that build before `dev` and `deploy`.

## Architecture

Data flows one way: sources -> tracker -> events -> dispatcher -> bridge.

| File | Role |
| --- | --- |
| `src/sources/poll.ts` | Polls ESPN and hands the whole scoreboard to the tracker |
| `src/sources/webhook.ts` | Signed HTTP receiver; `WebhookAdapter` maps a provider payload to snapshots. Only the `generic` adapter exists |
| `src/tracker.ts` | Last known state of every game; merges sources so each play fires once |
| `src/events.ts` | `detectEvents` diffs two snapshots of a game; `eventKeys` maps an event to config keys |
| `src/follow.ts` | `FollowedGame`: the one game a viewer follows. `followable` lists the games that can be picked (live, or starting within a day); `forGame` decides whether an event is the followed game's |
| `src/runner.ts` | Local service: wires sources to the tracker; the dispatcher queues effects |
| `src/plan.ts` | `planEffects`: one viewer's effects for a batch of events (followed game, effect, colours, due at the play plus the delay) |
| `src/timeline.ts` | `Timeline`, one per game in the tracker: the game clock from sparse samples, how far each slower source lags, and when each play happened (`playAt`); `timeOf` answers "when did the clock show this", which syncing to a TV needs |
| `src/effects.ts` | Team colours and `play` (signal or pulse) |
| `src/sources/feed.ts` | The ESPN feeder: a scoreboard as a generic webhook payload; poll interval |
| `src/sources/polymarket.ts` | Polymarket's sports WebSocket: reads a message, matches it to a followed game (`TEAM_ALIASES`), makes the generic payload |
| `src/worker/` | Cloudflare Worker: `Games` (shared tracker + receiver + who follows which game, per league), `Feeder` (ESPN alarm, per league), `Polymarket` (one relay holding the WebSocket while games it covers are followed), `User` (settings, followed game, Hue tokens, delayed effect queue) |
| `src/worker/index.ts` | Routes: settings page, Hue sign-in, session `/api`, admin routes, webhook |
| `web/` | The settings page: React + Mantine, built by Vite to `dist/web` and served as Worker static assets. Game picker and room first; effects and flash mode live under "Advanced" |
| `brand/` | Logo, icons, colour and font tokens, icon licences and the credit line (`CREDITS.md`). The source for the logo and every icon |
| `web/src/components/` | One file per component, each with a `.stories.tsx`. Stories get a fake `/api` from `.storybook/preview.tsx`; a story overrides routes with `parameters.api` |
| `src/worker/session.ts` | Signed session and OAuth-state cookies |
| `src/hue.ts` | Bridge client over a `HueTransport`: pairing, rooms/zones, `signal` (bridge-run flash) and `pulse` (manual flash + restore) |
| `src/hue-local.ts` | LAN transport (Bun `tls`, self-signed bridge certificate) |
| `src/hue-remote.ts` | Hue Remote API: OAuth tokens (`HueRemoteAuth`, pluggable `TokenStore`) and the `/route` transport |
| `src/token-file.ts` | CLI's `TokenStore`: `.hue-tokens.json` |
| `src/espn.ts` | The only file that knows ESPN's response shape; defines `GameSnapshot` |
| `src/nfl.ts` | The 32 NFL teams, aliases and lamp colours |
| `src/config.ts` | `Settings` (one viewer's lasting choices) and `Config` (local service) parsing, default effects |
| `src/config-file.ts` | Reads `config.json` (Bun only) |
| `src/color.ts` | Hex to CIE xy conversion |
| `src/cli.ts` | Command-line entry point |

## Rules that are easy to break

- **Events come from score deltas, not play data.** A touchdown is "+6 or more in football". Do not assume a source can name the play.
- **The tracker owns deduplication.** Sources must not diff or dedupe themselves; they report what they see. The one exception is rate, not merging: the Polymarket relay posts a game only when its score, state or clock changed since its own last post, so repeats don't each become a request. It never compares with another source. The merge rules (stale lower scores, state never moving backwards, late redeliveries) live in `Tracker.merge` and are covered by `test/tracker.test.ts`.
- **Games are matched across sources by their two team abbreviations**, never by id. Anything producing a `GameSnapshot` must pass team names through `canonicalAbbreviation`. Polymarket names teams its own way (and its WebSocket disagrees with its own teams API), so the relay only forwards games someone follows, renamed to that game's ESPN abbreviations by `matchWatched`.
- **Flashes are timed from the play, not from when a score reached us.** The tracker stamps each event with `playAt` on the game's timeline: from the score's game clock where it can (Polymarket's clock on a score is the play's own clock), else the arrival less the source's lag, learned live from scores two sources both reported. A viewer's `delaySeconds` is how far their TV runs behind that timeline, set by tapping when the TV's clock shows a given time (`POST /api/sync`). The clock is only a guide during stoppages: basketball's free throws keep their arrival time, while hockey and football goals go to the moment the clock stopped. ESPN's lag starts at zero, so games only ESPN covers time flashes as they did before.
- **A game's first sighting only sets a baseline** and fires nothing, so starting mid-game does not replay the score.
- **Events are team-neutral and the tracker follows every game.** Game state is the same for everyone; only `forGame` decides whether an event belongs to the game someone follows (both teams' scores). Keep per-user choices (followed game, effects, delay) out of the tracker so one tracker can serve every user.
- **A viewer follows one game, picked per game.** There are no team or league preferences. Following ends with the game's final, or `FOLLOW_MS` after kickoff if no final is seen; `Settings` hold only what lasts between games (room, delay, effects). The local CLI does the same with `run <team>`.
- **Subscribing re-baselines a stale game.** `Games.subscribe` calls `Tracker.forgetStale`, so a game the feeder stopped polling (nobody followed it) does not replay every score since when someone starts following it.
- **NFL colours in `src/nfl.ts` are lamp colours, not brand colours** (black dropped, silver as white, some shades saturated). They were chosen without seeing real bulbs.
- **`createWebhookHandler` must stay a plain `Request -> Response` function** using only Web APIs (WebCrypto, not `node:crypto`); the Worker's `Games` object runs it.
- **Everything `src/worker` imports must be Worker-safe.** The second typecheck enforces it: it has no Bun or Node types. Bun-only code lives in `cli.ts`, `runner.ts`, `config-file.ts`, `hue-local.ts`, `token-file.ts` and `sources/poll.ts`.
- **The bridge is the account.** Sign-in reads the bridge id from `/route/api/config` (works with just the OAuth token) and uses it as the user id; there is no other identity. Mutating `/api` calls must come from the page's own origin.
- **Score sources feed the receiver; they don't touch the tracker.** In the Worker even ESPN polling arrives as a signed webhook delivery, with `source: "espn"` and `complete: true` (the whole board). The Polymarket relay posts `source: "polymarket"`, one game at a time. ESPN stays the base: it lists the games to pick, sets each game's starting score and covers every league; Polymarket only makes covered leagues faster.
- **`hue.ts` and `hue-remote.ts` must stay Worker-safe** (only `fetch` and Web globals). Bun and Node calls go in `hue-local.ts` or `token-file.ts`.
- **Remote refresh tokens are single use.** `HueRemoteAuth.refresh` shares one in-flight refresh between callers; a Worker version needs the same guarantee across requests (one Durable Object per user).
- **No Hue branding in the logo or graphics.** Hue's developer terms (8(a)(xi)) allow "for Philips Hue" and "works with Philips Hue" in text, never Hue's wordmark, gradient or bulb artwork in a logo. The logo, icons, colours and font live in `brand/` (see its README); `Logo.tsx` draws its lockups inline from `logoArt.ts` (shapes copied from `brand/logo`) so the TV can cycle through the sports' balls, `web/src/theme.ts` and `brand.css` carry its colours and the bundled Outfit font (the CSP allows no font hosts), and `web/public` holds copies of its web icons. The primary colour is the logo's orange: filled buttons are orange with dark text, and small orange text and focus rings use `--sl-accent-text`, since the bright orange is too faint on white.
- **The football, soccer ball and basketball in the mark are CC BY 3.0.** Their credit line in `Footer.tsx` must stay visible on the site, and go in the iOS app's acknowledgements.
- **The bridge certificate is self-signed for the bridge id.** Verification is off unless `HUE_CA_FILE` is set; keep that scoped to bridge requests.

## Verified against the real world

Phase one (the local service) has run end to end against live systems:

- **ESPN parsing** works on the live NFL scoreboard. ESPN's Akamai edge returns 403 to Bun's default User-Agent, so `fetchScoreboard` sends its own; keep it.
- **The Hue client** has flashed real lights through a real bridge in the default `"effectMode": "signal"`. A live Chargers score showed their blue.

Still unverified:

- **The Hue Remote API client** was written from Q42.HueApi and node-hue-api source (Hue's own docs need a developer login). `remote-auth`, `groups --remote` and `test --remote` work against the real service: the token endpoint takes basic auth, the local app key is accepted remotely, and signaling through `/route` flashed real lights with no delay noticeable next to the LAN. Unknowns: token refresh against the real service and rate limits.

- **The settings page** (sign in, pick room, save) has been used end to end on the deployed Worker, back when it picked teams. The game picker that replaced teams has run only in Storybook and against `wrangler dev` (follow, a final ending it, unfollow), not yet on the deployed Worker. Keep the main screen for ordinary fans: anything technical goes under "Advanced".
- **ESPN's default scoreboard is one US day for most leagues** and rolls over in the US morning; at 1am Eastern it still lists last night's finals. Single dates work with `?dates=YYYYMMDD`; date ranges answer 400 for the NBA.
- **The Worker** was deployed as `hue-live-sports` at `hue-live-sports.tuler.dev`, where what follows in this note was seen. It is now the Worker `scorelights` at `scorelights.app` (also `scorelights.tuler.workers.dev`), deployed 2026-11-17 with fresh Durable Objects; a full Hue sign-in and the user's own testing worked there on 2026-11-18. The TV delay setting is the weak spot that testing found: set wrong, flashes spoil the play or lag it, so setting it needs to get easier. ESPN answers its feeder from Cloudflare's IPs (with our User-Agent). Under `wrangler dev` the tracker caught a real final and the user queue played it on time. Hue sign-in through `/auth/callback` works, including the app key made by pressing the link button through the cloud, and `POST /users/<id>/test` flashed real lights from the cloud. Not yet seen: a live game's score flashing end to end in production, and token refresh there. Workers reject `fetch` called with the wrong `this` ("Illegal invocation"), which Bun allows: never call a stored `fetch` as a method.
- **Feed lag, measured 2026-11-18** against ESPN's play-by-play `wallclock` (the moment of the play): ESPN's scoreboard showed NBA baskets 7–43 s after the play (mostly 11–20) and NHL goals 37–83 s after, before our 10 s polling. Its play-by-play lags 25–65 s, too late to time flashes from. Polymarket's sports WebSocket had NBA baskets 3–7 s after the play; on one NHL goal it was 12 s behind ESPN. ESPN's CDN caches the scoreboard about 10 s; busting the cache gained nothing. A Worker (`wrangler dev`) can open Polymarket's socket; it sent no text `ping` in 12 s, despite its docs. Unverified: a Durable Object holding the socket for hours in production, NFL coverage, and team abbreviations beyond the NBA and NHL ones seen (`TEAM_ALIASES` is partly from Polymarket's teams API, which differs from its socket).
- **Kalshi's live data is off limits**: its Developer Agreement allows API use only for a member's own trading, and bans benchmarking. Polymarket's terms grant a personal licence and bar redistributing its features; ask Polymarket before promoting the integration widely.
- **No provider webhook adapter exists.** Write one from real sample payloads and headers, not from documentation summaries.
- **Clock sync (2026-11-25)** is unit-tested on real Polymarket clock messages (DAL @ DEN), and its card on Storybook, but not yet used on a live game or the deployed Worker. Polymarket sends a clock only with events (every 6–20 s in play, repeating the value while the clock is stopped); ESPN's changes every 10–18 s. Unknown: Polymarket's NFL clock, its overtime labels beyond "OT", and soccer.
- **NFL lamp colours** other than LAC's have not been reviewed on real bulbs.

## Direction

The end goal is ordinary fans, not developers. The current local service is phase one. The likely public shape is an iOS app as the setup screen for a cloud service (Cloudflare Workers) that receives score webhooks and calls Hue's Remote API. Keep the core (events, tracker, team table, effects) free of Node/Bun-only and local-network assumptions so it can move there.

Open questions: which licensed score feed to use, Hue Remote API quotas for per-user fan-out, and feed lag relative to TV.

## Workflow

- Work directly on `main`; no pull requests for now.
- **Pushing to `main` deploys production.** Cloudflare Workers Builds is connected to `tuler/scorelights`: each push runs `bun run typecheck && bun test`, then `bunx wrangler deploy` to scorelights.app. Only push what is ready to go live. `bun run worker:deploy` still works for a one-off deploy, but the next push replaces it. Runtime secrets live on the Worker, not in the build.
- Secrets live in `.env` (`HUE_APP_KEY`, `WEBHOOK_SECRET`); `.env` and `config.json` are gitignored. `.env` also holds `CF_BEACON_TOKEN`, the Cloudflare Web Analytics site token that `web/vite.config.ts` puts into production builds of the page (not a secret: it ships in the HTML).
