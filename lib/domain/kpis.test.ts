import { describe, it, expect } from "vitest";
import {
  burnUp, byStage, centreStat, cockpitActions, combinedStat, dailyOutput, workingDaysFrom, earnedOfRecord, efficiencyBand, inMonthPlan, isFloorAction, lateLines, loadAhead, loadSeries, loadTone,
  manpowerPlan, monthPace, paretoOf, parseKpiSnapshot, weekChange,
  planAdherence, stageDueISO, weldingCoverage, zeroCentres, type CentreDay, type PlanCell,
} from "./kpis";

const per = { ...zeroCentres(), Cutting: 1, Bending: 0.5, Fins: 0.25, Welding: 4, ShotBlast: 0.2, Painting: 0.8 };

describe("what a record earns at each centre", () => {
  it("credits a fabricated piece to every centre of its route", () => {
    const e = earnedOfRecord("Cut", 2, per);
    expect([e.Cutting, e.Bending, e.Fins, e.Welding]).toEqual([2, 1, 0.5, 0]);
  });
  it("credits a painted piece's blast to shot blast, and a shot-blast record to shot blast", () => {
    const paint = earnedOfRecord("Painting", 1, per);
    expect([paint.ShotBlast, paint.Painting]).toEqual([0.2, 0.8]);
    expect(earnedOfRecord("ShotBlast", 3, per).ShotBlast).toBeCloseTo(0.6, 10);
    expect(earnedOfRecord("Delivered", 1, per)).toEqual(zeroCentres());
    expect(earnedOfRecord("Cut", 1, undefined)).toEqual(zeroCentres());
    expect(byStage(earnedOfRecord("Cut", 2, per)).Cut).toBeCloseTo(3.5, 10);
  });
  it("takes a correction's hours back, so +10 then −3 earns what 7 pieces are worth", () => {
    const day = [earnedOfRecord("Welding", 10, per), earnedOfRecord("Welding", -3, per)].reduce((s, e) => s + e.Welding, 0);
    expect(day).toBe(28);
    expect(earnedOfRecord("Welding", Number.NaN, per)).toEqual(zeroCentres());
  });
});

describe("a centre over a window", () => {
  const d = (dateISO: string, o: Partial<CentreDay>): CentreDay => ({ dateISO, centre: "Cutting", workedH: 0, people: 0, earnedH: 0, machineH: 0, downtimeH: 0, ...o });
  it("efficiency is earned ÷ worked over the recorded days; stops on any day count", () => {
    const s = centreStat("Cutting", [
      d("2026-10-10", { workedH: 80, people: 10, earnedH: 72, machineH: 100, downtimeH: 5 }),
      d("2026-10-11", { workedH: 120, people: 14, earnedH: 108, machineH: 100, downtimeH: 15 }),
      d("2026-10-12", { downtimeH: 2 }), // not recorded on the shift log
      d("2026-10-10", { centre: "Welding", workedH: 50, earnedH: 10 }),
    ]);
    expect(s).toMatchObject({ days: 2, workedH: 200, earnedH: 180, downtimeH: 22, people: 12 });
    expect(s.efficiency).toBeCloseTo(0.9, 10);
    expect(s.availability).toBeCloseTo(1 - 22 / 200, 10);
    expect(efficiencyBand(s.efficiency)).toBe("ok");
    // the Shifts page's own bands: 90% on the standard, 70% short of it
    expect(efficiencyBand(0.72)).toBe("warn");
    expect(efficiencyBand(0.5)).toBe("bad");
    expect(efficiencyBand(null)).toBeNull();
    expect(centreStat("Fins", []).efficiency).toBeNull();
  });
  it("adds centres up as one — Fabrication's three", () => {
    const st = (centre: "Cutting" | "Bending", workedH: number, earnedH: number) => ({ centre, days: 3, workedH, earnedH, efficiency: earnedH / workedH, downtimeH: 0, availability: null, people: 2 });
    expect(combinedStat([st("Cutting", 60, 54), st("Bending", 40, 26)])).toEqual({ workedH: 100, earnedH: 80, efficiency: 0.8 });
    expect(combinedStat([]).efficiency).toBeNull();
  });
});

describe("welding coverage", () => {
  it("is the welding hours cut-and-waiting over the welders' recent daily output", () => {
    const c = weldingCoverage([{ item: "TN", pcs: 10, weldH: 120 }, { item: "TC", pcs: 0, weldH: 0 }, { item: "CB", pcs: 6, weldH: 30 }], [50, 0, 70, 60]);
    expect(c).toMatchObject({ wipH: 150, ratePerDay: 60, days: 2.5, band: "ok" });
    expect(c.byItem.map((b) => b.item)).toEqual(["TN", "CB"]);
    expect(weldingCoverage([{ item: "TN", pcs: 1, weldH: 20 }], [60]).band).toBe("short");
    expect(weldingCoverage([{ item: "TN", pcs: 1, weldH: 300 }], [60]).band).toBe("heavy");
    expect(weldingCoverage([{ item: "TN", pcs: 1, weldH: 30 }], []).days).toBeNull();
  });
});

describe("the weekly plan's adherence", () => {
  const leads = { cut: 4, weld: 1 };
  const cell = (dayISO: string, owed: number, cut: number, weld: number, finish: number): PlanCell => ({ dayISO, bom: "B1", item: "TN", owed, done: { cut, weld, finish } });
  it("a stage owes a day's pieces its lead days before the oven date", () => {
    expect(stageDueISO("2026-10-20", "cut", leads)).toBe("2026-10-16");
    expect(stageDueISO("2026-10-20", "weld", leads)).toBe("2026-10-19");
    expect(stageDueISO("2026-10-20", "finish", leads)).toBe("2026-10-20");
  });
  it("counts what each stage has done of what it owed by today, and names the late lines by the stage they are stuck at", () => {
    const cells = [cell("2026-10-18", 10, 10, 8, 6), cell("2026-10-22", 5, 3, 0, 0), cell("2026-10-30", 4, 0, 0, 0)];
    const a = planAdherence(cells, "2026-10-19", leads);
    // cut owes both early days (16th and 18th) — 13 of 15; weld and finish only the 18th
    expect(a.map((s) => [s.stage, s.due, s.done])).toEqual([["cut", 15, 13], ["weld", 10, 8], ["finish", 10, 6]]);
    expect(lateLines(cells, "2026-10-19", leads).map((l) => [l.dayISO, l.stage, l.short])).toEqual([["2026-10-18", "weld", 2], ["2026-10-22", "cut", 2]]);
  });
});

describe("the load ahead", () => {
  it("runs the owed hours against the capacity day by day, overdue work owed on the first day", () => {
    const days = ["2026-10-20", "2026-10-21", "2026-10-22"];
    const l = loadAhead("Welding", days, [{ dayISO: "2026-10-18", dueH: 30 }, { dayISO: "2026-10-20", dueH: 50 }, { dayISO: "2026-10-22", dueH: 40 }], 50);
    expect(l.days.map((d) => d.dueH)).toEqual([80, 0, 40]);
    // 30 h behind on the first day, caught up on the second
    expect(l).toMatchObject({ measured: true, behindH: 30, shortFromISO: "2026-10-20", clearsISO: "2026-10-21", shortH: 0 });
    expect(l.days.map((d) => d.tone)).toEqual(["bad", null, null]);
    expect(l.loadRate).toBeCloseTo(120 / 150, 10);
    // a Friday's hours land on the working day after it; past the horizon they are not its own
    expect(loadAhead("Welding", ["2026-10-22", "2026-10-24"], [{ dayISO: "2026-10-23", dueH: 10 }, { dayISO: "2026-11-30", dueH: 99 }], 50).days.map((d) => d.dueH)).toEqual([0, 10]);
    expect(loadAhead("Welding", days, [{ dayISO: "2026-10-21", dueH: 200 }], 50)).toMatchObject({ shortFromISO: "2026-10-21", clearsISO: null, shortH: 50, behindH: 100 });
  });
  it("names a centre that falls behind mid-horizon and catches up by the end — with the most it fell behind", () => {
    const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-24"];
    const l = loadAhead("Bending", days, [{ dayISO: "2026-10-21", dueH: 200 }], 50);
    expect(l).toMatchObject({ shortFromISO: "2026-10-21", clearsISO: "2026-10-24", shortH: 0, behindH: 100 });
    expect(cockpitActions({ late: [], coverage: { wipH: 0, ratePerDay: 0, days: null, band: null, byItem: [] }, load: [l], centres: [], topLoss: null, todayRecorded: true, ddmm: (iso) => iso })[0].text)
      .toBe("Bending is behind — Bending by up to 100 h from 2026-10-21, caught up by 2026-10-24 at the usual pace.");
  });
  it("reads a measured centre left with no capacity as short from the first day it owes anything", () => {
    expect(loadAhead("ShotBlast", ["2026-10-20", "2026-10-21"], [{ dayISO: "2026-10-21", dueH: 8 }], 0)).toMatchObject({ measured: true, shortFromISO: "2026-10-21", shortH: 8, loadRate: null });
  });
  it("judges nothing for a centre with no booked hours", () => {
    const l = loadAhead("Painting", ["2026-10-20", "2026-10-21"], [{ dayISO: "2026-10-20", dueH: 40 }], null);
    expect(l).toMatchObject({ measured: false, loadRate: null, behindH: 0, shortFromISO: null, shortH: 0 });
    expect(l.days.map((d) => [d.dueH, d.tone])).toEqual([[40, null], [0, null]]);
  });
  it("reads a load as over the capacity, within 10% of it, or clear", () => {
    expect([loadTone(101, 100), loadTone(95, 100), loadTone(80, 100), loadTone(10, 0), loadTone(0, 0)]).toEqual(["bad", "warn", null, "bad", null]);
    // rounding is not a shortfall
    expect(loadTone(100.04, 100)).toBe("warn");
  });
});

describe("working days ahead", () => {
  it("skips Fridays and the calendar's holidays", () => {
    // 2026-10-23 is a Friday
    expect(workingDaysFrom("2026-10-22", 4, new Set(["2026-10-25"]))).toEqual(["2026-10-22", "2026-10-24", "2026-10-26", "2026-10-27"]);
  });
});

describe("what to do today", () => {
  it("lists the late lines, a short centre, thin welding coverage, a slow centre, the top loss and an unrecorded day — worst first", () => {
    const a = cockpitActions({
      late: [{ dayISO: "2026-10-18", bom: "B1", item: "TN", owed: 4, stage: "weld", short: 2 }],
      coverage: { wipH: 10, ratePerDay: 60, days: 0.2, band: "short", byItem: [{ item: "TN", pcs: 1, weldH: 10 }] },
      load: [
        { centre: "Welding", measured: true, days: [], loadRate: 1.2, behindH: 30, shortFromISO: "2026-10-21", clearsISO: null, shortH: 30 },
        { centre: "Bending", measured: true, days: [], loadRate: 0.5, behindH: 12, shortFromISO: "2026-10-20", clearsISO: "2026-10-22", shortH: 0 },
      ],
      centres: [{ centre: "Bending", days: 5, workedH: 100, earnedH: 50, efficiency: 0.5, downtimeH: 0, availability: null, people: 3 }],
      topLoss: { label: "No material", hours: 6 },
      todayRecorded: false,
      ddmm: (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7),
    });
    expect(a.map((x) => x.tone)).toEqual(["bad", "bad", "warn", "bad", "warn", "warn"]);
    expect(a[0].text).toContain("B1 TN due 18/10, is 2 pc short at Welding");
    expect(a[1].text).toContain("Welding owes 30 h more");
    expect(a[2].text).toContain("Bending is behind — Bending by up to 12 h from 20/10, caught up by 22/10");
    expect(a[3].text).toContain("cut TN next");
    // no more than six: the unrecorded day falls off here
    expect(a).toHaveLength(6);
    // the shift log's own — a slow centre, the top loss — are marked for the people who see Shifts
    expect(a.map(isFloorAction)).toEqual([false, false, false, false, true, true]);
  });
});

describe("the top loss in what to do today", () => {
  const top = (hours: number) =>
    cockpitActions({
      late: [], coverage: { wipH: 0, ratePerDay: 0, days: null, band: null, byItem: [] }, load: [], centres: [],
      topLoss: { label: "No material", hours }, todayRecorded: true, ddmm: (iso) => iso,
    });
  it("says the machine time lost in hours and minutes, as the stops are shown", () => {
    expect(top(2.5)).toEqual([{ tone: "warn", href: "/shifts", floor: true, text: "No material cost 2 h 30 min of machine time this week — the biggest loss." }]);
    expect(top(0.75)[0].text).toBe("No material cost 45 min of machine time this week — the biggest loss.");
    expect(top(3)[0].text).toBe("No material cost 3 h of machine time this week — the biggest loss.");
  });
  it("names no loss when nothing was lost", () => {
    expect(top(0)).toEqual([]);
  });
});

describe("the month's manpower", () => {
  const cal = { hoursPerPersonDay: 8, monthWd: 25, leftWd: 10 };
  it("turns the plan's hours into people over the month's working days, and what is left into people from today", () => {
    const [w] = manpowerPlan([{ centre: "Welding", requiredH: 4000, doneH: 2000, present: 20 }], cal);
    // 4000 h over 25 days × 8 h = 20 people; 2000 h left over 10 days × 8 h = 25 people → 5 short
    expect(w).toMatchObject({ requiredH: 4000, doneH: 2000, leftH: 2000, needed: 20, neededNow: 25, present: 20, gap: -5, tone: "bad" });
  });
  it("reads a spare crew as ok, a fraction short as a warning, and judges nothing without people or days", () => {
    const rows = manpowerPlan([
      { centre: "Bending", requiredH: 800, doneH: 800, present: 4 },
      { centre: "Fins", requiredH: 1000, doneH: 736, present: 3 },
      { centre: "Painting", requiredH: 500, doneH: 0, present: null },
    ], cal);
    expect(rows[0]).toMatchObject({ leftH: 0, neededNow: 0, gap: 4, tone: "ok" });
    expect(rows[1]).toMatchObject({ neededNow: 3.3, gap: -0.3, tone: "warn" });
    expect(rows[2]).toMatchObject({ needed: 2.5, neededNow: 6.3, gap: null, tone: null });
    // the month's working days over: nothing is needed "from today"
    expect(manpowerPlan([{ centre: "Welding", requiredH: 100, doneH: 0, present: 2 }], { ...cal, leftWd: 0 })[0]).toMatchObject({ neededNow: null, gap: null });
    // done past the plan never reads as negative hours left
    expect(manpowerPlan([{ centre: "Welding", requiredH: 100, doneH: 150, present: 2 }], cal)[0].leftH).toBe(0);
  });
  it("puts an order on the month's plan when tagged with the month and open, or closed within it", () => {
    const month = "October 2026", start = "2026-10-01";
    expect(inMonthPlan({ months: "September 2026,October 2026", source: null, status: "open", closedDayISO: null }, month, start)).toBe(true);
    expect(inMonthPlan({ months: "", source: "October 2026", status: "open", closedDayISO: null }, month, start)).toBe(true);
    expect(inMonthPlan({ months: "September 2026", source: null, status: "open", closedDayISO: null }, month, start)).toBe(false);
    expect(inMonthPlan({ months: "October 2026", source: null, status: "closed", closedDayISO: "2026-10-03" }, month, start)).toBe(true);
    expect(inMonthPlan({ months: "October 2026", source: null, status: "closed", closedDayISO: "2026-09-30" }, month, start)).toBe(false);
  });
  it("names the centres short of people among the decisions, the shortest first", () => {
    const a = cockpitActions({
      late: [], coverage: { wipH: 0, ratePerDay: 0, days: null, band: null, byItem: [] }, load: [], centres: [], topLoss: null, todayRecorded: true, ddmm: (iso) => iso,
      manpower: manpowerPlan([{ centre: "Welding", requiredH: 4000, doneH: 2000, present: 20 }, { centre: "Fins", requiredH: 1000, doneH: 0, present: 2 }, { centre: "Cutting", requiredH: 100, doneH: 0, present: 5 }], cal),
    });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ tone: "bad", floor: true });
    expect(a[0].text).toBe("Fin folding, Welding are short of people for the month's plan — Fin folding needs 11 more from today to finish it.");
  });
});

describe("the charts' series", () => {
  it("sums the week's plan and what is finished day by day", () => {
    const b = burnUp([
      { iso: "2026-10-22", label: "Thu", req: 10, covered: 8, isToday: false },
      { iso: "2026-10-24", label: "Sat", req: 5, covered: 5, isToday: true },
      { iso: "2026-10-25", label: "Sun", req: 6, covered: 1, isToday: false },
    ]);
    expect(b.map((d) => [d.planCum, d.doneCum])).toEqual([[10, 8], [15, 13], [21, 14]]);
    expect(b[1].isToday).toBe(true);
  });
  it("keeps the running totals unrounded until shown, so a day that is not short never reads as short", () => {
    const l = loadAhead("Welding", ["2026-10-20", "2026-10-21", "2026-10-22"], [{ dayISO: "2026-10-22", dueH: 100 }], 100 / 3);
    expect(loadSeries(l).at(-1)).toMatchObject({ owedCum: 100, canCum: 100, tone: "warn" });
  });
  it("runs a centre's load as what it owes so far against what it could have worked so far", () => {
    const l = loadAhead("Welding", ["2026-10-20", "2026-10-21", "2026-10-22"], [{ dayISO: "2026-10-20", dueH: 80 }, { dayISO: "2026-10-22", dueH: 40 }], 50);
    expect(loadSeries(l).map((d) => [d.owedCum, d.canCum, d.tone])).toEqual([[80, 50, "bad"], [80, 100, null], [120, 150, null]]);
    // no capacity to judge by: the owed line alone
    expect(loadSeries(loadAhead("Painting", ["2026-10-20"], [{ dayISO: "2026-10-20", dueH: 5 }], null))[0]).toMatchObject({ owedCum: 5, canCum: null });
  });
  it("adds a day's output up by department, Fabrication's three centres as one, against the hours booked", () => {
    const out = dailyOutput([
      { centre: "Cutting", trend: [{ dateISO: "2026-10-21", earnedH: 10, workedH: 20 }, { dateISO: "2026-10-20", earnedH: 4, workedH: 8 }] },
      { centre: "Fins", trend: [{ dateISO: "2026-10-21", earnedH: 5, workedH: 5 }] },
      { centre: "Welding", trend: [{ dateISO: "2026-10-21", earnedH: 30, workedH: 25 }] },
    ]);
    expect(out.map((d) => d.dateISO)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(out[1]).toMatchObject({ Fabrication: 15, Welding: 30, ShotBlast: 0, Painting: 0, earnedH: 45, workedH: 50 });
    expect(out[1].efficiency).toBeCloseTo(0.9, 10);
    expect(dailyOutput([{ centre: "Painting", trend: [{ dateISO: "2026-10-20", earnedH: 3, workedH: 0 }] }])[0].efficiency).toBeNull();
  });
  it("sets each centre's month against an even pace through its working days", () => {
    const rows = monthPace([
      { centre: "Welding", requiredH: 1000, doneH: 300 },
      { centre: "Painting", requiredH: 400, doneH: 180 },
      { centre: "Bending", requiredH: 200, doneH: 75 },
      { centre: "Fins", requiredH: 0, doneH: 12 },
    ], { monthWd: 26, leftWd: 13 });
    // half the working days are behind us: an even pace stands at 50%
    expect(rows[0]).toMatchObject({ doneShare: 0.3, expectedShare: 0.5, aheadH: -200, tone: "bad" });
    expect(rows[1]).toMatchObject({ aheadH: -20, tone: "warn" });
    expect(rows[2].tone).toBe("bad");
    expect(rows[3]).toMatchObject({ doneShare: null, tone: null });
    // an order carried over at 60% done starts the month's pace there: half the days gone, 80% is even
    const carried = monthPace([{ centre: "Welding", requiredH: 100, doneH: 60, doneBeforeH: 60 }], { monthWd: 26, leftWd: 13 })[0];
    expect(carried).toMatchObject({ doneShare: 0.6, expectedShare: 0.8, aheadH: -20, tone: "bad" });
    expect(monthPace([{ centre: "Welding", requiredH: 100, doneH: 60, doneBeforeH: 60 }], { monthWd: 26, leftWd: 26 })[0]).toMatchObject({ expectedShare: 0.6, tone: "ok" });
    expect(monthPace([{ centre: "Welding", requiredH: 100, doneH: 100 }], { monthWd: 26, leftWd: 0 })[0]).toMatchObject({ expectedShare: 1, tone: "ok" });
  });
  it("ranks the unplanned stops with the share of the loss the causes above account for", () => {
    const p = paretoOf([
      { code: "NOMAT", label: "No material", hours: 3, stops: 1, planned: false },
      { code: "PM", label: "Planned maintenance", hours: 4, stops: 1, planned: true },
      { code: "MECH", label: "Breakdown", hours: 5, stops: 2, planned: false },
      { code: "AIR", label: "Power or air", hours: 2, stops: 1, planned: false },
    ]);
    expect(p.map((c) => c.code)).toEqual(["MECH", "NOMAT", "AIR"]);
    expect(p.map((c) => Math.round(c.cumShare * 100))).toEqual([50, 80, 100]);
    expect(paretoOf([])).toEqual([]);
  });
  it("finds a figure a week ago — the newest kept day at least seven days back that knows it", () => {
    const pt = (dateISO: string, late: number | null) => ({ dateISO, late, adherence: {}, coverageDays: null, efficiency: {}, fabEfficiency: null, unplannedH: null });
    const trend = [pt("2026-10-15", 30), pt("2026-10-17", 25), pt("2026-10-18", null), pt("2026-10-21", 22), pt("2026-10-25", 29)];
    expect(weekChange(trend, "2026-10-25", (p) => p.late)).toEqual({ now: 29, before: 25, beforeISO: "2026-10-17" });
    expect(weekChange(trend.slice(3), "2026-10-25", (p) => p.late)).toBeNull();
    expect(weekChange(trend, "2026-10-26", (p) => p.late)).toBeNull();
  });
});

describe("the stored trend", () => {
  it("reads a day back, a field an older day lacks as unknown — never zero", () => {
    expect(parseKpiSnapshot({ late: 4, adherence: { cut: 0.5, weld: null, bogus: 1 }, coverageDays: 2.2, efficiency: { Welding: 0.9 }, fabEfficiency: 0.7, unplannedH: 3 }))
      .toEqual({ late: 4, adherence: { cut: 0.5, weld: null }, coverageDays: 2.2, efficiency: { Welding: 0.9 }, fabEfficiency: 0.7, unplannedH: 3 });
    expect(parseKpiSnapshot({ late: 4 })).toEqual({ late: 4, adherence: {}, coverageDays: null, efficiency: {}, fabEfficiency: null, unplannedH: null });
    expect(parseKpiSnapshot(null).late).toBeNull();
  });
});
