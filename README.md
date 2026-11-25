# Scorelights

Scorelights for Philips Hue flashes your lights on live sports: touchdowns, field goals, goals, runs, kickoff and the final whistle.

You pick the game you're watching, live or starting within a day. Every score in it flashes in the scoring team's colours, both teams' included, and following ends with the final.

It learns the score by polling ESPN's public scoreboard, by receiving webhooks, or both. It works out what happened from the change in score and plays an effect in the scoring team's colours through the Hue Bridge's local API.

## Setup

Needs [Bun](https://bun.sh) 1.2+ and a Hue Bridge on the same network.

```sh
bun install
cp .env.example .env
cp config.example.json config.json

bun start discover        # find the bridge, put its IP in .env
bun start pair            # press the bridge's link button first, then put the key in .env
bun start groups          # room and zone names for config.json
bun start games           # check that the scoreboard is being read
bun start test touchdown KC       # preview an effect in a team's colours
bun start run KC          # follow KC's live or next game; add --dry-run to log without touching the lights
```

Bun runs the TypeScript directly and loads `.env` itself, so there is no build step. `bun run compile` produces a standalone binary at `dist/scorelights` for a machine without Bun.

### Through the Hue Remote API

The bridge can also be reached through Hue's cloud instead of the LAN, which is how a hosted version would talk to it. Add `--remote` to `pair`, `groups`, `test` or `run`.

1. Create a Remote Hue API app at [developers.meethue.com](https://developers.meethue.com). Any callback URL works for the CLI; the page it lands on does not need to load.
2. Put the app's client id and secret in `.env` as `HUE_CLIENT_ID` and `HUE_CLIENT_SECRET`.
3. Run `bun start remote-auth`, open the link it prints, allow access, and paste back the address the browser ends up on. Tokens are saved to `.hue-tokens.json` (gitignored) and refreshed automatically.
4. Run `bun start groups --remote`. The app key from `pair` should work here too. If it is refused, run `bun start pair --remote`, which presses the link button through the cloud and creates a new key.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `league` | | Where `run <team>` looks for the game: `nfl`, `ncaaf`, `nba`, `wnba`, `nhl`, `mlb`, `mls`, `epl`, `laliga`, `bundesliga`, `seriea`, `ligue1`, `brasileirao`, `ucl`, or any ESPN path such as `soccer/ned.1` |
| `group` | | Hue room or zone to flash |
| `poll` | `true` | Poll ESPN's scoreboard |
| `pollSeconds` | `10` | Poll interval while a game is live (minimum 5) |
| `webhook` | off | Receive pushed updates: `{ "host", "port", "path", "adapter" }`, see [Score sources](#score-sources) |
| `delaySeconds` | `0` | Hold effects back this long after each play, to match a delayed TV stream |
| `effectMode` | `signal` | `signal` lets the bridge run the flash and restore the lights. `pulse` flashes by hand, for lights that ignore signaling |
| `effects` | see below | Per-event overrides |

Each effect is `{ "enabled", "seconds", "signal", "colors" }`. `signal` is `alternating` (two colours) or `on_off_color` (one). `colors` is an optional list of hex colours that replaces the team's own.

Effect keys are the kind of score, falling back to `score`: `touchdown`, `field_goal`, `two_points`, `extra_point`, `goal`, `run`, `basket`. Game-level keys are `game_start`, `win` (the winner's colours) and `draw`; a kickoff or a draw has no scoring team, so it alternates both teams' main colours. Defaults are in [`src/config.ts`](src/config.ts). Off by default: extra points, which follow nearly every touchdown, and baskets, which would flash constantly.

Effects play one at a time. If they queue up, one that would start more than 45 seconds late is skipped.

## Following a game

`run <team>` follows that team's live game, or else its next one starting within a day, on the `league` scoreboard. For the NFL any of the 32 teams works by abbreviation, nickname or full name (`NYG`, `Giants`); other leagues take ESPN's abbreviation or full name. It flashes for that game only and exits once the final has played (or 12 hours after kickoff, if no final is ever seen).

## Score sources

Two sources feed one tracker, and you can run either or both.

- **Poller** (`poll`, on by default): asks ESPN's scoreboard every `pollSeconds` while a game is live, and less often otherwise.
- **Webhook receiver** (`webhook`): an HTTP endpoint that takes pushed score updates. It listens on `127.0.0.1:8787/webhook` by default and needs `WEBHOOK_SECRET` in `.env`.

Running both is the recommended setup once you have a push feed: the webhook brings the score sooner, and the poller supplies the starting score for each game and catches anything a webhook missed. The tracker makes sure a play reported by both flashes once:

- a score goes up as soon as either source reports it;
- a lower score is believed only from the source that reported the higher one, or once it has lasted 90 seconds, so a slow feed cannot undo a fast one;
- a game never moves backwards from live to scheduled, or from final to live;
- games are matched across sources by their two teams, since feeds number games differently.

With the webhook alone, the first update for each game only sets its starting score. If that first update is itself a score, that one play is not flashed.

Matching across sources relies on both using the same team abbreviations. NFL teams are normalised by the built-in table; for other leagues check that your feed's abbreviations match ESPN's.

### Webhook payload

The receiver speaks one format today, `generic`: the current state of a game, or a list of them (`[...]` or `{ "games": [...] }`).

```json
{
  "state": "in",
  "detail": "4:12 - 3rd",
  "at": "2026-11-22T18:41:07Z",
  "home": { "team": "NYG", "score": 7 },
  "away": { "team": "DAL", "score": 0 }
}
```

`state` is `pre`, `in` or `post`. `detail` and `at` are optional; `at` lets the tracker drop a retry that arrives after a newer update. Each request carries `X-Timestamp` (Unix seconds, within five minutes of now) and `X-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>` under `WEBHOOK_SECRET`.

No sports-data provider sends this format, so a provider's webhooks need an adapter: an entry in `ADAPTERS` in [`src/sources/webhook.ts`](src/sources/webhook.ts) that checks the provider's signature and maps its payload to game snapshots. The handler itself is a plain `Request -> Response` function, so it can also run as a Cloudflare Worker.

To try the receiver without a provider:

```sh
bun start run --dry-run          # with "webhook" enabled in config.json
bun start emit NYG 0 DAL 0       # sets the starting score
bun start emit NYG 7 DAL 0       # logs a Giants touchdown
```

A provider on the internet cannot reach `127.0.0.1`. Put a tunnel such as `cloudflared` in front rather than opening the port.

## NFL teams

All 32 teams are built in (`bun start teams` lists them), each with one or two lamp colours in [`src/nfl.ts`](src/nfl.ts). These start from the team's palette but are tuned for bulbs: black is dropped, silver becomes white, and a few dark shades are more saturated. To change one, edit the table or set `colors` on an effect.

Because the colours are built in, `test` works for any NFL team whether or not it is playing. Other leagues take colours from the scoreboard, so `test` only knows them on a game day.

## Limits

- **The feed can run ahead of or behind your TV.** `delaySeconds` fixes a feed that spoils the play, counted from the play itself (from the score's game clock where the feed gives one), so a score that reaches us late is not flashed late too. Nothing fixes a feed slower than your TV.
- **ESPN's scoreboard is undocumented** and can change or lag without notice. `src/espn.ts` is the only file that knows its shape.
- **Only games on ESPN's current board can be picked.** For most leagues that is one US day, and it rolls over during the US morning, so late at night tonight's games are not listed yet. The NFL board covers the whole week.
- **Two games between the same teams on one scoreboard**, such as a baseball doubleheader, are read as one game.
- **Events are inferred from the score.** Two football points could be a conversion or a safety, and a touchdown plus its extra point inside one poll reads as a single 7-point touchdown. Cards, penalties and other non-scoring plays are not detected.
- **The Remote API adds a round trip through Hue's cloud** and has rate limits that are not yet measured.
- **The bridge certificate is not verified by default**, since it is issued by Signify's private CA for the bridge id rather than its IP. To verify it, set `HUE_CA_FILE` to the Hue root CA and `HUE_BRIDGE_ID` to the bridge id.

## Cloudflare Worker

The hosted version runs at [scorelights.app](https://scorelights.app), as the Worker `scorelights`. Anyone with a Hue Bridge can open it, press **Connect Hue**, sign in on Philips Hue's own site, pick a room, and then pick the game they're watching from the live and upcoming games of a league. The lights follow that one game until its final; the next game is picked the same way. A TV delay and effects are kept between games. There are no accounts: the bridge is the account, and a signed cookie keeps you signed in for 30 days.

[`src/worker`](src/worker) runs the same pipeline as the local service, with no bridge on the local network:

- **Games** (a Durable Object per league) holds the shared tracker behind the webhook receiver at `POST /webhook/<league>`, and who follows which game. Game state is the same for everyone; each user gets only their game's events, and is let go at its final.
- **Feeder** (one per league) polls ESPN on an alarm, every 10 s while a game is live, and posts the board to that receiver, signed, like any other score source. It stops when nobody in the league follows a game.
- **Polymarket** (one relay) holds a WebSocket to [Polymarket's sports feed](https://docs.polymarket.com/market-data/websocket/sports) while anyone follows an NFL, NBA, WNBA, NHL or MLB game. It posts each followed game's score changes to the same receiver as `source: "polymarket"`. In basketball it has the score a few seconds after the play, where ESPN's scoreboard takes 10–30 s; the tracker fires whichever arrives first, once. It closes the socket when every watched game has ended.
- **User** (one per bridge) keeps that bridge's settings, the game it follows and its Hue Remote API tokens. It holds each effect until the TV delay after its play, plays it from an alarm, and stops following when the final arrives (or 12 hours after kickoff).

The logo, icons and brand colours are in [`brand/`](brand), with the icon licences and the credit line the site has to show. The page is a React + [Mantine](https://mantine.dev) app in [`web/`](web), built by Vite and served by the Worker as static assets. The main screen is kept simple (the game, the room, syncing with your TV, test flash); the delay in seconds, effects and the flash mode sit under **Advanced**. Syncing asks you to tap when your TV's game clock shows a given time; the delay becomes how far that is behind the moment the feeds' clock showed it, and "Flashes early" / "Flashes late" nudge it a second at a time.

Page views are counted with [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/), which sets no cookies. Production builds include its beacon when `CF_BEACON_TOKEN` (the site token from the Web Analytics dashboard) is set in the shell or `.env`; without it, and under `web:dev` and Storybook, there is no beacon.

Pushes to `main` deploy it: Cloudflare Workers Builds runs the typecheck and tests, then `wrangler deploy`. Run it locally with `bun run worker:dev`, and `bun run web:dev` for hot reload of the page. It needs `.dev.vars` (gitignored) with `WEBHOOK_SECRET`, `HUE_CLIENT_ID`, `HUE_CLIENT_SECRET`, `ADMIN_TOKEN` and `SESSION_SECRET`. Hue sends sign-ins back to the callback URL registered for the Hue app (`https://scorelights.app/auth/callback`), so signing in only works on the deployed Worker. Admin routes take `Authorization: Bearer $ADMIN_TOKEN`: `GET|PUT|DELETE /users/<id>`, `PUT|DELETE /users/<id>/game` (`{ "league", "key" }`, the key being the two team abbreviations, lowercase and sorted, like `dal-nyg`), `POST /users/<id>/test`, `GET /leagues/<league>` and `GET /polymarket` (the relay: connected, watched games, games it could not match).

## Development

```sh
bun run typecheck   # the CLI (Bun types), the Worker (Cloudflare types), the page (DOM types)
bun test
bun run storybook   # the settings page's components on :6006
```

Storybook shows every part of the settings page, in light and dark and at phone width, against a fake `/api`. That means states that are hard to reach for real, like an unreachable bridge or a failed save, can be seen without a server.

The Remote API tests use an in-memory stand-in for `api.meethue.com`. The local Hue client tests start a local HTTPS stand-in for the bridge and need `openssl` to mint its certificate; they are skipped without it.
