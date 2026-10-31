import { describe, it, expect, vi } from "vitest";

// ---- the assistant reads the cockpit through the very loader the page uses ----

const h = vi.hoisted(() => ({ getCockpit: vi.fn(), getFloorPeriod: vi.fn(), getLvPlanning: vi.fn(), getLvFloorPeriod: vi.fn(), loadProduction: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/kpis", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/kpis")>()), getCockpit: h.getCockpit, getFloorPeriod: h.getFloorPeriod }));
vi.mock("@/lib/server/lvKpis", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/lvKpis")>()), getLvPlanning: h.getLvPlanning, getLvFloorPeriod: h.getLvFloorPeriod }));
vi.mock("@/lib/server/productionDashboard", () => ({ loadProductionDashboard: h.loadProduction, loadProductionFigures: h.loadProduction }));

import { explainEfficiencyTool, getFloorPerformanceTool, getKpisTool } from "@/lib/server/ai/tools/kpis";
import { linesOf, productionView, type LineFacts, type ProductionRequest } from "@/lib/domain/productionDashboard";
import { mergeActions } from "@/lib/domain/plantKpis";

const stat = (o = {}) => ({ centre: "Welding", days: 4, workedH: 100, earnedH: 90, efficiency: 0.9, downtimeH: 2, availability: null, people: 12, ...o });

// the cockpit as the page gets it from getCockpit
const cockpit = {
  todayISO: "2026-10-25", lastDayISO: "2026-10-24",
  week: { planNo: 43, req: 280, covered: 28, days: [{ iso: "2026-10-22", label: "Thu", req: 45, covered: 9, isPast: true, isToday: false }], adherence: [{ stage: "finish", due: 90, done: 18, rate: 0.2 }], late: [{ dayISO: "2026-10-22", bom: "B1", soi: null, item: "TN", stage: "weld", short: 2, owed: 6 }], lateCount: 29, planNos: [43, 42], newest: true, lines: [] },
  leads: { cut: 4, weld: 1 }, horizonDays: 10,
  centres: [{ centre: "Welding", last: stat({ efficiency: 0.5333 }), recent: stat(), trend: [{ dateISO: "2026-10-24", earnedH: 90, workedH: 100, efficiency: 0.9 }] }],
  fabrication: { workedH: 300, earnedH: 240, efficiency: 0.8 },
  load: [{ centre: "Welding", measured: true, days: [{ dayISO: "2026-10-25", dueH: 40, capacityH: 30, tone: "bad" }], loadRate: 0.734, behindH: 256.1, shortFromISO: "2026-10-25", clearsISO: "2026-11-02", shortH: 0 }],
  coverage: { wipH: 306.2, ratePerDay: 137.9, days: 2.2, band: "ok", byItem: [] },
  manpower: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, hoursPerPersonDay: 8, pieces: 120, rows: [{ centre: "Welding", requiredH: 4000, doneH: 3000, leftH: 1000, needed: 20, neededNow: 25, present: 22, gap: -3, tone: "bad" }] },
  losses: { causes: [], unplannedH: 6.5, plannedH: 4, absentRate: 0.1111, overtimeH: 126, fromISO: "2026-10-18" },
  pricedShare: 1,
  wip: { cutNotWelded: [{ item: "TN", pcs: 12 }], weldedNotFinished: [{ item: "TN", pcs: 4 }], returnsOpen: { count: 1, qty: 2 }, held: { orders: 1, pieces: 6 } },
  actions: [{ tone: "bad", text: "29 plan line(s) are behind", href: "/tracker?view=weekly" }, { tone: "warn", text: "No material cost 6 machine hours", href: "/shifts", floor: true }],
  snapshot: { late: 29, adherence: {}, coverageDays: 2.2, efficiency: {}, unplannedH: 6.5 },
  trend: [{ dateISO: "2026-10-25", late: 29, adherence: { finish: 0.2 }, coverageDays: 2.2, efficiency: { Welding: 0.8999 }, unplannedH: 6.5 }],
};

describe("get_kpis", () => {
  it("hands the model the cockpit's own figures, rounded, with a link to the page", async () => {
    h.getCockpit.mockResolvedValue(cockpit);
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getKpisTool.run({}, { now, hidden: new Set() } as never);
    expect(h.getCockpit).toHaveBeenCalledWith(now, { planNo: null });
    const j = JSON.parse(out.text);
    expect(j.decisions).toEqual(["bad: 29 plan line(s) are behind", "warn: No material cost 6 machine hours"]);
    expect(j.weeklyPlan).toMatchObject({ planNo: 43, behindCount: 29, adherence: [{ stage: "finish", rate: 0.2 }] });
    expect(j.centres[0].lastDay.efficiency).toBe(0.53);
    expect(j.loadAhead[0]).toMatchObject({ centre: "Welding", measured: true, loadRate: 0.73, behindH: 256.1, clears: "2026-11-02", shortAtEndH: 0, days: [{ day: "2026-10-25", dueH: 40, capacityH: 30 }] });
    expect(j.fabrication).toEqual({ earnedH: 240, workedH: 300, efficiency: 0.8 });
    expect(j.monthPace[0]).toMatchObject({ centre: "Welding", planH: 4000, doneH: 3000, doneShare: 0.75, evenPaceShare: 0.8 });
    expect(j.dailyOutput[0]).toMatchObject({ day: "2026-10-24", weldingH: 90, earnedH: 90, bookedH: 100, efficiency: 0.9 });
    expect(j.weekChange.linesBehind).toBeNull();
    expect(j.manpower).toMatchObject({ month: "October 2026", workingDaysLeft: 5, centres: [{ centre: "Welding", peopleNeeded: 20, peopleNeededFromToday: 25, peoplePresent: 22, gap: -3 }] });
    expect(j.losses).toMatchObject({ unplannedH: 6.5, absentRate: 0.11, overtimeH: 126 });
    expect(j.trend[0]).toMatchObject({ day: "2026-10-25", behind: 29, efficiency: { Welding: 0.9 } });
    expect(j.workBetweenStages).toMatchObject({ cutNotWelded: [{ item: "TN", pcs: 12 }], returnsOpen: { count: 1, qty: 2 } });
    expect(out.links).toEqual([{ label: "Dashboard (transformers)", href: "/?scope=tr" }]);
  });

  it("leaves the shift log's figures out for a person the Shifts screen is closed to", async () => {
    const out = await getKpisTool.run({}, { now: new Date(), hidden: new Set(["shifts"]) } as never);
    const j = JSON.parse(out.text);
    expect(j.centres).toBeUndefined();
    expect(j.losses).toBeUndefined();
    expect(j.fabrication).toBeUndefined();
    expect(j.trend[0].efficiency).toBeUndefined();
    expect(j.dailyOutput).toBeUndefined();
    expect(Object.keys(j.weekChange)).toEqual(["planDeliveredOnItsDay", "linesBehind", "weldingCoverageDays"]);
    expect(j.manpower.centres[0]).toEqual({ centre: "Welding", requiredH: 4000, doneH: 3000, leftH: 1000, peopleNeeded: 20, peopleNeededFromToday: 25 });
    expect(j.decisions).toEqual(["bad: 29 plan line(s) are behind"]);
    expect(j.weeklyPlan.behindCount).toBe(29);
  });

  it("hands the model the oldest 20 lines behind and the count of them all", async () => {
    const late = Array.from({ length: 23 }, (_, i) => ({ dayISO: `2026-10-${String(i + 1).padStart(2, "0")}`, bom: `B${i}`, soi: null, item: "TN", stage: "weld", short: 1, owed: 1 }));
    h.getCockpit.mockResolvedValue({
      todayISO: "2026-10-25", lastDayISO: null,
      week: { planNo: 43, req: 0, covered: 0, days: [], adherence: [], late, lateCount: late.length, planNos: [43], newest: true, lines: [] },
      leads: { cut: 4, weld: 1 }, horizonDays: 10,
      centres: [], fabrication: { workedH: 0, earnedH: 0, efficiency: null }, load: [], coverage: { wipH: 0, ratePerDay: 0, days: 0, band: "ok", byItem: [] },
      manpower: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, hoursPerPersonDay: 8, pieces: 0, rows: [] },
      losses: { causes: [], unplannedH: 0, plannedH: 0, absentRate: null, overtimeH: 0, fromISO: null },
      pricedShare: null, wip: { cutNotWelded: [], weldedNotFinished: [], returnsOpen: { count: 0, qty: 0 }, held: { orders: 0, pieces: 0 } }, actions: [], snapshot: { late: 23, adherence: {}, coverageDays: 0, efficiency: {}, unplannedH: 0 }, trend: [],
    });
    const j = JSON.parse((await getKpisTool.run({}, { now: new Date(), hidden: new Set() } as never)).text);
    expect(j.weeklyPlan.behindCount).toBe(23);
    expect(j.weeklyPlan.behind).toHaveLength(20);
    expect(j.weeklyPlan.behind[0]).toMatchObject({ day: "2026-10-01", bom: "B0", stuckAt: "weld" });
    expect(j.weeklyPlan.behind[19].bom).toBe("B19");
  });
});

describe("get_kpis on the panels and the plant", () => {
  const lv = {
    todayISO: "2026-10-25", lastDayISO: "2026-10-24",
    month: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, orders: 3, panels: 30, complete: 18, remaining: 12, byStage: [{ stage: "Punching", required: 30, done: 30 }, { stage: "Painting", required: 30, done: 18 }], pace: { centre: "panels", requiredH: 30, doneH: 18, doneShare: 0.6, expectedShare: 0.8, aheadH: -6, tone: "bad" } },
    open: { orders: 3, panels: 30, urgent: 1, onHold: 0 },
    wip: { notStarted: 0, waitingBend: 2, waitingWeld: 3, waitingPaint: 7, waitingDelivery: 5, onHold: 0, orders: 3, heldOrders: 0 },
    urgentStuck: [{ mo: "WH/MO/9", bom: "LSS-2", product: "LSS", remaining: 4, stage: "Welding" }],
    manpower: { hoursPerPersonDay: 8, rows: [{ centre: "WeldingLV", requiredH: 120, doneH: 60, doneBeforeH: 0, leftH: 60, needed: 0.6, neededNow: 1.5, present: 0.5, gap: -1, tone: "bad" }], coverage: { orders: 3, priced: 2, panels: 30, pricedPanels: 20 } },
    depts: [{ dept: "WeldingLV", days: 4, efficiency: 0.5, workedH: 100, earnedH: 50, people: 3 }],
    actions: [{ tone: "bad", text: "October 2026's plan is behind its pace", href: "/tracker" }],
    orders: [], family: null,
    days: { days: [{ dateISO: "2026-10-24", byStage: { Punching: 2, Bending: 0, Welding: 1, Painting: 0, Delivered: 0 } }], fromISO: "2026-10-11", toISO: "2026-10-25", ranged: false, clamped: false, period: {}, month: {}, monthLabel: "October 2026", open: { orders: 3, panels: 30, byStage: {}, urgent: 1 } },
  };
  it("reads the panels' own month, chain and people when the app is on LV, and says what the panels have no figure for", async () => {
    h.getLvPlanning.mockResolvedValue(lv);
    const out = await getKpisTool.run({}, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), line: "LV" } as never);
    const j = JSON.parse(out.text);
    expect(j.line).toBe("LV");
    expect(j.month).toMatchObject({ month: "October 2026", painted: 18, panelsPlanned: 30, doneShare: 0.6, evenPaceShare: 0.8, tone: "bad" });
    expect(j.workBetweenStages).toMatchObject({ waitingPaint: 7, waitingDelivery: 5 });
    expect(j.urgentOrdersShort[0]).toMatchObject({ mo: "WH/MO/9", stage: "Welding" });
    expect(j.manpower.coverage).toEqual({ orders: 3, priced: 2, panels: 30, pricedPanels: 20 });
    expect(j.manpower.departments[0]).toMatchObject({ dept: "WeldingLV", peoplePresent: 0.5, gap: -1 });
    expect(j.notAvailable.join(" ")).toContain("no delivery dates");
    // the link opens the page on the panels
    expect(out.links).toEqual([{ label: "Dashboard (LV panels)", href: "/?scope=lv" }]);
    // the shift log's figures leave with the Shifts screen
    const closed = JSON.parse((await getKpisTool.run({ line: "LV" }, { now: new Date(), hidden: new Set(["shifts"]) } as never)).text);
    expect(closed.departmentsRecent).toBeUndefined();
    expect(closed.manpower.departments[0]).toEqual({ dept: "WeldingLV", requiredH: 120, doneH: 60, leftH: 60, peopleNeeded: 0.6, peopleNeededFromToday: 1.5 });
  });
  it("puts the two lines side by side under all, the plant's efficiency from the sums and the decisions tagged by line", async () => {
    h.getCockpit.mockResolvedValue(cockpit);
    h.getLvPlanning.mockResolvedValue(lv);
    const out = await getKpisTool.run({ line: "all" }, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set() } as never);
    const j = JSON.parse(out.text);
    expect(j.line).toBe("all");
    expect(j.transformers.line).toBe("TR");
    expect(j.lvPanels.line).toBe("LV");
    // the cockpit's one centre recent 90/100 and the panels' 50/100: 140/200, not (0.9 + 0.5) / 2
    expect(j.plant.efficiencyRecentDays).toMatchObject({ TR: 0.9, LV: 0.5, plant: 0.7 });
    expect(j.plant.peopleToAddFromToday).toMatchObject({ TR: 3, LV: 1, total: 4 });
    expect(j.plant.stdHoursLeftThisMonth).toMatchObject({ TR: 1000, LV: 60, total: 1060 });
    expect(j.decisions[0]).toBe("TR bad: 29 plan line(s) are behind");
    expect(j.decisions).toContain("LV bad: October 2026's plan is behind its pace");
    expect(j.plant.notes.join(" ")).toContain("Pieces are never added across the lines");
    expect(out.links).toEqual([{ label: "Dashboard (whole plant)", href: "/" }]);
  });
  it("reads the line asked for whatever line the app is on", async () => {
    h.getCockpit.mockResolvedValue(cockpit);
    const out = await getKpisTool.run({ line: "TR" }, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), line: "LV" } as never);
    expect(JSON.parse(out.text).line).toBe("TR");
    expect(out.links).toEqual([{ label: "Dashboard (transformers)", href: "/?scope=tr" }]);
  });
  it("reads both lines when the person is on a dashboard and the question names none — the page shows both", async () => {
    h.getCockpit.mockResolvedValue(cockpit);
    h.getLvPlanning.mockResolvedValue(lv);
    const onPlanning = await getKpisTool.run({}, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), line: "LV", page: { path: "/", filters: {} } } as never);
    expect(JSON.parse(onPlanning.text).line).toBe("all");
    // the Planning page's own scope and filters, as the person has them on screen
    h.getLvPlanning.mockClear();
    const onPanels = await getKpisTool.run({}, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), page: { path: "/", filters: { scope: "lv", family: "mb" } } } as never);
    expect(JSON.parse(onPanels.text).line).toBe("LV");
    expect(h.getLvPlanning).toHaveBeenCalledWith({ family: "MB" }, expect.any(Date));
    const onPlan = await getKpisTool.run({}, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), page: { path: "/", filters: { scope: "tr", plan: "42", centre: "Welding" } } } as never);
    const tr = JSON.parse(onPlan.text);
    expect(h.getCockpit).toHaveBeenLastCalledWith(expect.any(Date), { planNo: 42 });
    expect(tr.filters).toMatchObject({ workCentre: "Welding" });
    expect(onPlan.links).toEqual([{ label: "Dashboard (transformers)", href: "/?scope=tr&plan=42&centre=Welding" }]);
    // elsewhere, the line the app is on
    const onTracker = await getKpisTool.run({}, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), line: "LV", page: { path: "/tracker", filters: {} } } as never);
    expect(JSON.parse(onTracker.text).line).toBe("LV");
  });
});

describe("get_floor_performance", () => {
  const period = {
    fromISO: "2026-10-01", toISO: "2026-10-25", dept: "Welding", clamped: false, window: 7, dates: ["2026-10-24"],
    grid: [{ centre: "Welding", total: 0.9123, days: 1, cells: [{ dateISO: "2026-10-23", workedH: 0, earnedH: 0, efficiency: null }, { dateISO: "2026-10-24", workedH: 100, earnedH: 91.2, efficiency: 0.912 }] }],
    summary: { days: 1, workedH: 100, earnedH: 91.2, efficiency: 0.912, personDays: 12, people: 12, stdPerPersonDay: 7.6, overtimeH: 4, overtimeShare: 0.04, attendance: 0.9231, downtimeH: 2, availability: 0.95 },
    groups: [{ group: "Welding", days: 1, workedH: 100, earnedH: 91.2, efficiency: 0.912, personDays: 12, people: 12, stdPerPersonDay: 7.6, overtimeH: 4, overtimeShare: 0.04, attendance: 0.9231, downtimeH: 2, availability: 0.95, pieces: 30, piecesPerPersonDay: 2.5 }],
    trend: [{ dateISO: "2026-10-24", workedH: 100, earnedH: 91.2, efficiency: 0.912, rolling: 0.912, stdPerPersonDay: 7.6 }],
    output: [{ dateISO: "2026-10-24", Fabrication: 0, Welding: 91.2, ShotBlast: 0, Painting: 0, earnedH: 91.2, workedH: 100, efficiency: 0.912 }],
    losses: { causes: [{ code: "MECH", label: "Breakdown", hours: 2, stops: 1, share: 1, planned: false }], unplannedH: 2, plannedH: 0 },
    stops: { open: [{ machine: "B4-10", dept: "Cut", cause: "Breakdown", hours: 3, sinceISO: "2026-10-25" }], byMachine: [{ machine: "B4-10", dept: "Cut", hours: 2, stops: 1, share: 1 }] },
    gapDays: [{ dateISO: "2026-10-22", kind: "output-no-hours" }],
    pricedShare: 1,
    quality: { fromISO: "2026-10-01", toISO: "2026-10-25", tankTracking: true, tanks: { waitingTest: 3, inRepair: 1, readyToPaint: 2, weldedInPeriod: 10, paintedInPeriod: 8, firstPass: { units: 8, passed: 6, rate: 0.75 }, weldToTest: { n: 8, medianDays: 2, maxDays: 5 }, testToPaint: { n: 8, medianDays: 3, maxDays: 9 } }, returns: { open: { count: 1, qty: 2 }, filed: { count: 2, qty: 3 }, openOnUrgent: 0, byReason: [] }, returnsByWeek: [] },
    actions: [{ tone: "bad", text: "1 machine is still stopped", href: "/shifts", floor: true }],
    byType: {
      monthLabel: "October 2026",
      groups: [{
        item: "Tank",
        total: { item: "Tank", type: "All types", made: { cut: 12, weld: 8, finish: 5 }, plan: { required: 40, done: { cut: 30, weld: 22, finish: 15 }, left: 25, share: 0.375 } },
        types: [
          { item: "Tank", type: "630 kVA", made: { cut: 10, weld: 8, finish: 5 }, plan: { required: 30, done: { cut: 25, weld: 20, finish: 15 }, left: 15, share: 0.5 } },
          { item: "Tank", type: "1000 kVA", made: { cut: 2, weld: 0, finish: 0 }, plan: { required: 10, done: { cut: 5, weld: 2, finish: 0 }, left: 10, share: 0 } },
        ],
      }],
    },
  };
  const lvPeriod = {
    fromISO: "2026-10-01", toISO: "2026-10-25", dept: "all", clamped: false, window: 7, dates: ["2026-10-24"],
    grid: [{ centre: "WeldingLV", total: 0.5, days: 1, cells: [{ dateISO: "2026-10-24", workedH: 50, earnedH: 25, efficiency: 0.5 }] }],
    summary: { days: 1, workedH: 50, earnedH: 25, efficiency: 0.5, personDays: 6, people: 6, stdPerPersonDay: 4.17, overtimeH: 0, overtimeShare: 0, attendance: 1, downtimeH: 0, availability: null },
    groups: [{ dept: "WeldingLV", days: 1, workedH: 50, earnedH: 25, efficiency: 0.5, personDays: 6, people: 6, stdPerPersonDay: 4.17, overtimeH: 0, overtimeShare: 0, attendance: 1, downtimeH: 0, availability: null, panels: 5, panelsPerPersonDay: 0.83 }],
    trend: [{ dateISO: "2026-10-24", workedH: 50, earnedH: 25, efficiency: 0.5, rolling: 0.5, stdPerPersonDay: 4.17 }],
    output: [{ dateISO: "2026-10-24", byDept: { Punching: 0, Bending: 0, WeldingLV: 25, PaintingLV: 0 }, earnedH: 25, workedH: 50, efficiency: 0.5 }],
    moved: { Punching: 0, Bending: 0, Welding: 5, Painting: 0 },
    pricedShare: 1, gapDays: [],
    actions: [{ tone: "warn", text: "Welding (LV) worked at 50% of the standard", href: "/shifts", floor: true }],
    byType: {
      monthLabel: "October 2026",
      groups: [{
        item: "LV panels",
        total: { item: "LV panels", type: "All types", made: { Punching: 0, Bending: 0, Welding: 5, Painting: 0 }, plan: null },
        types: [{ item: "LV panels", type: "USS", made: { Punching: 0, Bending: 0, Welding: 5, Painting: 0 }, plan: null }],
      }],
    },
  };

  // the dashboard's own loader, answering with the line periods the request reads and the page's figures
  const facts: LineFacts[] = [{
    line: "TR", trackingSinceISO: "2026-10-01", lastRecordISO: "2026-10-24", volume: [],
    days: [{ line: "TR", dept: "Welding", unit: "Welding", dateISO: "2026-10-24", workedH: 100, earnedH: 91.2, people: 12, overtimeH: 4, rows: 13, absent: 1, absentH: 8, day: { people: 12, hours: 100, overtimeH: 4 }, night: { people: 0, hours: 0, overtimeH: 0 }, machineH: 0, downtimeH: 0, stops: {}, notSet: 0 }],
  }];
  const answer = (o: { failed?: ("TR" | "LV")[] } = {}) => async (req: ProductionRequest) => {
    const lines = linesOf(req.scope);
    const tr = lines.includes("TR") ? { ...period, dept: req.trDept } : null;
    const lv = lines.includes("LV") ? { ...lvPeriod, dept: req.lvDept } : null;
    return {
      req, todayISO: "2026-10-25", failed: o.failed ?? [], before: null,
      view: productionView(req, facts.filter((f) => lines.includes(f.line)), null, { todayISO: "2026-10-25", holidays: new Set() }),
      tr, lv, actions: mergeActions((tr?.actions ?? []) as never, (lv?.actions ?? []) as never),
    };
  };
  const now = new Date("2026-10-25T08:00:00Z");

  it("reads the period and department asked for, through the page's own loader, with a link to that view", async () => {
    h.loadProduction.mockImplementation(answer());
    const out = await getFloorPerformanceTool.run({ from: "2026-10-01", dept: "Welding" }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ fromISO: "2026-10-01", toISO: "2026-10-25", scope: "TR", trDept: "Welding" }), now);
    const j = JSON.parse(out.text);
    expect(j).toMatchObject({ line: "TR", from: "2026-10-01", to: "2026-10-25", dept: "Welding", recordedDays: 1, periodAdjusted: false });
    expect(j.trend[0]).toEqual({ day: "2026-10-24", efficiency: 0.91, rolling7: 0.91, stdHPerPersonDay: 7.6 });
    expect(j.losses.byCause[0]).toEqual({ cause: "Breakdown", planned: false, hours: 2, stops: 1, share: 1 });
    expect(j.departments[0]).toMatchObject({ dept: "Welding", pieces: 30, piecesPerPersonDay: 2.5 });
    expect(j.centres[0].days).toEqual([{ day: "2026-10-24", efficiency: 0.91, earnedH: 91.2, bookedH: 100 }]);
    // the page's own tiles, table and coverage
    expect(j.dashboard.showing).toBe("Welding (TR)");
    expect(j.dashboard.tiles.find((t: { figure: string }) => t.figure === "efficiency")).toEqual({ figure: "efficiency", value: 0.91, before: null, change: "N/A" });
    expect(j.dashboard.departments[0]).toMatchObject({ dept: "Welding", bookedH: 100, earnedH: 91.2 });
    expect(j.dashboard.notAvailable.join(" ")).toContain("by shift");
    expect(out.links).toEqual([{ label: "Dashboard · Production (Welding (TR))", href: "/?from=2026-10-01&to=2026-10-25&dept=Welding" }]);
  });

  it("falls back to the last 7 days and every department on a bad or missing input, and links without pinning its dates", async () => {
    h.loadProduction.mockImplementation(answer());
    const out = await getFloorPerformanceTool.run({ from: "soon", dept: "Cutting", line: "TR" }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ fromISO: "2026-10-19", toISO: "2026-10-25", scope: "TR", trDept: "all", isDefault: true }), now);
    expect(out.links).toEqual([{ label: "Dashboard · Production (Transformers)", href: "/?scope=tr" }]);
  });

  it("reads the panels' side on the LV line (or when asked), and says what is not the panels'", async () => {
    h.loadProduction.mockImplementation(answer());
    const out = await getFloorPerformanceTool.run({ dept: "WeldingLV" }, { now, hidden: new Set(), line: "LV" } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "LV", lvDept: "WeldingLV" }), now);
    const j = JSON.parse(out.text);
    expect(j).toMatchObject({ line: "LV", summary: { efficiency: 0.5 }, departments: [{ dept: "WeldingLV", panels: 5 }], panelsMovedPerStage: { Welding: 5 } });
    expect(j.notAvailable.join(" ")).toContain("Machine stops");
    expect(out.links).toEqual([{ label: "Dashboard · Production (Welding (LV))", href: "/?dept=WeldingLV" }]);
  });

  it("reads the whole plant from the page's sums, the stops counted once, both lines' interventions tagged", async () => {
    h.loadProduction.mockImplementation(answer());
    const out = await getFloorPerformanceTool.run({ line: "all" }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all", trDept: "all", lvDept: "all" }), now);
    const j = JSON.parse(out.text);
    expect(j.line).toBe("all");
    expect(j.dashboard.showing).toBe("The whole plant");
    expect(j.plant.machineStops).toMatchObject({ unplannedH: 2 });
    expect(j.transformers.line).toBe("TR");
    expect(j.lvPanels.line).toBe("LV");
    expect(j.interventions).toEqual(["TR bad: 1 machine is still stopped", "LV warn: Welding (LV) worked at 50% of the standard"]);
    expect(j.plant.notes.join(" ")).toContain("never the mean");
    expect(out.links).toEqual([{ label: "Dashboard · Production (The whole plant)", href: "/" }]);
  });

  it("lets a department name its line, as the page does, and keeps each line's own under all", async () => {
    h.loadProduction.mockImplementation(answer());
    await getFloorPerformanceTool.run({ line: "all", dept: "Bending" }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "LV", lvDept: "Bending" }), now);
    const out = await getFloorPerformanceTool.run({ line: "all", dept: "Welding", lvDept: "PaintingLV" }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all", trDept: "Welding", lvDept: "PaintingLV" }), now);
    expect(out.links?.[0].href).toBe("/?dept=Welding&lvDept=PaintingLV");
  });

  it("says so when a line fails to load, rather than answering with half the plant", async () => {
    h.loadProduction.mockImplementation(answer({ failed: ["LV"] }));
    const out = await getFloorPerformanceTool.run({ line: "all" }, { now, hidden: new Set() } as never);
    expect(out.ok).toBe(false);
  });

  it("carries the transformers' machines and quality", async () => {
    h.loadProduction.mockImplementation(answer());
    const j = JSON.parse((await getFloorPerformanceTool.run({ from: "2026-10-01", dept: "Welding" }, { now, hidden: new Set() } as never)).text);
    expect(j.machines.stoppedNow[0]).toMatchObject({ machine: "B4-10", hours: 3 });
    expect(j.quality.tanks.leakTestFirstPass).toMatchObject({ units: 8, passed: 6, rate: 0.75 });
    expect(j.daysWithDisagreeingRecords).toEqual([{ dateISO: "2026-10-22", kind: "output-no-hours" }]);
    expect(j.interventions).toEqual(["bad: 1 machine is still stopped"]);
  });

  it("hands the model what was made item by item and type by type, against the month's plan, on both lines", async () => {
    h.loadProduction.mockImplementation(answer());
    const j = JSON.parse((await getFloorPerformanceTool.run({ line: "all" }, { now, hidden: new Set() } as never)).text);
    const tr = j.transformers.byItemAndType;
    expect(tr).toMatchObject({ stages: ["cut", "weld", "finish"], planMonth: "October 2026" });
    expect(tr.items[0]).toMatchObject({ item: "Tank", made: { weld: 8 }, plan: { planned: 40, left: 25, shareDone: 0.38 } });
    expect(tr.items[0].types[0]).toMatchObject({ type: "630 kVA", made: { cut: 10 }, plan: { planned: 30, doneByStage: { finish: 15 }, shareDone: 0.5 } });
    const lv = j.lvPanels.byItemAndType;
    expect(lv.stages).toEqual(["Punching", "Bending", "Welding", "Painting"]);
    expect(lv.items[0].types[0]).toEqual({ type: "USS", made: { Punching: 0, Bending: 0, Welding: 5, Painting: 0 }, plan: null });
  });

  it("explains where the hours went over the page's own choice — a period, or whole days up to yesterday", async () => {
    h.loadProduction.mockImplementation(answer());
    const out = await explainEfficiencyTool.run({ days: 14 }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ fromISO: "2026-10-11", toISO: "2026-10-24", scope: "TR" }), now);
    const j = JSON.parse(out.text);
    expect(j.now).toMatchObject({ workedH: 100, earnedStdH: 91.2, absentH: 8, rosteredH: 104 });
    expect(j.waterfall.map((x: { name: string }) => x.name)).toContain("Unexplained: slower than standard or not logged");
    await explainEfficiencyTool.run({ from: "2026-10-01", to: "2026-10-20", centre: "Fins" }, { now, hidden: new Set() } as never);
    expect(h.loadProduction).toHaveBeenLastCalledWith(expect.objectContaining({ fromISO: "2026-10-01", toISO: "2026-10-20", centre: "Fins", trDept: "Fabrication" }), now);
  });

  it("is closed with the Shifts screen", () => {
    expect(getFloorPerformanceTool.tabs).toEqual(["shifts"]);
  });
});
