/**
 * One user: their settings, the game they follow, their Hue Remote API tokens
 * and app key, and the queue of effects waiting out their TV delay. Events for
 * the followed game arrive from the league's Games object; an alarm plays each
 * effect when it is due. Following ends with the game's final.
 *
 * A Durable Object handles one request at a time around storage, so only one
 * token refresh can be in flight, which the single-use refresh token needs.
 */
import { DurableObject } from "cloudflare:workers";
import { parseSettings, effectFor, type Settings } from "../config.ts";
import { colorsFor, play } from "../effects.ts";
import { resolveLeague, type GameClock, type TeamSide } from "../espn.ts";
import type { SportsEvent } from "../events.ts";
import { endsGame, hasLapsed, type FollowedGame } from "../follow.ts";
import { HueBridge, type LightGroup } from "../hue.ts";
import { HueRemoteAuth, remoteTransport, type RemoteTokens, type TokenStore } from "../hue-remote.ts";
import { findNflTeam, NFL_LEAGUE } from "../nfl.ts";
import { isLate, planEffects, type PlannedEffect } from "../plan.ts";
import type { ClockReading } from "../timeline.ts";
import type { Env } from "./env.ts";
import { POLYMARKET_RELAY } from "./polymarket.ts";

/** The longest TV delay a viewer can set or sync to (seconds). */
export const MAX_DELAY_SECONDS = 600;

interface Profile {
  id: string;
  settings: Settings;
  game?: FollowedGame;
}

export class User extends DurableObject<Env> {
  private queue?: PlannedEffect[];
  private group?: LightGroup;

  private get store(): TokenStore {
    return {
      load: () => this.ctx.storage.get<RemoteTokens>("tokens"),
      save: (tokens) => this.ctx.storage.put("tokens", tokens),
    };
  }

  private auth(): HueRemoteAuth {
    return new HueRemoteAuth({ clientId: this.env.HUE_CLIENT_ID, clientSecret: this.env.HUE_CLIENT_SECRET, store: this.store });
  }

  private async bridge(): Promise<HueBridge> {
    const appKey = await this.ctx.storage.get<string>("appKey");
    if (!appKey) throw new Error("No Hue app key yet: finish signing in.");
    return new HueBridge(remoteTransport(this.auth(), { appKey }));
  }

  private async profile(): Promise<Profile> {
    const profile = await this.ctx.storage.get<Profile>("profile");
    if (!profile) throw new Error("Pick your room first.");
    return profile;
  }

  /** The game being followed, unless following has lapsed. */
  private static current(profile: Profile | undefined): FollowedGame | undefined {
    const game = profile?.game;
    return game && !hasLapsed(game, Date.now()) ? game : undefined;
  }

  private async loadQueue(): Promise<PlannedEffect[]> {
    this.queue ??= (await this.ctx.storage.get<PlannedEffect[]>("queue")) ?? [];
    return this.queue;
  }

  private async saveQueue(queue: PlannedEffect[]): Promise<void> {
    this.queue = queue;
    await this.ctx.storage.put("queue", queue);
    const next = queue[0]?.dueAt;
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** Saves settings. Which game to follow is `follow`'s business. */
  async configure(id: string, raw: unknown): Promise<Settings> {
    const settings = parseSettings(raw);
    const old = await this.ctx.storage.get<Profile>("profile");
    await this.ctx.storage.put<Profile>("profile", { ...old, id, settings });
    this.group = undefined;
    return settings;
  }

  /**
   * Follows `game` instead of whatever came before: subscribes to it in its
   * league, starts that league's feeder, and has the Polymarket relay watch
   * it. Effects still queued for the old game are dropped.
   */
  async follow(game: FollowedGame): Promise<FollowedGame> {
    const profile = await this.profile();
    if (profile.game) await this.env.GAMES.getByName(resolveLeague(profile.game.league)).unsubscribe(profile.id);
    await this.saveQueue([]);
    const league = resolveLeague(game.league);
    await this.ctx.storage.put<Profile>("profile", { ...profile, game });
    await this.env.GAMES.getByName(league).subscribe(profile.id, game.key, game.until);
    await this.env.FEEDER.getByName(league).start(league);
    // Polymarket brings scores sooner where it covers the league; ESPN still works without it.
    const relay = { league, key: game.key, home: game.home.abbreviation, away: game.away.abbreviation, until: game.until };
    await this.env.POLYMARKET.getByName(POLYMARKET_RELAY).watch(relay).catch((err) => console.error("Polymarket watch failed:", err));
    return game;
  }

  /** Stops following, and drops any effects still queued. */
  async unfollow(): Promise<void> {
    const profile = await this.ctx.storage.get<Profile>("profile");
    if (!profile?.game) return;
    await this.env.GAMES.getByName(resolveLeague(profile.game.league)).unsubscribe(profile.id);
    await this.ctx.storage.put<Profile>("profile", { ...profile, game: undefined });
    await this.saveQueue([]);
  }

  /**
   * The followed game's clock: `live`, the newest the feeds know, and `tv`,
   * as the viewer's TV should show it now (`delaySeconds` back). Either is
   * absent before the feeds have given a clock (baseball has none).
   */
  async clock(now: number): Promise<{ delaySeconds: number; live?: ClockReading; tv?: ClockReading }> {
    const profile = await this.profile();
    const game = User.current(profile);
    const { delaySeconds } = profile.settings;
    if (!game) return { delaySeconds };
    const games = this.env.GAMES.getByName(resolveLeague(game.league));
    const [live, tv] = await Promise.all([games.clockAt(game.key, now), games.clockAt(game.key, now - delaySeconds * 1000)]);
    return { delaySeconds, ...(live ? { live } : {}), ...(tv ? { tv } : {}) };
  }

  /**
   * The viewer's TV showed `clock` at `tappedAt`: the TV delay becomes how far
   * that is behind the moment the game's timeline showed it.
   */
  async sync(clock: GameClock, tappedAt: number): Promise<{ delaySeconds: number; ahead: boolean }> {
    const profile = await this.profile();
    const game = User.current(profile);
    if (!game) throw new Error("Follow a game first.");
    const shown = await this.env.GAMES.getByName(resolveLeague(game.league)).timeOf(game.key, clock);
    if (shown === undefined) throw new Error("Can't line up with that time yet. Try again once the game clock is running.");
    const behind = (tappedAt - shown) / 1000;
    if (behind > MAX_DELAY_SECONDS) throw new Error("That is more than 10 minutes behind the game. Check the time you tapped on.");
    // A TV ahead of every feed (rare: stadium or over-the-air) can't be waited for.
    const delaySeconds = Math.max(0, Math.round(behind * 10) / 10);
    await this.saveDelay(profile, delaySeconds);
    return { delaySeconds, ahead: behind < 0 };
  }

  /** Sets the TV delay alone, as the nudge buttons do. */
  async setDelay(delaySeconds: number): Promise<number> {
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
      throw new Error(`The TV delay must be between 0 and ${MAX_DELAY_SECONDS} seconds.`);
    }
    const rounded = Math.round(delaySeconds * 10) / 10;
    await this.saveDelay(await this.profile(), rounded);
    return rounded;
  }

  private async saveDelay(profile: Profile, delaySeconds: number): Promise<void> {
    await this.ctx.storage.put<Profile>("profile", { ...profile, settings: { ...profile.settings, delaySeconds } });
  }

  /**
   * Takes over tokens from a Hue sign-in, and makes an app key on the first
   * one by pressing the bridge's link button through the cloud.
   */
  async adopt(tokens: RemoteTokens): Promise<void> {
    await this.ctx.storage.put("tokens", tokens);
    if (!(await this.ctx.storage.get<string>("appKey"))) {
      const setup = new HueBridge(remoteTransport(this.auth()));
      await setup.pressLinkButton();
      await this.ctx.storage.put("appKey", await setup.pair("scorelights#cloud"));
    }
  }

  /** For development: hand over tokens made by the CLI's `remote-auth`. The CLI must stop using them. */
  async importTokens(tokens: RemoteTokens, appKey: string): Promise<void> {
    await this.ctx.storage.put("tokens", tokens);
    await this.ctx.storage.put("appKey", appKey);
  }

  /** What the settings page needs: saved settings and the followed game, if any. */
  async me(): Promise<{ settings?: Settings; game?: FollowedGame; connected: boolean }> {
    const profile = await this.ctx.storage.get<Profile>("profile");
    return {
      settings: profile?.settings,
      game: User.current(profile),
      connected: Boolean(await this.ctx.storage.get<string>("appKey")),
    };
  }

  async groups(): Promise<{ name: string; kind: string }[]> {
    return (await (await this.bridge()).groups()).map((g) => ({ name: g.name, kind: g.kind }));
  }

  /** Disconnects: stops following and forgets everything, tokens included. */
  async remove(): Promise<void> {
    const profile = await this.ctx.storage.get<Profile>("profile");
    if (profile?.game) await this.env.GAMES.getByName(resolveLeague(profile.game.league)).unsubscribe(profile.id);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.queue = undefined;
    this.group = undefined;
  }

  /**
   * Queues the effects this user wants for `events`, and stops following once
   * the game's final is among them. Called by the league's Games object.
   */
  async deliver(events: SportsEvent[]): Promise<number> {
    const profile = await this.profile();
    const game = User.current(profile);
    if (!game) return 0;
    const planned = planEffects(events, profile.settings, game, Date.now());
    if (endsGame(events, game.key)) await this.ctx.storage.put<Profile>("profile", { ...profile, game: undefined });
    if (planned.length === 0) return 0;
    const queue = [...(await this.loadQueue()), ...planned].sort((a, b) => a.dueAt - b.dueAt);
    await this.saveQueue(queue);
    return planned.length;
  }

  /** Plays everything due, one at a time, then waits for the next. */
  override async alarm(): Promise<void> {
    const { settings } = await this.profile();
    for (;;) {
      const queue = await this.loadQueue();
      const next = queue[0];
      if (!next) break;
      if (next.dueAt > Date.now()) break;
      await this.saveQueue(queue.slice(1));
      if (isLate(next.dueAt, Date.now())) {
        console.log(`Skipped a late effect: ${next.label}`);
        continue;
      }
      try {
        await play({ bridge: await this.bridge(), group: await this.lightGroup(settings) }, settings.effectMode, next.effect, next.colors);
      } catch (err) {
        console.error(`Effect failed (${next.label}):`, err instanceof Error ? err.message : err);
      }
    }
    await this.saveQueue(await this.loadQueue());
  }

  private async lightGroup(settings: Settings): Promise<LightGroup> {
    this.group ??= await (await this.bridge()).findGroup(settings.group);
    return this.group;
  }

  /**
   * Plays one effect now, to check the whole route: in `team`'s colours if
   * given, else in the followed game's colours, else white.
   */
  async test(effectKey: string, team?: Pick<TeamSide, "abbreviation" | "color" | "alternateColor">): Promise<string> {
    const profile = await this.profile();
    const { settings } = profile;
    const effect = effectFor(settings, [effectKey]);
    if (!effect) throw new Error(`Effect "${effectKey}" is unknown or disabled.`);
    const game = User.current(profile);
    const league = game ? resolveLeague(game.league) : NFL_LEAGUE;
    const nfl = (t: Pick<TeamSide, "abbreviation" | "color" | "alternateColor">) =>
      league === NFL_LEAGUE ? { ...t, abbreviation: findNflTeam(t.abbreviation)?.abbr ?? t.abbreviation } : t;
    const teams = team?.abbreviation ? [nfl(team)] : game ? [game.home, game.away] : [];
    const group = await this.lightGroup(settings);
    await play({ bridge: await this.bridge(), group }, settings.effectMode, effect, colorsFor(effect, league, teams));
    return `Played "${effectKey}" on ${group.name} for ${effect.seconds}s`;
  }

  async status() {
    const profile = await this.ctx.storage.get<Profile>("profile");
    const tokens = await this.ctx.storage.get<RemoteTokens>("tokens");
    return {
      profile,
      following: User.current(profile)?.name,
      signedIn: Boolean(tokens),
      accessTokenExpiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : undefined,
      hasAppKey: Boolean(await this.ctx.storage.get<string>("appKey")),
      queued: (await this.loadQueue()).map((p) => ({ label: p.label, dueAt: new Date(p.dueAt).toISOString() })),
    };
  }
}
