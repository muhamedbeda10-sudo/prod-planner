import { describe, expect, it } from "vitest";
import { applySimulationStress, compareSimulations, simulationMetrics, simulationReadiness, stressSimulations } from "./simulationReview";
import { defaultScenario, simulate, type WhatIfInputs, type WhatIfJob } from "./whatif";
import { kpisOf, withKnobs } from "./whatifScenario";

const job = (id: string, extra: Partial<WhatIfJob> = {}): WhatIfJob => ({ id, mo: id.split("|")[0], bom: "B", item: id.split("|")[1], dueISO: "2026-08-05", left: { cut: 1, weld: 1, finish: 1 }, perPc: { cut: 100, weld: 50, finish: 100 }, baselineDays: 99, blockedBy: null, ...extra });
const input = (): WhatIfInputs => ({ todayISO: "2026-08-03", holidayISOs: [], rates: { cut: 100, weld: 50, finish: 100 }, rateSigma: { cut: 0, weld: 0, finish: 0 }, rateWindowDays: 14, capacity: { Cut: 200, Welding: 100, ShotBlast: 40, Painting: 160 }, jobs: [job("A|TC"), job("B|TC")], plan: { planNo: 1, minISO: "2026-08-03", maxISO: "2026-08-08", requiredByStage: { Cut: 600, Welding: 550, ShotBlast: 100, Painting: 400 } }, coverage: { openOrders: 2, heldOrders: 0, pendingQuantityOrders: 0, missingTimes: [], unpricedPlanPieces: 0, totalPlanPieces: 2 } });

describe("simulation decision metrics", () => {
  it("recomputes the baseline instead of trusting stored job deltas and keeps inputs untouched", () => {
    const i = input(), before = structuredClone(i);
    const scenario = defaultScenario(i);
    const result = compareSimulations(i, [{ label: "Same", scenario }]);
    expect(result.baseline).toMatchObject({ orders: 2, lateOrders: 1, onTimeOrders: 1, blockedOrders: 0, totalLateCalendarDays: 1, allClearISO: "2026-08-06" });
    expect(result.variants[0].delta).toEqual({ lateOrders: 0, blockedOrders: 0, totalLateCalendarDays: 0, allClearCalendarDays: 0 });
    expect(result.variants[0].changedOrdersCount).toBe(0);
    expect(i).toEqual(before);
  });
  it("compares workers in man-hours and captures the literal date improvement", () => {
    const i = input();
    const built = withKnobs(i, defaultScenario(i), { workersDelta: { Welding: 10, Painting: 20 }, shiftHours: 10 });
    if (!built.ok) throw Error(built.error);
    const row = compareSimulations(i, [{ label: "Crew", scenario: built.scenario }]).variants[0];
    expect(row.metrics).toMatchObject({ lateOrders: 0, onTimeOrders: 2, addedManHoursPerWorkingDay: 300, allClearISO: "2026-08-05" });
    expect(row.delta.allClearCalendarDays).toBe(-1);
    expect(row.changedOrders).toContainEqual(expect.objectContaining({ mo: "B", beforeISO: "2026-08-06", afterISO: "2026-08-05", deltaCalendarDays: -1 }));
  });
  it("folds split batches and multiple components into one order", () => {
    const i = input(); i.jobs = [job("A|TC", { left: { cut: 2, weld: 2, finish: 2 } }), job("A|TN")];
    const built = withKnobs(i, defaultScenario(i), { splits: [{ job: "A|TC", batches: [1, 1] }] });
    if (!built.ok) throw Error(built.error);
    const result = simulate(i, built.scenario);
    expect(result.jobs).toHaveLength(3);
    expect(simulationMetrics(result, built.scenario).orders).toBe(1);
  });
  it("does not count undated or blocked orders as on time or claim all clear", () => {
    const i = input(); i.jobs[0].dueISO = null; i.rates.weld = 0;
    const metrics = simulationMetrics(simulate(i, defaultScenario(i)), defaultScenario(i));
    expect(metrics).toMatchObject({ orders: 2, blockedOrders: 2, onTimeOrders: 0, lateOrders: 0, undatedOrders: 1, allClearISO: null });
    expect(kpisOf(simulate(i, defaultScenario(i)))).toMatchObject({ active: 2, onTime: 0, blocked: 2, undated: 1, lastEta: null });
    expect(simulationReadiness(i).status).toBe("blocked");
  });
  it("does not treat an unpriced or empty queue as full factory coverage", () => {
    const i = input(); i.jobs = []; i.coverage!.missingTimes = [{ mo: "NO-TIME", bom: "B", item: "TN" }]; i.coverage!.unpricedPlanPieces = 15;
    const review = simulationReadiness(i);
    expect(review.status).toBe("blocked");
    expect(review.issues.map((r) => r.code)).toEqual(expect.arrayContaining(["empty-queue", "missing-standard-times", "unpriced-plan"]));
    expect(review.assumptions.join(" ")).toContain("Material readiness is not verified");
  });
  it("lists capacity, due date, hold and quantity gaps without inventing confidence", () => {
    const i = input(); delete i.capacity.Welding; i.jobs[0].dueISO = null; i.coverage!.heldOrders = 2; i.coverage!.pendingQuantityOrders = 1;
    const review = simulationReadiness(i);
    expect(review.status).toBe("review");
    expect(review.issues.map((r) => r.code)).toEqual(expect.arrayContaining(["capacity-Welding", "missing-due-dates", "held-orders", "pending-quantities"]));
    expect(review).not.toHaveProperty("confidence");
  });
});
describe("independent stress cases", () => {
  it("adds worker losses and preserves existing later holds and station constraints", () => {
    const i = input(), s = defaultScenario(i);
    s.workersDelta.Welding = 2; s.holds["A|TC"] = "2026-08-10"; s.downtimes = [{ stage: "cut", fromISO: "2026-08-04", toISO: "2026-08-04" }];
    const before = structuredClone(s);
    const applied = applySimulationStress(i, s, { label: "Disruption", workersDelta: { Welding: -1 }, holds: [{ job: "A|TC", untilISO: "2026-08-06" }], downtimes: [{ stage: "weld", fromISO: "2026-08-05", toISO: "2026-08-05" }] });
    expect(applied).toMatchObject({ ok: true, scenario: { workersDelta: { Welding: 1 }, holds: { "A|TC": "2026-08-10" }, downtimes: expect.arrayContaining(before.downtimes) } });
    if (applied.ok) expect(applied.scenario.downtimes).toHaveLength(2);
    expect(s).toEqual(before);
  });
  it("runs disruptions independently and counts affected MOs", () => {
    const i = input();
    const stress = { label: "One-day outage", downtimes: [{ stage: "cut" as const, fromISO: "2026-08-03", toISO: "2026-08-03" }] };
    const r = stressSimulations(i, [], [stress, { ...stress, label: "Same outage again" }]);
    expect(r.rows[0].trials[0].metrics).toEqual(r.rows[0].trials[1].metrics);
    expect(r.rows[0].trials[0].delayedOrdersCount).toBe(2);
    expect(r.rows[0].trials[0].metrics?.allClearISO).toBe("2026-08-08"); // Friday is off
    expect(r.ranking).toEqual(["Plant baseline"]);
  });
  it("withholds ranking for undated orders, missing times or invalid stress references", () => {
    const i = input(); i.jobs[0].dueISO = null;
    const valid = [{ label: "Absence", workersDelta: { Welding: -1 } }];
    expect(stressSimulations(i, [], valid).ranking).toEqual([]);
    const unknown = input(); delete unknown.coverage;
    expect(stressSimulations(unknown, [], valid).ranking).toEqual([]);
    const noCapacity = input(); delete noCapacity.capacity.Welding;
    expect(stressSimulations(noCapacity, [], valid).ranking).toEqual([]);
    i.jobs[0].dueISO = "2026-08-05"; i.coverage!.missingTimes = [{ mo: "OTHER", bom: "B", item: "TN" }];
    expect(stressSimulations(i, [], valid).ranking).toEqual([]);
    i.coverage!.missingTimes = [];
    const invalid = stressSimulations(i, [], [{ label: "Unknown", holds: [{ job: "X|TN", untilISO: "2026-08-10" }] }]);
    expect(invalid.rows[0].worst).toBeNull(); expect(invalid.ranking).toEqual([]);
  });
  it("does not reward a scenario that blocks work by reducing its apparent late count", () => {
    const i = input(), s = defaultScenario(i); s.workersDelta.Welding = -10; s.shiftHours = 10;
    const r = stressSimulations(i, [{ label: "No welders", scenario: s }], [{ label: "Cut outage", downtimes: [{ stage: "cut", fromISO: "2026-08-03", toISO: "2026-08-03" }] }]);
    expect(r.rows[1].worst?.blockedOrders).toBe(2);
    expect(r.ranking[0]).toBe("Plant baseline");
  });
});
