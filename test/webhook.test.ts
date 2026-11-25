import { describe, expect, it, spyOn } from "bun:test";
import { hexToXy } from "../src/color.ts";
import { parseConfig } from "../src/config.ts";
import { parseScoreboard } from "../src/espn.ts";
import { eventKeys, type SportsEvent } from "../src/events.ts";
import type { HueBridge, LightGroup } from "../src/hue.ts";
import { run } from "../src/runner.ts";
import { createWebhookHandler, genericAdapter, MAX_CLOCK_SKEW_SECONDS, signGeneric } from "../src/sources/webhook.ts";
import { Tracker } from "../src/tracker.ts";
import { board, following } from "./fixture.ts";

const SECRET = "s3cret";
const URL_ = "http://localhost/hook";
const update = (home: number, away: number, state = "in", extra: object = {}) => ({
  state, home: { team: "Giants", score: home }, away: { team: "DAL", score: away }, ...extra,
});

function receiver() {
  const seen: SportsEvent[] = [];
  const tracker = new Tracker();
  const handle = createWebhookHandler(tracker, {
    league: "football/nfl", path: "/hook", secret: SECRET, adapter: genericAdapter,
    onEvents: (events) => void seen.push(...events),
  });
  const post = async (payload: unknown, init: { headers?: Record<string, string>; raw?: string } = {}) => {
    const body = init.raw ?? JSON.stringify(payload);
    const res = await handle(new Request(URL_, { method: "POST", body, headers: init.headers ?? (await signGeneric(body, SECRET)) }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { tracker, handle, post, keys: () => seen.map((e) => eventKeys(e)[0]) };
}

describe("webhook handler", () => {
  it("turns signed updates into events", async () => {
    const { post, keys, tracker } = receiver();
    expect(await post(update(0, 0))).toEqual({ status: 200, json: { games: 1, events: 0 } });
    expect(await post(update(7, 0))).toEqual({ status: 200, json: { games: 1, events: 1 } });
    expect(await post(update(7, 0))).toMatchObject({ json: { events: 0 } }); // a provider retry
    expect(await post(update(7, 3, "post"))).toMatchObject({ json: { events: 2 } });
    expect(keys()).toEqual(["touchdown", "field_goal", "win"]);
    // "Giants" was normalised to the table's abbreviation.
    expect(tracker.games()[0]).toMatchObject({ name: "DAL @ NYG", sport: "football" });
  });

  it("reads the game clock, and refuses a malformed one", async () => {
    const { post, tracker } = receiver();
    expect((await post(update(0, 0, "in", { clock: { period: 2, seconds: 431.5 } }))).status).toBe(200);
    expect(tracker.games()[0]?.clock).toEqual({ period: 2, seconds: 431.5 });
    expect(tracker.timeOf("dal-nyg", { period: 2, seconds: 431.5 })).toBeNumber();
    for (const clock of [{ period: 0, seconds: 10 }, { period: 2 }, { period: 2, seconds: -1 }, "4:12"]) {
      expect((await post(update(0, 0, "in", { clock }))).status).toBe(422);
    }
  });

  it("accepts a list of games", async () => {
    const { post, keys } = receiver();
    const kc = (score: number) => ({ state: "in", home: { team: "KC", score }, away: { team: "BUF", score: 0 } });
    await post({ games: [update(0, 0), kc(0)] });
    expect(await post([update(7, 0), kc(3)])).toMatchObject({ json: { games: 2, events: 2 } });
    expect(keys()).toEqual(["touchdown", "field_goal"]);
  });

  it("rejects unsigned, mis-signed, tampered and stale requests", async () => {
    const { post, keys } = receiver();
    const body = JSON.stringify(update(7, 0));
    const stale = await signGeneric(body, SECRET, Date.now() - (MAX_CLOCK_SKEW_SECONDS + 5) * 1000);
    for (const headers of [{}, await signGeneric(body, "wrong"), await signGeneric(`${body} `, SECRET), stale, { "x-timestamp": "now", "x-signature": "sha256=00" }]) {
      expect((await post(undefined, { raw: body, headers })).status).toBe(401);
    }
    expect(keys()).toEqual([]);
  });

  it("rejects payloads it cannot read", async () => {
    const { post } = receiver();
    expect((await post(undefined, { raw: "{nope" })).status).toBe(400);
    expect(await post({ state: "in" })).toMatchObject({ status: 422, json: { error: expect.stringContaining("home.team") } });
    expect((await post(update(1.5, 0))).status).toBe(422);
    expect(await post({ state: "in", home: { team: "NYG", score: 0 }, away: { team: "Sharks", score: 0 } })).toMatchObject({
      status: 422, json: { error: '"Sharks" is not an NFL team' },
    });
    expect((await post(update(0, 0, "halftime"))).status).toBe(422);
    expect((await post(update(0, 0, "in", { at: "yesterday-ish" }))).status).toBe(422);
    expect((await post({ state: "in", home: { team: "NYG", score: 0 }, away: { team: "giants", score: 0 } })).status).toBe(422);
  });

  it("answers 404 off the path and 405 for other methods", async () => {
    const { handle } = receiver();
    expect((await handle(new Request("http://localhost/other", { method: "POST" }))).status).toBe(404);
    expect((await handle(new Request(URL_))).status).toBe(405);
  });
});

/** Runs the real service with a recording bridge; `during` gets the receiver's URL. */
async function service(overrides: object, during: (url: string, calls: unknown[]) => Promise<void>, boards: object[] = []) {
  const config = { ...parseConfig({ league: "nfl", group: "Den", webhook: { port: 0 }, ...overrides }), pollSeconds: 0.02 };
  const calls: unknown[] = [];
  const bridge = {
    signal: async (_g: LightGroup, signal: string, seconds: number, colors: unknown[]) => void calls.push({ signal, seconds, colors }),
  } as unknown as HueBridge;
  const group: LightGroup = { id: "gl", name: "Den", kind: "room", children: [] };
  const stop = new AbortController();
  let i = 0;
  const logs = spyOn(console, "log").mockImplementation(() => {});
  try {
    await run(config, following("NYG", "DAL"), { bridge, group }, stop.signal, {
      webhookSecret: SECRET,
      fetchBoard: async () => parseScoreboard(boards[Math.min(i++, boards.length - 1)] ?? board([]), "football/nfl"),
      onListening: (url) => void during(url, calls).finally(() => stop.abort()),
    });
  } finally {
    logs.mockRestore();
  }
  return calls;
}

const send = async (url: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const res = await fetch(url, { method: "POST", body, headers: await signGeneric(body, SECRET) });
  expect(res.status).toBe(200);
};

describe("service with a webhook receiver", () => {
  it("flashes for pushed updates with polling off", async () => {
    const calls = await service({ poll: false }, async (url) => {
      await send(url, update(0, 0));
      await send(url, update(6, 0));
    });
    expect(calls).toEqual([{ signal: "alternating", seconds: 10, colors: [hexToXy("0B2265"), hexToXy("A71930")] }]);
  });

  it("flashes once when the poller and a webhook both report a score", async () => {
    const before = board([{ id: "espn-1", state: "in", home: ["NYG", 0], away: ["DAL", 0] }]);
    const after = board([{ id: "espn-1", state: "in", home: ["NYG", 0], away: ["DAL", 3] }]);
    const calls = await service(
      {},
      async (url) => {
        await Bun.sleep(60); // the poller has set its baseline
        await send(url, update(0, 3));
        await Bun.sleep(150); // and has since seen the same field goal
      },
      [before, before, after],
    );
    expect(calls).toEqual([{ signal: "on_off_color", seconds: 5, colors: [hexToXy("003594"), hexToXy("FFFFFF")] }]);
  });

  it("refuses to start a receiver without a secret", async () => {
    const config = parseConfig({ league: "nfl", group: "Den", webhook: {} });
    const logs = spyOn(console, "log").mockImplementation(() => {});
    await expect(run(config, following("NYG", "DAL"), undefined, new AbortController().signal)).rejects.toThrow(/WEBHOOK_SECRET/);
    logs.mockRestore();
  });
});

it("validates webhook config", () => {
  const base = { league: "nfl", group: "Den" };
  expect(parseConfig(base)).toMatchObject({ poll: true, webhook: undefined });
  expect(parseConfig({ ...base, webhook: true }).webhook).toEqual({ host: "127.0.0.1", port: 8787, path: "/webhook", adapter: "generic" });
  expect(parseConfig({ ...base, webhook: { enabled: false } }).webhook).toBeUndefined();
  expect(() => parseConfig({ ...base, poll: false })).toThrow(/no score source/);
  expect(() => parseConfig({ ...base, webhook: { path: "hook" } })).toThrow(/webhook.path/);
  expect(() => parseConfig({ ...base, webhook: { adapter: "espn" } })).toThrow(/one of: generic/);
  expect(() => parseConfig({ ...base, webhook: { port: 70000 } })).toThrow(/webhook.port/);
});
