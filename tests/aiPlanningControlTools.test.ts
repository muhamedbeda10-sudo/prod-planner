import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's planning-control tools: each reads the live model through
// the app's loaders and hands the model computed figures with the inputs and
// assumptions behind them — the LV line refused, missing data named.

const h = vi.hoisted(() => ({
  getWhatIfInputs: vi.fn(),
  getStdData: vi.fn(),
  control: { getControlInputs: vi.fn(), getReleaseFacts: vi.fn(), getStationFlows: vi.fn(), getStationStops: vi.fn() },
  prisma: { masterOrder: { findMany: vi.fn() }, planSchedule: { aggregate: vi.fn() } },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: () => true }));
vi.mock("@/lib/server/whatif", () => ({ getWhatIfInputs: h.getWhatIfInputs }));
vi.mock("@/lib/server/standardTimes", () => ({ getStdData: h.getStdData }));
vi.mock("@/lib/server/planningControl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/planningControl")>("@/lib/server/planningControl");
  return { ...actual, ...h.control };
});

import type { User } from "@prisma/client";
import type { WhatIfInputs, WhatIfJob } from "@/lib/domain/whatif";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import {
  checkReleaseReadinessTool, getDelayParetoTool, getDispatchListTool, getIoReportTool, getLoadProfileTool, identifyBottleneckTool, simulateRushOrderTool,
} from "@/lib/server/ai/tools/planningControl";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const job = (id: string, o: Partial<WhatIfJob> = {}): WhatIfJob => ({
  id, mo: id.split("|")[0], bom: "B1", item: id.split("|")[1], dueISO: "2026-10-29",
  left: { cut: 0, weld: 10, finish: 10 }, perPc: { cut: 1, weld: 2, finish: 1 }, baselineDays: 4, blockedBy: null, ...o,
});
const inputs: WhatIfInputs = {
  todayISO: "2026-10-27", holidayISOs: [], rates: { cut: 20, weld: 20, finish: 20 }, rateSigma: { cut: 0, weld: 0, finish: 0 }, rateWindowDays: 14,
  capacity: { Cut: 30, Welding: 30, ShotBlast: 10, Painting: 10 }, plan: null,
  jobs: [job("A|TN"), job("B|TC", { dueISO: "2026-10-20", baselineDays: 6, left: { cut: 5, weld: 10, finish: 10 } })],
  coverage: { openOrders: 3, heldOrders: 1, pendingQuantityOrders: 0, missingTimes: [{ mo: "C", bom: "B2", item: "CB" }], unpricedPlanPieces: 0, totalPlanPieces: 0 },
};
const ctx: ToolCtx = { user: { id: 1, name: "Sara" } as User, hidden: new Set(), now: new Date("2026-10-27T08:00:00Z"), todayISO: "2026-10-27", conversationId: 1, automationId: null };
const lv: ToolCtx = { ...ctx, line: "LV" };
const json = (r: { text: string }) => JSON.parse(r.text);

beforeEach(() => {
  vi.clearAllMocks();
  h.getWhatIfInputs.mockResolvedValue(inputs);
  h.control.getControlInputs.mockResolvedValue({ inputs, priorityMos: new Set(["A"]), urgentMos: new Set(), running: { cut: new Set(), weld: new Set(["A|TN"]), finish: new Set() } });
  h.control.getStationStops.mockResolvedValue([]);
  h.control.getStationFlows.mockImplementation(async (weeks: { fromISO: string; toISO: string; workingDays: number }[]) => {
    const rows = (cut: boolean) => weeks.map((w) => ({ ...w, plannedInput: cut ? null : 100, actualInput: cut ? null : 60, plannedOutput: 100, actualOutput: 90 }));
    return { flows: { cut: rows(true), weld: rows(false), finish: rows(false) }, unpricedPcs: 0 };
  });
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.planSchedule.aggregate.mockResolvedValue({ _max: { ovenDate: null } });
});

describe("the planning-control tools", () => {
  it("are read tools every person with the screens gets, closed with their screen", () => {
    const names = toolsFor(ctx.user, { hidden: new Set(), actionsPaused: true }).map((t) => t.name);
    for (const n of ["get_dispatch_list", "get_load_profile", "get_io_report", "identify_bottleneck", "get_delay_pareto", "check_release_readiness", "simulate_rush_order"]) expect(names).toContain(n);
    expect(toolsFor(ctx.user, { hidden: new Set(["dashboard"]), actionsPaused: true }).map((t) => t.name)).not.toContain("get_dispatch_list");
  });

  it("refuse the LV line unless TR is asked for", async () => {
    for (const [tool, input] of [[getDispatchListTool, { stage: "weld" }], [getLoadProfileTool, {}], [getIoReportTool, { stage: "weld" }], [identifyBottleneckTool, {}], [checkReleaseReadinessTool, { mo: "A" }], [simulateRushOrderTool, { kva: "1000", qty: 2, by: "2026-11-30" }]] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (tool as any).run(input, lv);
      expect(r).toMatchObject({ ok: false, text: expect.stringContaining("transformers (TR) only") });
    }
    expect((await getLoadProfileTool.run({ line: "TR" }, lv)).ok).toBe(true);
  });

  it("dispatch list: the running job first, CR and slack with the formulas and inputs behind them", async () => {
    const j = json(await getDispatchListTool.run({ stage: "weld" }, ctx));
    expect(j.scope).toMatchObject({ rule: "CR", station: "Welding" });
    expect(j.rows[0]).toMatchObject({ id: "A|TN", running: true, priority: true });
    expect(j.rows[1]).toMatchObject({ id: "B|TC", status: "late", action: "Expedite now", pcsArrived: 5 });
    expect(j.inputs_used).toMatchObject({ todayISO: "2026-10-27", rateWindowDays: 14 });
    expect(j.formulas.criticalRatio).toContain("forecast");
    expect(j.coverage).toMatchObject({ unpricedComponents: 1, heldOrdersLeftOut: 1 });
    expect(j.assumptions.length).toBeGreaterThan(3);
  });

  it("dispatch list for named orders, at each job's station, saying which are not in the model", async () => {
    const j = json(await getDispatchListTool.run({ mos: ["b", "Z"] }, ctx));
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0]).toMatchObject({ id: "B|TC", station: "cut" });
    expect(j.notInModel.mos).toEqual(["Z"]);
    // the rule asked for orders them, the running job first
    const edd = json(await getDispatchListTool.run({ mos: ["A", "B"], rule: "EDD" }, ctx));
    expect(edd.rows.map((r: { id: string }) => r.id)).toEqual(["A|TN", "B|TC"]);
    expect(edd.scope.rule).toBe("EDD");
    expect(checkToolInput(getDispatchListTool, {})).toEqual({ ok: false, error: expect.stringContaining("Give a stage") });
    expect(checkToolInput(getDispatchListTool, { stage: "weld", rule: "FCFS" }).ok).toBe(false);
  });

  it("a load against no working hours reads as beyond capacity, not as no figure", async () => {
    // a Friday: the current week has no working day left
    h.getWhatIfInputs.mockResolvedValue({ ...inputs, todayISO: "2026-10-30" });
    const j = json(await getLoadProfileTool.run({ weeks: 1, stage: "weld" }, { ...ctx, todayISO: "2026-10-30" }));
    expect(j.stations[0].weeks[0]).toMatchObject({ workingDays: 0, loadPct: expect.stringContaining("beyond capacity"), status: "overloaded" });
  });

  it("load profile lists overloaded weeks with the bands", async () => {
    const j = json(await getLoadProfileTool.run({ weeks: 2, stage: "finish" }, ctx));
    expect(j.stations).toHaveLength(1);
    expect(j.stations[0].weeks[0]).toMatchObject({ loadH: 20, availableH: 60, loadPct: 33.3, status: "ok" });
    expect(j.formulas.bands.overloaded).toBe("> 100%");
  });

  it("I/O report reads the flow back from today's queue and diagnoses it", async () => {
    const j = json(await getIoReportTool.run({ stage: "weld" }, ctx));
    expect(j.weeks).toHaveLength(4);
    expect(j.diagnosis).toBe("upstream");
    expect(j.inputs_used.queueNowStdH).toBe(30); // A 10 pcs × 2 h + B (10 − 5) × 2 h
    expect(j.weeks[3].backlogEnd).toBe(30);
    const cut = json(await getIoReportTool.run({ stage: "cut" }, ctx));
    expect(cut.note).toContain("not recorded");
  });

  it("bottleneck names the station with the most days of work, with its evidence", async () => {
    h.control.getStationStops.mockResolvedValue([{ stage: "weld", dept: "Welding", reasonCode: "MECH", reason: null, hours: 3, machine: "W1" }, { stage: "weld", dept: "Welding", reasonCode: "PM", reason: null, hours: 5, machine: "W1" }]);
    const j = json(await identifyBottleneckTool.run({}, ctx));
    expect(j.constraint).toMatchObject({ stage: "weld", openH: 40, daysOfWork: 2, lostH: 3 });
    expect(j.evidence[0]).toContain("Welding");
    // the stops are the Shifts screen's — not read for whoever it is closed to
    h.control.getStationStops.mockClear();
    const closed = json(await identifyBottleneckTool.run({}, { ...ctx, hidden: new Set(["shifts"]) }));
    expect(h.control.getStationStops).not.toHaveBeenCalled();
    expect(closed.constraint.lostH).toBe(0);
    expect(closed.scope.stopsFrom).toContain("not opened");
  });

  it("delay Pareto: unplanned causes with running shares, maintenance apart, holds listed", async () => {
    h.control.getStationStops.mockResolvedValue([
      { stage: "cut", dept: "Cut", reasonCode: "MECH", reason: null, hours: 6, machine: "L1" },
      { stage: "cut", dept: "Cut", reasonCode: "MATERIAL", reason: null, hours: 2, machine: "L2" },
      { stage: "weld", dept: "Welding", reasonCode: "PM", reason: null, hours: 4, machine: "W1" },
    ]);
    h.prisma.masterOrder.findMany.mockResolvedValue([{ mo: "H1", holdNote: "Drawing", holdAt: new Date("2026-10-20T00:00:00Z") }]);
    const j = json(await getDelayParetoTool.run({}, ctx));
    expect(j.scope).toMatchObject({ fromISO: "2026-09-28", toISO: "2026-10-27" });
    expect(j.pareto.map((c: { code: string; cumShare: number }) => [c.code, c.cumShare])).toEqual([["MECH", 0.75], ["MATERIAL", 1]]);
    expect(j.plannedMaintenanceH).toBe(4);
    expect(j.ordersOnHold).toEqual([{ mo: "H1", since: "2026-10-20", reason: "Drawing" }]);
    expect(await getDelayParetoTool.run({ from: "2026-10-10", to: "2026-10-01" }, ctx)).toMatchObject({ ok: false });
    // to is today when left out — a future from, or more than a year, is refused
    expect(await getDelayParetoTool.run({ from: "2027-01-01" }, ctx)).toMatchObject({ ok: false });
    expect(await getDelayParetoTool.run({ from: "2020-01-01" }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("a year") });
  });

  it("release readiness: unknown order, and a clean order still needs its stock checked", async () => {
    h.control.getReleaseFacts.mockResolvedValue(null);
    expect(json(await checkReleaseReadinessTool.run({ mo: "Q" }, ctx))).toMatchObject({ verdict: "not_ready" });
    h.control.getReleaseFacts.mockResolvedValue({ order: { status: "open", holdAt: null, holdNote: null, pendingPlanQty: null, bom: "B1", kva: "1000", planQty: 10 }, row: null, nesting: { lines: 2, nested: 2 }, alreadyStarted: false });
    const j = json(await checkReleaseReadinessTool.run({ mo: "A" }, ctx));
    expect(j.verdict).toBe("ready_with_checks");
    expect(j.checks.find((c: { check: string }) => c.check === "Material stock").status).toBe("unknown");
    expect(j.checks.find((c: { check: string }) => c.check === "Due date").detail).toContain("2026-10-29");
    // the nesting is the Material screen's
    const closed = json(await checkReleaseReadinessTool.run({ mo: "A" }, { ...ctx, hidden: new Set(["material"]) }));
    expect(closed.checks.some((c: { check: string }) => c.check === "Nesting / drawings")).toBe(false);
    expect(closed.nestingNotChecked).toContain("Material");
  });

  it("rush order: priced by its class, or the missing standard times named", async () => {
    h.getStdData.mockResolvedValue({ tiers: { 1000: { cut: 4, weld: 8, shb: 2, paint: 2 } }, fgMap: {}, centre: {} });
    const j = json(await simulateRushOrderTool.run({ kva: "1000", qty: 2, by: "2026-12-30" }, ctx));
    expect(j.scope.order).toMatchObject({ kvaClass: 1000, qty: 2, items: ["CF", "TC", "TN", "CB"] });
    expect(j.atDuePosition.feasible).toBe(true);
    expect(j.inputs_used.newOrderStdH.weld).toBeGreaterThan(0);
    h.getStdData.mockResolvedValue({ tiers: {}, fgMap: {}, centre: {} });
    expect(json(await simulateRushOrderTool.run({ kva: "1000", qty: 2, by: "2026-12-30" }, ctx))).toMatchObject({ insufficientData: true });
    expect(await simulateRushOrderTool.run({ kva: "1000", qty: 2, by: "2026-10-01" }, ctx)).toMatchObject({ ok: false });
  });
});
