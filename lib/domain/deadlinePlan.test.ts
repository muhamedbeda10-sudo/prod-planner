import { describe, expect, it } from "vitest";
import { defaultScenario, simulate, type WhatIfInputs, type WhatIfJob } from "./whatif";
import { deadlineScore, describePlan, planForDeadlines } from "./deadlinePlan";

// Mon 2026-08-03 as "today"; Fridays are off. Welding is the slow station.
const job = (over: Partial<WhatIfJob> & { id: string }): WhatIfJob => ({
  mo: over.id.split("|")[0],
  bom: `B-${over.id}`,
  item: over.id.split("|")[1] ?? "TC",
  dueISO: null,
  left: { cut: 1, weld: 1, finish: 1 },
  perPc: { cut: 50, weld: 200, finish: 50 },
  baselineDays: null,
  blockedBy: null,
  ...over,
});

const inputs = (jobs: WhatIfJob[]): WhatIfInputs => ({
  todayISO: "2026-08-03",
  holidayISOs: [],
  rates: { cut: 100, weld: 50, finish: 100 },
  rateSigma: { cut: 0, weld: 0, finish: 0 },
  rateWindowDays: 14,
  capacity: { Cut: 200, Welding: 100, ShotBlast: 40, Painting: 160 },
  jobs,
  plan: null,
});

// a fake clock: the search never runs out of time in a test
const clock = () => 0;

describe("deadlineScore", () => {
  it("counts the orders past their day, and the days, by order", () => {
    const i = inputs([job({ id: "A|TC", dueISO: "2026-08-04" }), job({ id: "B|TC", dueISO: "2026-12-01" }), job({ id: "C|TC" })]);
    const s = deadlineScore(simulate(i, defaultScenario(i)), null);
    expect(s.late).toBe(1);
    expect(s.lateDays).toBeGreaterThan(0);
    // an order with no due day has no deadline to meet
    expect(s.orders.map((o) => o.mo)).toEqual(["A", "B"]);
    expect(deadlineScore(simulate(i, defaultScenario(i)), new Set(["B"])).late).toBe(0);
  });
});

describe("planForDeadlines", () => {
  it("adds welders — the slow station — until the late order makes its day", () => {
    const i = inputs([job({ id: "A|TC", dueISO: "2026-08-06" })]);
    const p = planForDeadlines(i, defaultScenario(i), { now: clock });
    expect(p.before.late).toBe(1);
    expect(p.met).toBe(true);
    expect(p.after.late).toBe(0);
    expect(p.steps.length).toBeGreaterThan(0);
    expect(p.steps.every((s) => s.kind === "queue" || s.stage === "Welding" || s.kind === "fridays")).toBe(true);
    expect(p.scenario.workersDelta.Welding).toBeGreaterThan(0);
    // the shift is never a lever — it prices only added workers in the model
    expect(p.scenario.shiftHours).toBe(11);
    expect(p.costMhWeek).toBeGreaterThan(0);
    expect(describePlan(p)).toMatch(/^1 late order back on time with: /);
  });

  it("first tries what costs nothing — the order of the jobs", () => {
    // B is due first but queued last; swapping saves it with no one added
    const i = inputs([job({ id: "A|TC", dueISO: "2026-09-30" }), job({ id: "B|TC", dueISO: "2026-08-10" })]);
    const p = planForDeadlines(i, defaultScenario(i), { now: clock });
    expect(p.before.late).toBe(1);
    expect(p.steps[0]).toMatchObject({ kind: "queue", costMhWeek: 0 });
    expect(p.met).toBe(true);
    expect(p.costMhWeek).toBe(0);
    expect(describePlan(p)).toMatch(/at no extra cost/);
  });

  it("works only for the orders named", () => {
    const i = inputs([job({ id: "A|TC", dueISO: "2026-08-04" }), job({ id: "B|TC", dueISO: "2026-12-01" })]);
    const p = planForDeadlines(i, defaultScenario(i), { mos: ["B"], now: clock });
    expect(p.before.late).toBe(0);
    expect(p.steps).toEqual([]);
    expect(describePlan(p)).toBe("Nothing is late — every order makes its due day as things stand.");
  });

  it("says when the knobs cannot save it, and keeps within the limits it is given", () => {
    // due yesterday: no crew makes yesterday
    const i = inputs([job({ id: "A|TC", dueISO: "2026-08-02" })]);
    const p = planForDeadlines(i, defaultScenario(i), { now: clock, allowFridays: false });
    expect(p.met).toBe(false);
    expect(p.scenario.workFridays).toBe(false);
    expect(p.scenario.shiftHours).toBe(11);
    expect(describePlan(p)).toMatch(/need more than the knobs give|None of the changes tried/);
  });

  it("stops when its time is up, never worse than where it started", () => {
    let t = 0;
    const i = inputs([job({ id: "A|TC", dueISO: "2026-08-06" })]);
    const p = planForDeadlines(i, defaultScenario(i), { now: () => (t += 10_000), budgetMs: 1 });
    expect(p.complete).toBe(false);
    expect(p.after.late).toBeLessThanOrEqual(p.before.late);
  });
});
