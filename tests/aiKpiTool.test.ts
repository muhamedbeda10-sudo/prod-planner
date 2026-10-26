import { describe, it, expect, vi } from "vitest";

// ---- the assistant reads the cockpit through the very loader the page uses ----

const h = vi.hoisted(() => ({ getCockpit: vi.fn(), getFloorPeriod: vi.fn(), getLvPlanning: vi.fn(), getLvFloorPeriod: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/kpis", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/kpis")>()), getCockpit: h.getCockpit, getFloorPeriod: h.getFloorPeriod }));
vi.mock("@/lib/server/lvKpis", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/lvKpis")>()), getLvPlanning: h.getLvPlanning, getLvFloorPeriod: h.getLvFloorPeriod }));

import { getFloorPerformanceTool, getKpisTool } from "@/lib/server/ai/tools/kpis";

const stat = (o = {}) => ({ centre: "Welding", days: 4, workedH: 100, earnedH: 90, efficiency: 0.9, downtimeH: 2, availability: null, people: 12, ...o });

// the cockpit as the page gets it from getCockpit
const cockpit = {
  todayISO: "2026-10-25", lastDayISO: "2026-10-24",
  week: { planNo: 43, req: 280, covered: 28, days: [{ iso: "2026-10-22", label: "Thu", req: 45, covered: 9, isPast: true, isToday: false }], adherence: [{ stage: "finish", due: 90, done: 18, rate: 0.2 }], late: [{ dayISO: "2026-10-22", bom: "B1", soi: null, item: "TN", stage: "weld", short: 2, owed: 6 }], lateCount: 29 },
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
    expect(h.getCockpit).toHaveBeenCalledWith(now);
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
    expect(out.links).toEqual([{ label: "Planning dashboard (TR)", href: "/?line=TR" }]);
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
      week: { planNo: 43, req: 0, covered: 0, days: [], adherence: [], late, lateCount: late.length },
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
    // the app is on the panels, so the panels' link needs no line
    expect(out.links).toEqual([{ label: "Planning dashboard (LV)", href: "/?line=LV" }]);
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
    expect(j.plant.peopleShortFromToday).toMatchObject({ TR: 3, LV: 1, total: 4 });
    expect(j.decisions[0]).toBe("TR bad: 29 plan line(s) are behind");
    expect(j.decisions).toContain("LV bad: October 2026's plan is behind its pace");
    expect(j.plant.notes.join(" ")).toContain("Pieces are never added across the lines");
    expect((out.links ?? []).map((l) => l.href)).toEqual(["/?line=all", "/?line=TR", "/?line=LV"]);
  });
  it("links the transformers' planning by name when the app is on the panels", async () => {
    h.getCockpit.mockResolvedValue(cockpit);
    const out = await getKpisTool.run({ line: "TR" }, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), line: "LV" } as never);
    expect(JSON.parse(out.text).line).toBe("TR");
    expect(out.links).toEqual([{ label: "Planning dashboard (TR)", href: "/?line=TR" }]);
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
  };

  it("reads the period and department asked for, through the page's own loader, with a link to that view", async () => {
    h.getFloorPeriod.mockResolvedValue(period);
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getFloorPerformanceTool.run({ from: "2026-10-01", dept: "Welding" }, { now, hidden: new Set() } as never);
    expect(h.getFloorPeriod).toHaveBeenCalledWith(expect.objectContaining({ fromISO: "2026-10-01", toISO: "2026-10-25", dept: "Welding" }), now);
    const j = JSON.parse(out.text);
    expect(j).toMatchObject({ from: "2026-10-01", to: "2026-10-25", dept: "Welding", recordedDays: 1, periodAdjusted: false });
    expect(j.trend[0]).toEqual({ day: "2026-10-24", efficiency: 0.91, rolling7: 0.91, stdHPerPersonDay: 7.6 });
    expect(j.dailyOutput[0]).toMatchObject({ weldingH: 91.2, efficiency: 0.91 });
    expect(j.losses.byCause[0]).toEqual({ cause: "Breakdown", planned: false, hours: 2, stops: 1, share: 1 });
    expect(j.summary).toMatchObject({ efficiency: 0.91, stdHPerPersonDay: 7.6, attendance: 0.92 });
    expect(j.departments[0]).toMatchObject({ dept: "Welding", pieces: 30, piecesPerPersonDay: 2.5 });
    // a day without booked hours is left out of a centre's days
    expect(j.centres[0].days).toEqual([{ day: "2026-10-24", efficiency: 0.91, earnedH: 91.2, bookedH: 100 }]);
    expect(out.links).toEqual([{ label: "Production dashboard (TR)", href: "/dashboards/production?line=TR&from=2026-10-01&to=2026-10-25&dept=Welding" }]);
  });

  it("falls back to the last 7 days and every department on a bad or missing input, and links to the section without pinning its dates", async () => {
    h.getFloorPeriod.mockResolvedValue({ ...period, fromISO: "2026-10-19", dept: "all" });
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getFloorPerformanceTool.run({ from: "soon", dept: "Cutting" }, { now, hidden: new Set() } as never);
    expect(h.getFloorPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ fromISO: "2026-10-19", toISO: "2026-10-25", dept: "all", isDefault: true }), now);
    expect(out.links).toEqual([{ label: "Production dashboard (TR)", href: "/dashboards/production?line=TR" }]);
  });

  it("reads the panels' side on the LV line (or when asked), through the panels' own loader, and says what is not the panels'", async () => {
    h.getLvFloorPeriod.mockResolvedValue({ ...lvPeriod, dept: "WeldingLV" });
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getFloorPerformanceTool.run({ dept: "Welding" }, { now, hidden: new Set(), line: "LV" } as never);
    expect(h.getLvFloorPeriod).toHaveBeenCalledWith(expect.objectContaining({ fromISO: "2026-10-19", toISO: "2026-10-25", dept: "WeldingLV" }), now);
    const j = JSON.parse(out.text);
    expect(j).toMatchObject({ line: "LV", summary: { efficiency: 0.5 }, departments: [{ dept: "WeldingLV", panels: 5 }], panelsMovedPerStage: { Welding: 5 } });
    expect(j.notAvailable.join(" ")).toContain("Machine stops");
    // every link names its line, so it opens the same view whatever line the reader's screens are on
    expect(out.links).toEqual([{ label: "Production dashboard (LV)", href: "/dashboards/production?line=LV&dept=WeldingLV" }]);
    // asked for the transformers while the app is on the panels
    h.getFloorPeriod.mockResolvedValue(period);
    const tr = await getFloorPerformanceTool.run({ line: "TR" }, { now, hidden: new Set(), line: "LV" } as never);
    expect(tr.links).toEqual([{ label: "Production dashboard (TR)", href: "/dashboards/production?line=TR&dept=Welding" }]);
  });

  it("combines the whole plant from the sums, never the mean of the two rates, with the stops counted once", async () => {
    h.getFloorPeriod.mockResolvedValue(period);
    h.getLvFloorPeriod.mockResolvedValue(lvPeriod);
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getFloorPerformanceTool.run({ line: "all", dept: "Welding" }, { now, hidden: new Set() } as never);
    // the department asked for is read on each line under its own name
    expect(h.getFloorPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ dept: "Welding" }), now);
    expect(h.getLvFloorPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ dept: "WeldingLV" }), now);
    const j = JSON.parse(out.text);
    expect(j.line).toBe("all");
    expect(j.dept).toMatchObject({ asked: "Welding", TR: "Welding", LV: "all" });
    // 91.2 + 25 over 100 + 50 — not (0.912 + 0.5) / 2
    expect(j.plant).toMatchObject({ efficiency: 0.77, earnedH: 116.2, bookedH: 150, machineStops: { unplannedH: 2 } });
    expect(j.transformers.line).toBe("TR");
    expect(j.lvPanels.line).toBe("LV");
    expect(j.interventions).toEqual(["TR bad: 1 machine is still stopped", "LV warn: Welding (LV) worked at 50% of the standard"]);
    expect(j.plant.notes.join(" ")).toContain("never the mean");
    expect(out.links?.[0]).toEqual({ label: "Production dashboard (whole plant)", href: "/dashboards/production?line=all" });
  });

  it("carries the transformers' machines and quality", async () => {
    h.getFloorPeriod.mockResolvedValue(period);
    const j = JSON.parse((await getFloorPerformanceTool.run({ from: "2026-10-01", dept: "Welding" }, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set() } as never)).text);
    expect(j.machines.stoppedNow[0]).toMatchObject({ machine: "B4-10", hours: 3 });
    expect(j.quality.tanks.leakTestFirstPass).toMatchObject({ units: 8, passed: 6, rate: 0.75 });
    expect(j.daysWithDisagreeingRecords).toEqual([{ dateISO: "2026-10-22", kind: "output-no-hours" }]);
    expect(j.interventions).toEqual(["bad: 1 machine is still stopped"]);
  });

  it("is closed with the Shifts screen", () => {
    expect(getFloorPerformanceTool.tabs).toEqual(["shifts"]);
  });
});
