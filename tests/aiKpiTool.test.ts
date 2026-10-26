import { describe, it, expect, vi } from "vitest";

// ---- the assistant reads the cockpit through the very loader the page uses ----

const h = vi.hoisted(() => ({ getCockpit: vi.fn(), getFloorPeriod: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/kpis", () => ({ getCockpit: h.getCockpit, getFloorPeriod: h.getFloorPeriod }));

import { getFloorPerformanceTool, getKpisTool } from "@/lib/server/ai/tools/kpis";

const stat = (o = {}) => ({ centre: "Welding", days: 4, workedH: 100, earnedH: 90, efficiency: 0.9, downtimeH: 2, availability: null, people: 12, ...o });

describe("get_kpis", () => {
  it("hands the model the cockpit's own figures, rounded, with a link to the page", async () => {
    h.getCockpit.mockResolvedValue({
      todayISO: "2026-10-25", lastDayISO: "2026-10-24",
      week: { planNo: 43, req: 280, covered: 28, days: [{ iso: "2026-10-22", label: "Thu", req: 45, covered: 9, isPast: true, isToday: false }], adherence: [{ stage: "finish", due: 90, done: 18, rate: 0.2 }], late: [{ dayISO: "2026-10-22", bom: "B1", soi: null, item: "TN", stage: "weld", short: 2, owed: 6 }], lateCount: 29 },
      centres: [{ centre: "Welding", last: stat({ efficiency: 0.5333 }), recent: stat(), trend: [{ dateISO: "2026-10-24", earnedH: 90, workedH: 100, efficiency: 0.9 }] }],
      fabrication: { workedH: 300, earnedH: 240, efficiency: 0.8 },
      load: [{ centre: "Welding", measured: true, days: [{ dayISO: "2026-10-25", dueH: 40, capacityH: 30, tone: "bad" }], loadRate: 0.734, behindH: 256.1, shortFromISO: "2026-10-25", clearsISO: "2026-11-02", shortH: 0 }],
      coverage: { wipH: 306.2, ratePerDay: 137.9, days: 2.2, band: "ok", byItem: [] },
      manpower: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, hoursPerPersonDay: 8, pieces: 120, rows: [{ centre: "Welding", requiredH: 4000, doneH: 3000, leftH: 1000, needed: 20, neededNow: 25, present: 22, gap: -3, tone: "bad" }] },
      losses: { causes: [], unplannedH: 6.5, plannedH: 4, absentRate: 0.1111, overtimeH: 126, fromISO: "2026-10-18" },
      pricedShare: 1,
      actions: [{ tone: "bad", text: "29 plan line(s) are behind", href: "/tracker?view=weekly" }, { tone: "warn", text: "No material cost 6 machine hours", href: "/shifts", floor: true }],
      snapshot: { late: 29, adherence: {}, coverageDays: 2.2, efficiency: {}, unplannedH: 6.5 },
      trend: [{ dateISO: "2026-10-25", late: 29, adherence: { finish: 0.2 }, coverageDays: 2.2, efficiency: { Welding: 0.8999 }, unplannedH: 6.5 }],
    });
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
    expect(out.links).toEqual([{ label: "Planning dashboard", href: "/" }]);
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
      pricedShare: null, actions: [], snapshot: { late: 23, adherence: {}, coverageDays: 0, efficiency: {}, unplannedH: 0 }, trend: [],
    });
    const j = JSON.parse((await getKpisTool.run({}, { now: new Date(), hidden: new Set() } as never)).text);
    expect(j.weeklyPlan.behindCount).toBe(23);
    expect(j.weeklyPlan.behind).toHaveLength(20);
    expect(j.weeklyPlan.behind[0]).toMatchObject({ day: "2026-10-01", bom: "B0", stuckAt: "weld" });
    expect(j.weeklyPlan.behind[19].bom).toBe("B19");
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
    pricedShare: 1,
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
    expect(out.links).toEqual([{ label: "Production dashboard", href: "/dashboards/production?from=2026-10-01&to=2026-10-25&dept=Welding" }]);
  });

  it("falls back to the last 7 days and every department on a bad or missing input, and links to the section without pinning its dates", async () => {
    h.getFloorPeriod.mockResolvedValue({ ...period, fromISO: "2026-10-19", dept: "all" });
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getFloorPerformanceTool.run({ from: "soon", dept: "Cutting" }, { now, hidden: new Set() } as never);
    expect(h.getFloorPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ fromISO: "2026-10-19", toISO: "2026-10-25", dept: "all", isDefault: true }), now);
    expect(out.links).toEqual([{ label: "Production dashboard", href: "/dashboards/production" }]);
  });

  it("gives no link on the LV line, where the home page is the panels' dashboard", async () => {
    h.getFloorPeriod.mockResolvedValue(period);
    const out = await getFloorPerformanceTool.run({}, { now: new Date("2026-10-25T08:00:00Z"), hidden: new Set(), line: "LV" } as never);
    expect(out.links).toEqual([]);
  });

  it("is closed with the Shifts screen", () => {
    expect(getFloorPerformanceTool.tabs).toEqual(["dashboard", "shifts"]);
  });
});
