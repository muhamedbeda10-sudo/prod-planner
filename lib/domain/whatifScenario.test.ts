import { describe, expect, it } from "vitest";
import { defaultScenario, optimizeQueue, optimizeQueueWithin, type WhatIfInputs, type WhatIfJob } from "./whatif";
import { describeScenario, isDayISO, knobsOfScenario, loadScenario, parseScenario, scenarioName, withKnobs } from "./whatifScenario";

const job = (id: string, o: Partial<WhatIfJob> = {}): WhatIfJob => ({
  id, mo: id.split("|")[0], bom: "B1", item: id.split("|")[1], dueISO: "2026-10-20",
  left: { cut: 4, weld: 4, finish: 4 }, perPc: { cut: 1, weld: 1, finish: 1 }, baselineDays: 2, blockedBy: null, ...o,
});
const inputs: WhatIfInputs = {
  todayISO: "2026-10-12", holidayISOs: [], rates: { cut: 10, weld: 10, finish: 10 }, rateSigma: { cut: 0, weld: 0, finish: 0 }, rateWindowDays: 20,
  capacity: {}, jobs: [job("A|TN"), job("A|TC"), job("B|CF")], plan: null,
};
const reality = defaultScenario(inputs);

describe("parseScenario", () => {
  it("keeps a scenario the Simulator made, and fills what is missing with reality", () => {
    const sc = { ...reality, workersDelta: { ...reality.workersDelta, Welding: 2 }, workFridays: true, splits: { "A|TN": [1, 3] }, holds: { "B|CF": "2026-10-15" }, downtimes: [{ stage: "cut", fromISO: "2026-10-13", toISO: "2026-10-14" }] };
    expect(parseScenario(JSON.parse(JSON.stringify(sc)))).toEqual({ ok: true, scenario: sc });
    expect(parseScenario({ shiftHours: 9.5 })).toEqual({ ok: true, scenario: { ...reality, shiftHours: 9.5, queue: [] } });
  });

  it("refuses what it cannot trust, naming it", () => {
    const bad: [unknown, string][] = [
      [null, "not readable"],
      [{ workersDelta: { Assembly: 1 } }, "Unknown department Assembly"],
      [{ workersDelta: { Welding: 1.5 } }, "whole number"],
      [{ workersDelta: { Cut: 501 } }, "±500"],
      [{ shiftHours: 0 }, "between 1 and 24"],
      [{ shiftHours: 25 }, "between 1 and 24"],
      [{ workFridays: "yes" }, "on or off"],
      [{ queue: ["A|TN", "A|TN"] }, "twice"],
      [{ queue: [7] }, "unreadable job"],
      [{ splits: { "A|TN": [4] } }, "2 to 50 batches"],
      [{ splits: { "A|TN": [1.5, 2.5] } }, "2 to 50 batches"],
      [{ holds: { "A|TN": "2026-02-30" } }, "real day"],
      [{ downtimes: [{ stage: "paint", fromISO: "2026-10-13", toISO: "2026-10-13" }] }, "cut, weld or finish"],
      [{ downtimes: [{ stage: "weld", fromISO: "2026-10-14", toISO: "2026-10-13" }] }, "ends (2026-10-13) before it starts"],
    ];
    for (const [raw, msg] of bad) {
      const r = parseScenario(raw);
      expect(r.ok, msg).toBe(false);
      expect(!r.ok && r.error, msg).toContain(msg);
    }
  });
});

describe("withKnobs", () => {
  it("turns the knobs named and keeps the rest", () => {
    const r = withKnobs(inputs, reality, { workersDelta: { Painting: -1 }, workFridays: true, downtimes: [{ stage: "weld", fromISO: "2026-10-13", toISO: "2026-10-13" }] });
    expect(r).toMatchObject({ ok: true, scenario: { workersDelta: { Cut: 0, Welding: 0, ShotBlast: 0, Painting: -1 }, workFridays: true, shiftHours: 11, queue: ["A|TN", "A|TC", "B|CF"] } });
    expect(r.ok && describeScenario(r.scenario, inputs)).toBe("-1 Painting · Fridays on · 1 stoppage");
  });

  it("rushes jobs, batches and whole MOs to the front, in the order named", () => {
    expect(withKnobs(inputs, reality, { first: ["B|CF"] })).toMatchObject({ ok: true, scenario: { queue: ["B|CF", "A|TN", "A|TC"] } });
    expect(withKnobs(inputs, reality, { first: ["B", "A|TC"] })).toMatchObject({ ok: true, scenario: { queue: ["B|CF", "A|TC", "A|TN"] } });
    // a split job's batches stand in for it — by the job, or one batch alone
    expect(withKnobs(inputs, reality, { splits: [{ job: "B|CF", batches: [1, 3] }], first: ["B|CF#1"] })).toMatchObject({ ok: true, scenario: { queue: ["B|CF#1", "A|TN", "A|TC", "B|CF#2"], splits: { "B|CF": [1, 3] } } });
    expect(withKnobs(inputs, reality, { first: ["Z"] })).toEqual({ ok: false, error: "Not open in today's queue: Z." });
  });

  it("checks splits and holds against the jobs that are open", () => {
    expect(withKnobs(inputs, reality, { splits: [{ job: "A|TN", batches: [1, 2] }] })).toEqual({ ok: false, error: "The batches of A|TN add up to 3; it still owes 4 piece(s)." });
    expect(withKnobs(inputs, reality, { holds: [{ job: "Q|TN", untilISO: "2026-10-15" }] })).toMatchObject({ ok: false });
    expect(withKnobs(inputs, reality, { holds: [{ job: "A|TN", untilISO: "2026-10-15" }] })).toMatchObject({ ok: true, scenario: { holds: { "A|TN": "2026-10-15" } } });
  });

  it("drops what a saved scenario's queue holds that is no longer open, and puts new jobs at the back", () => {
    const saved = loadScenario(inputs, { queue: ["GONE|TN", "B|CF", "A|TN"], workFridays: true });
    expect(withKnobs(inputs, saved, {})).toMatchObject({ ok: true, scenario: { queue: ["B|CF", "A|TN", "A|TC"], workFridays: true } });
  });

  it("keeps a split job's batches where the job stood, and a job unsplit where its first batch was", () => {
    const split = withKnobs(inputs, reality, { splits: [{ job: "A|TN", batches: [1, 3] }] });
    expect(split).toMatchObject({ ok: true, scenario: { queue: ["A|TN#1", "A|TN#2", "A|TC", "B|CF"] } });
    const moved = { ...reality, queue: ["A|TC", "A|TN#2", "B|CF", "A|TN#1"], splits: { "A|TN": [1, 3] } };
    expect(withKnobs(inputs, moved, {})).toMatchObject({ ok: true, scenario: { queue: ["A|TC", "A|TN#2", "B|CF", "A|TN#1"] } });
    expect(withKnobs(inputs, moved, { splits: [] })).toMatchObject({ ok: true, scenario: { queue: ["A|TC", "A|TN", "B|CF"], splits: {} } });
  });
});

describe("knobsOfScenario", () => {
  it("reads the knobs back in the terms withKnobs takes — building from them gives the scenario again", () => {
    const built = withKnobs(inputs, reality, {
      workersDelta: { Welding: 2 }, shiftHours: 9, workFridays: true,
      downtimes: [{ stage: "weld", fromISO: "2026-10-13", toISO: "2026-10-14" }],
      holds: [{ job: "B|CF", untilISO: "2026-10-15" }], splits: [{ job: "A|TN", batches: [1, 3] }],
    });
    if (!built.ok) throw new Error(built.error);
    const k = knobsOfScenario(built.scenario, inputs);
    expect(k).toEqual({
      workersDelta: { Welding: 2 }, shiftHours: 9, workFridays: true,
      downtimes: [{ stage: "weld", fromISO: "2026-10-13", toISO: "2026-10-14" }],
      holds: [{ job: "B|CF", untilISO: "2026-10-15" }], splits: [{ job: "A|TN", batches: [1, 3] }],
      queueEdited: true,
    });
    const again = withKnobs(inputs, reality, k);
    expect(again).toEqual({ ok: true, scenario: built.scenario });
  });

  it("leaves out a hold or a split that no longer does anything", () => {
    const sc = { ...reality, holds: { "Z|TN": "2026-10-15", "B|CF": "2026-10-16" }, splits: { "A|TN": [2, 3], "B|CF": [1, 3] } };
    expect(knobsOfScenario(sc, inputs)).toMatchObject({ holds: [{ job: "B|CF", untilISO: "2026-10-16" }], splits: [{ job: "B|CF", batches: [1, 3] }], queueEdited: false });
  });
});

describe("optimizeQueueWithin", () => {
  it("is the optimiser itself with time to finish, and stops at its limit with an order no worse than the due dates", () => {
    const tight = { ...inputs, jobs: [job("A|TN", { dueISO: "2026-10-30" }), job("B|CF", { dueISO: "2026-10-13" })] };
    expect(optimizeQueueWithin(tight, defaultScenario(tight), Infinity)).toEqual({ queue: optimizeQueue(tight, defaultScenario(tight)), complete: true });
    let t = 0;
    const r = optimizeQueueWithin(tight, defaultScenario(tight), 10, () => (t += 100));
    expect(r.complete).toBe(false);
    expect(r.queue).toEqual(["A|TN", "B|CF"]);
  });
});

describe("names and days", () => {
  it("keeps a name to one line of 60 characters, and a day to a real one", () => {
    expect(scenarioName("  Two  more\nwelders ")).toBe("Two more welders");
    expect(scenarioName("x".repeat(80))).toHaveLength(60);
    expect(isDayISO("2026-10-12")).toBe(true);
    expect(isDayISO("2026-02-29")).toBe(false);
    expect(isDayISO("12/10/2026")).toBe(false);
  });
});
