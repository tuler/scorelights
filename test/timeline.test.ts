import { describe, expect, it } from "bun:test";
import type { GameSnapshot } from "../src/espn.ts";
import { planEffects } from "../src/plan.ts";
import { parseSettings } from "../src/config.ts";
import { Timeline } from "../src/timeline.ts";
import { Tracker } from "../src/tracker.ts";

const at = (hms: string) => Date.parse(`2026-11-25T${hms}Z`);
const clock = (mmss: string, period = 4) => {
  const [m, s] = mmss.split(":").map(Number);
  return { period, seconds: m! * 60 + s! };
};

// Polymarket's messages for DAL @ DEN, Q4, 2026-11-25 (one per event, not a steady tick).
const DAL_AT_DEN: [string, string][] = [
  ["05:18:41", "5:14"], // a basket; then two free throws with the clock stopped
  ["05:19:04", "5:14"],
  ["05:19:21", "5:14"],
  ["05:19:36", "5:00"],
  ["05:19:48", "4:49"],
  ["05:20:03", "4:34"],
  ["05:20:09", "4:27"],
  ["05:20:16", "4:24"], // a foul: stopped at 4:24
  ["05:20:51", "4:24"],
  ["05:21:13", "4:24"],
  ["05:21:32", "4:13"],
];

function basketball(samples = DAL_AT_DEN, source = "polymarket"): Timeline {
  const t = new Timeline("basketball");
  for (const [time, c] of samples) t.observe(source, clock(c), at(time));
  return t;
}

describe("Timeline.clockAt", () => {
  const t = basketball();

  it("runs the clock between samples that moved, and never past the next", () => {
    expect(t.clockAt(at("05:19:52"))).toEqual({ period: 4, seconds: 289 - 4, running: true });
    expect(t.clockAt(at("05:20:12"))?.seconds).toBe(264); // 4:27 at :09, would be 4:24 at :12
    expect(t.clockAt(at("05:20:14"))?.seconds).toBe(264); // held at the next sample's 4:24
  });

  it("holds a stopped clock", () => {
    expect(t.clockAt(at("05:20:30"))).toEqual({ period: 4, seconds: 264, running: false });
    expect(t.clockAt(at("05:18:50"))).toEqual({ period: 4, seconds: 314, running: false });
  });

  it("carries a running clock on past the newest sample, for a while", () => {
    expect(t.clockAt(at("05:21:42"))).toEqual({ period: 4, seconds: 253 - 10, running: true });
    expect(t.clockAt(at("05:25:00"))?.running).toBe(false);
  });

  it("knows nothing before the first sample", () => {
    expect(t.clockAt(at("05:18:00"))).toBeUndefined();
  });
});

describe("Timeline.timeOf", () => {
  const t = basketball();

  it("finds when the clock ran into a value, from the sample that shows it ran", () => {
    expect(t.timeOf(clock("4:40"), at("05:22:00"))).toBe(at("05:19:57")); // 4:34 at :03, running into it
    expect(t.timeOf(clock("5:05"), at("05:22:00"))).toBe(at("05:19:31")); // after the free throws
  });

  it("puts a stopped value at the first sample that shows it", () => {
    expect(t.timeOf(clock("5:14"), at("05:22:00"))).toBe(at("05:18:41"));
  });

  it("looks ahead while the clock runs, and gives up on what it cannot know", () => {
    expect(t.timeOf(clock("4:00"), at("05:21:35"))).toBe(at("05:21:45"));
    expect(t.timeOf(clock("6:00"), at("05:22:00"))).toBeUndefined();
    expect(t.timeOf(clock("4:00", 3), at("05:22:00"))).toBeUndefined();
  });
});

const game = (home: number, away: number, c: { period: number; seconds: number }, sport: GameSnapshot["sport"] = "basketball"): GameSnapshot => ({
  id: "x",
  name: "DAL @ DEN",
  sport,
  state: "in",
  detail: "",
  clock: c,
  teams: [
    { id: "den", abbreviation: "DEN", name: "DEN", homeAway: "home", score: home },
    { id: "dal", abbreviation: "DAL", name: "DAL", homeAway: "away", score: away },
  ],
});

describe("Tracker timing", () => {
  it("learns how far ESPN runs behind, and places its late plays back by that much", () => {
    let now = at("05:18:00");
    const tracker = new Tracker(() => now);
    tracker.update([game(100, 88, clock("5:30"))], "polymarket");
    tracker.update([game(100, 88, clock("5:30"))], "espn");
    for (const [poly, espn, home] of [
      ["05:18:41", "05:18:53", 102],
      ["05:19:04", "05:19:16", 103],
    ] as const) {
      now = at(poly);
      expect(tracker.update([game(home, 88, clock("5:14"))], "polymarket")[0]?.playAt).toBe(now);
      now = at(espn);
      expect(tracker.update([game(home, 88, clock("5:14"))], "espn")).toEqual([]);
    }
    // Polymarket missed this one: ESPN's report, 12 s late as measured, lands 12 s back.
    now = at("05:20:00");
    expect(tracker.update([game(104, 88, clock("5:14"))], "espn")[0]?.playAt).toBe(at("05:19:48"));
  });

  it("places a hockey goal at the clock stop, however late the score came", () => {
    let now = at("02:00:00");
    const tracker = new Tracker(() => now);
    tracker.update([game(1, 1, clock("1:20", 2), "hockey")], "espn");
    now = at("02:00:10");
    tracker.update([game(1, 1, clock("1:10", 2), "hockey")], "espn");
    now = at("02:00:20");
    tracker.update([game(1, 1, clock("1:02", 2), "hockey")], "espn"); // the goal, the clock stopped
    now = at("02:00:30");
    tracker.update([game(1, 1, clock("1:02", 2), "hockey")], "espn");
    now = at("02:01:20");
    const [goal] = tracker.update([game(2, 1, clock("1:02", 2), "hockey")], "espn");
    expect(goal?.playAt).toBe(at("02:00:20")); // when the clock was first seen stopped
  });

  it("keeps its timeline across a save and restore", () => {
    let now = at("05:18:41");
    const before = new Tracker(() => now);
    before.update([game(102, 88, clock("5:14"))], "polymarket");
    now = at("05:19:36");
    before.update([game(104, 88, clock("5:00"))], "polymarket");
    const after = Tracker.restore(JSON.parse(JSON.stringify(before.save())), () => now);
    expect(after.timeOf("dal-den", clock("5:05"))).toBe(at("05:19:31"));
  });
});

describe("Syncing to the TV", () => {
  it("flashes when the TV's clock reaches the play, whenever the report arrived", () => {
    let now = at("05:18:00");
    const tracker = new Tracker(() => now);
    const feed = (time: string, home: number, c: string, source = "polymarket") => {
      now = at(time);
      return tracker.update([game(home, 88, clock(c))], source);
    };
    feed("05:18:00", 100, "5:30");
    feed("05:19:36", 100, "5:00");
    feed("05:19:48", 100, "4:49");
    // The viewer's TV runs 25 s behind: it shows 4:40 at 05:20:22, so they tap then.
    const shown = tracker.timeOf("dal-den", clock("4:40"))!;
    const delaySeconds = (at("05:20:22") - shown) / 1000;
    expect(delaySeconds).toBe(25);

    // A basket at 4:34, which Polymarket reports 4 s after the clock showed it.
    const settings = parseSettings({ group: "Den", delaySeconds, effects: { basket: { enabled: true, seconds: 3, signal: "on_off_color" } } });
    const [basket] = feed("05:20:07", 102, "4:34");
    const [planned] = planEffects([basket!], settings, { league: "basketball/nba", key: "dal-den" }, now);
    // The TV shows 4:34 six seconds after 4:40, at 05:20:28: the flash lands then, not 4 s later with the report.
    expect(basket?.playAt).toBe(at("05:20:03"));
    expect(planned?.dueAt).toBe(at("05:20:28"));
  });
});
