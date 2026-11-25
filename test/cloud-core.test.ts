/** The pure pieces the Worker is built from: feeder payload, tracker persistence, per-user planning. */
import { describe, expect, it } from "bun:test";
import { hexToXy } from "../src/color.ts";
import { parseSettings } from "../src/config.ts";
import { parseScoreboard } from "../src/espn.ts";
import { eventKeys } from "../src/events.ts";
import { isLate, planEffects } from "../src/plan.ts";
import { ESPN_SOURCE, scoreboardPayload } from "../src/sources/feed.ts";
import { createWebhookHandler, genericAdapter, signGeneric } from "../src/sources/webhook.ts";
import { Tracker } from "../src/tracker.ts";
import { board, following, type FakeGame } from "./fixture.ts";

const SECRET = "s3cret";
const live = (id: string, home: [string, number], away: [string, number], state: FakeGame["state"] = "in"): FakeGame => ({
  id, state, home, away,
});
const espn = (games: FakeGame[], league = "football/nfl") => parseScoreboard(board(games), league);

/** A receiver like the Games object's: a tracker behind the webhook handler. */
function receiver(tracker = new Tracker()) {
  const keys: string[] = [];
  const handle = createWebhookHandler(tracker, {
    league: "football/nfl",
    path: "/webhook",
    secret: SECRET,
    adapter: genericAdapter,
    onEvents: (events) => void keys.push(...events.map((e) => eventKeys(e)[0]!)),
  });
  const send = async (payload: unknown) => {
    const body = JSON.stringify(payload);
    const res = await handle(new Request("https://games/webhook", { method: "POST", body, headers: await signGeneric(body, SECRET) }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { tracker, keys, send };
}

describe("ESPN feeder payload", () => {
  it("carries the whole board, its source name and team colours through the receiver", async () => {
    const payload = scoreboardPayload(espn([live("1", ["NYG", 0], ["DAL", 0]), live("2", ["KC", 3], ["BUF", 0])]));
    expect(payload).toMatchObject({ source: ESPN_SOURCE, complete: true });
    expect(payload.games[0]).toEqual({
      state: "in",
      detail: "4:12 - 3rd",
      home: { team: "NYG", score: 0, color: "003c7f", alternateColor: "c9243f" },
      away: { team: "DAL", score: 0, color: "003c7f", alternateColor: "c9243f" },
    });

    const { tracker, keys, send } = receiver();
    expect(await send(payload)).toEqual({ status: 200, json: { games: 2, events: 0 } });
    await send(scoreboardPayload(espn([live("1", ["NYG", 0], ["DAL", 6]), live("2", ["KC", 3], ["BUF", 0])])));
    expect(keys).toEqual(["touchdown"]);
    expect(tracker.games().find((g) => g.name === "DAL @ NYG")?.teams[0]?.color).toBe("003c7f");
  });

  it("drops a game the full board stops listing", async () => {
    const { tracker, send } = receiver();
    await send(scoreboardPayload(espn([live("1", ["NYG", 0], ["DAL", 0]), live("2", ["KC", 3], ["BUF", 0])])));
    await send(scoreboardPayload(espn([live("2", ["KC", 3], ["BUF", 0])])));
    expect(tracker.games().map((g) => g.name)).toEqual(["BUF @ KC"]);
  });

  it("refuses a bad source name or complete flag", async () => {
    const { send } = receiver();
    expect((await send({ source: "Not OK!", games: [] })).status).toBe(422);
    expect((await send({ complete: "yes", games: [] })).status).toBe(422);
  });
});

describe("Tracker persistence", () => {
  it("picks up where it left off after a save and restore", () => {
    let now = 1_000_000;
    const before = new Tracker(() => now);
    before.update(espn([live("1", ["NYG", 0], ["DAL", 0])]), "espn", true);
    before.update(espn([live("1", ["NYG", 3], ["DAL", 0])]), "webhook");

    // A Durable Object's storage keeps structured-cloneable data; JSON is stricter.
    const after = Tracker.restore(JSON.parse(JSON.stringify(before.save())), () => now);
    expect(after.games()).toEqual(before.games());
    now += 1000;
    // The same field goal from the slower feed must not fire again.
    expect(after.update(espn([live("1", ["NYG", 3], ["DAL", 0])]), "espn", true)).toEqual([]);
    expect(after.update(espn([live("1", ["NYG", 3], ["DAL", 6])]), "espn", true).map((e) => eventKeys(e)[0])).toEqual([
      "touchdown",
    ]);
  });
});

describe("planEffects", () => {
  const events = new Tracker(() => 1_000);
  events.update(espn([live("1", ["NYG", 0], ["DAL", 0]), live("2", ["KC", 0], ["BUF", 0])]), "espn");
  const batch = events.update(espn([live("1", ["NYG", 6], ["DAL", 3]), live("2", ["KC", 1], ["BUF", 0])]), "espn");

  it("plans the followed game's scores, both teams', after the TV delay", () => {
    const settings = parseSettings({ group: "Den", delaySeconds: 30 });
    const planned = planEffects(batch, settings, following("NYG", "DAL"), 1_000);
    expect(planned.map((p) => [p.label.split(" (")[0], p.dueAt, p.effect.seconds])).toEqual([
      ["NYG touchdown", 31_000, 10],
      ["DAL field goal", 31_000, 5],
    ]);
    expect(planned[0]?.colors[0]).toEqual(hexToXy("0B2265"));
  });

  it("times each effect from its play, or from now when the play time is unknown", () => {
    const settings = parseSettings({ group: "Den", delaySeconds: 20 });
    const [score] = batch.filter((e) => e.type === "score");
    const late = planEffects([{ ...score!, playAt: 5_000 }], settings, following("NYG", "DAL"), 40_000);
    expect(late[0]?.dueAt).toBe(25_000);
    const { playAt: _, ...untimed } = score!;
    expect(planEffects([untimed], settings, following("NYG", "DAL"), 40_000)[0]?.dueAt).toBe(60_000);
  });

  it("leaves out disabled effects and other games", () => {
    const settings = parseSettings({ group: "Den" });
    // KC's extra point is off by default.
    expect(planEffects(batch, settings, following("KC", "BUF"), 0)).toEqual([]);
    expect(planEffects(batch, settings, following("PHI", "NYG"), 0)).toEqual([]);
  });

  it("shows both teams' main colours for a kickoff", () => {
    const t = new Tracker();
    t.update(espn([live("1", ["NYG", 0], ["DAL", 0], "pre")]), "espn");
    const kickoff = t.update(espn([live("1", ["NYG", 0], ["DAL", 0])]), "espn");
    const [planned] = planEffects(kickoff, parseSettings({ group: "Den" }), following("NYG", "DAL"), 0);
    expect(planned?.colors).toEqual([hexToXy("0B2265"), hexToXy("003594")]);
  });

  it("calls an effect late after 45 seconds", () => {
    expect(isLate(0, 45_000)).toBe(false);
    expect(isLate(0, 45_001)).toBe(true);
  });
});
