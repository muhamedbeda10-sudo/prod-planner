import { describe, expect, it } from "vitest";
import {
  attendanceRows, coverageOf, dailyHours, deltaOf, deptTable, focusRows, heatGrid, hoursFigures, keepDay, performanceGaps, previousPeriod,
  productionRequest, productionView, volumeOf, workingDaysIn, emptyShift, productionSheetRows, productionDayRows, UNEXPLAINED_LABEL,
  type LineFacts, type ProductionRequest, type UnitDay, type VolumeRecord,
} from "./productionDashboard";

const TODAY = "2026-10-26"; // a Monday
const NO_HOLIDAYS = new Set<string>();

function day(p: Partial<UnitDay> & Pick<UnitDay, "dateISO">): UnitDay {
  const workedH = p.workedH ?? 0;
  const people = p.people ?? 0;
  return {
    line: "TR", dept: "Welding", unit: "Welding", earnedH: 0, overtimeH: 0, rows: people, absent: 0, absentH: 0,
    day: { people, hours: workedH, overtimeH: p.overtimeH ?? 0 }, night: emptyShift(),
    machineH: 0, downtimeH: 0, stops: {}, notSet: 0,
    ...p, workedH, people,
  };
}

function vol(p: Partial<VolumeRecord> & Pick<VolumeRecord, "dateISO" | "qty">): VolumeRecord {
  return { line: "TR", stage: "Welding", depts: ["Welding"], component: "Tank", priced: true, ...p };
}

const req = (o: Partial<ProductionRequest> = {}): ProductionRequest => ({
  fromISO: "2026-10-18", toISO: "2026-10-24", clamped: false, isDefault: false,
  scope: "all", trDept: "all", lvDept: "all", centre: null, shift: "both", focus: null, focusDay: null, ...o,
});

const facts = (line: "TR" | "LV", days: UnitDay[], volume: VolumeRecord[] = [], since = "2026-10-01"): LineFacts =>
  ({ line, days, volume, trackingSinceISO: since, lastRecordISO: days.map((d) => d.dateISO).sort().at(-1) ?? null });

describe("hoursFigures", () => {
  it("counts output only on unit-days that booked hours — a production day with no attendance is left out", () => {
    const f = hoursFigures([
      day({ dateISO: "2026-10-20", workedH: 80, earnedH: 60, people: 10 }),
      day({ dateISO: "2026-10-21", workedH: 0, earnedH: 40, people: 0 }), // output, nobody booked
    ]);
    expect(f.earnedH).toBe(60);
    expect(f.workedH).toBe(80);
    expect(f.efficiency).toBeCloseTo(0.75);
    expect(f.days).toBe(1);
  });

  it("weighs two days of different size by their hours, never the mean of their rates", () => {
    const f = hoursFigures([
      day({ dateISO: "2026-10-20", workedH: 100, earnedH: 90, people: 12 }), // 90%
      day({ dateISO: "2026-10-21", workedH: 10, earnedH: 5, people: 1 }), // 50%
    ]);
    expect(f.efficiency).toBeCloseTo(95 / 110);
    expect(f.efficiency).not.toBeCloseTo(0.7);
    expect(f.stdPerPersonDay).toBeCloseTo(95 / 13);
  });

  it("leaves a ratio with no base as null — never a zero or a 100%", () => {
    const f = hoursFigures([day({ dateISO: "2026-10-20", workedH: 0, rows: 0, people: 0 })]);
    expect(f.efficiency).toBeNull();
    expect(f.stdPerPersonDay).toBeNull();
    expect(f.overtimeShare).toBeNull();
    expect(f.attendance).toBeNull();
  });

  it("keeps an efficiency above the standard as it is", () => {
    expect(hoursFigures([day({ dateISO: "2026-10-20", workedH: 40, earnedH: 60, people: 5 })]).efficiency).toBeCloseTo(1.5);
  });

  it("counts a day the whole crew was away in the attendance, not in the hours", () => {
    const f = hoursFigures([
      day({ dateISO: "2026-10-20", workedH: 32, earnedH: 30, people: 4, rows: 4 }),
      day({ dateISO: "2026-10-21", workedH: 0, people: 0, rows: 4, absent: 4, absentH: 32 }),
    ]);
    expect(f.attendance).toBeCloseTo(4 / 8);
    expect(f.workedH).toBe(32);
    expect(f.efficiency).toBeCloseTo(30 / 32);
  });

  it("takes overtime out of the hours booked once — its share of them", () => {
    const f = hoursFigures([day({ dateISO: "2026-10-20", workedH: 90, overtimeH: 10, earnedH: 80, people: 10 })]);
    expect(f.overtimeShare).toBeCloseTo(10 / 90);
  });
});

describe("deltaOf", () => {
  it("is relative for an amount and N/A on a zero or missing base", () => {
    expect(deltaOf(110, 100, "pct")).toEqual({ kind: "pct", value: 10 });
    expect(deltaOf(10, 0, "pct")).toBeNull();
    expect(deltaOf(10, null, "pct")).toBeNull();
    expect(deltaOf(null, 5, "pct")).toBeNull();
  });
  it("is in points for a ratio", () => {
    expect(deltaOf(0.88, 0.8, "pts")).toEqual({ kind: "pts", value: 8 });
    expect(deltaOf(0.8, null, "pts")).toBeNull();
  });
});

describe("productionRequest", () => {
  it("reads the defaults", () => {
    const r = productionRequest({}, TODAY);
    expect(r).toMatchObject({ scope: "all", trDept: "all", lvDept: "all", centre: null, shift: "both", focus: null, toISO: TODAY });
  });
  it("lets a department settle its line", () => {
    expect(productionRequest({ dept: "Welding" }, TODAY)).toMatchObject({ scope: "TR", trDept: "Welding" });
    expect(productionRequest({ dept: "WeldingLV", scope: "TR" }, TODAY)).toMatchObject({ scope: "LV", lvDept: "WeldingLV", trDept: "all" });
  });
  it("lets a centre name its department, and drops one that does not belong", () => {
    expect(productionRequest({ centre: "Fins" }, TODAY)).toMatchObject({ scope: "TR", trDept: "Fabrication", centre: "Fins" });
    expect(productionRequest({ centre: "Fins", dept: "Welding" }, TODAY)).toMatchObject({ trDept: "Welding", centre: null });
    expect(productionRequest({ centre: "Fins", scope: "LV" }, TODAY).centre).toBeNull();
  });
  it("reads the stage names on the panels and the roster's names on the transformers", () => {
    expect(productionRequest({ scope: "LV", dept: "Welding" }, TODAY)).toMatchObject({ scope: "LV", lvDept: "WeldingLV", trDept: "all" });
    expect(productionRequest({ dept: "Cut" }, TODAY)).toMatchObject({ scope: "TR", trDept: "Fabrication" });
    expect(productionRequest({ lvDept: "Painting" }, TODAY)).toMatchObject({ scope: "LV", lvDept: "PaintingLV" });
  });
  it("keeps an older link's two departments on All", () => {
    expect(productionRequest({ dept: "Welding", lvDept: "PaintingLV" }, TODAY)).toMatchObject({ scope: "all", trDept: "Welding", lvDept: "PaintingLV" });
    expect(productionRequest({ lvDept: "Bending" }, TODAY)).toMatchObject({ scope: "LV", lvDept: "Bending" });
  });
  it("reads the shift, a tile and a day — a day outside the period is dropped", () => {
    const r = productionRequest({ shift: "night", focus: "efficiency", day: "2026-10-25", from: "2026-10-20", to: "2026-10-26" }, TODAY);
    expect(r).toMatchObject({ shift: "night", focus: "efficiency", focusDay: "2026-10-25" });
    expect(productionRequest({ shift: "x", focus: "y", day: "2026-09-01" }, TODAY)).toMatchObject({ shift: "both", focus: null, focusDay: null });
  });
});

describe("previousPeriod", () => {
  it("is the equal stretch just before", () => {
    expect(previousPeriod("2026-10-20", "2026-10-26", TODAY)).toEqual({ fromISO: "2026-10-13", toISO: "2026-10-19" });
  });
  it("is none before the history kept", () => {
    expect(previousPeriod("2026-05-01", "2026-07-30", TODAY)).toBeNull();
  });
});

describe("keepDay", () => {
  const tr = { line: "TR" as const, dept: "Fabrication", unit: "Fins" };
  const lv = { line: "LV" as const, dept: "Bending", unit: "Bending" };
  it("keeps a line, a department and a centre", () => {
    expect(keepDay(req({ scope: "LV" }), tr)).toBe(false);
    expect(keepDay(req({ scope: "LV" }), lv)).toBe(true);
    expect(keepDay(req({ scope: "TR", trDept: "Fabrication", centre: "Fins" }), tr)).toBe(true);
    expect(keepDay(req({ scope: "TR", trDept: "Fabrication", centre: "Cutting" }), tr)).toBe(false);
  });
  it("tells the transformers' Bending from the panels'", () => {
    const grid = heatGrid([day({ dateISO: "2026-10-20", line: "TR", dept: "Fabrication", unit: "Bending", workedH: 8, earnedH: 8, people: 1 }), day({ dateISO: "2026-10-20", line: "LV", dept: "Bending", unit: "Bending", workedH: 8, earnedH: 4, people: 1 })]);
    expect(grid.rows.map((r) => r.centre)).toEqual(["TR:Bending", "LV:Bending"]);
    expect(grid.labels["LV:Bending"]).toBe("Bending · LV");
  });
});

describe("the whole plant", () => {
  // the shot-blast crew is the transformers': the panels' blasting is already in its earned hours
  const tr = facts("TR", [
    day({ dateISO: "2026-10-20", dept: "ShotBlast", unit: "ShotBlast", workedH: 16, earnedH: 14, people: 2 }),
    day({ dateISO: "2026-10-20", dept: "Welding", unit: "Welding", workedH: 80, earnedH: 70, people: 10 }),
  ], [vol({ dateISO: "2026-10-20", qty: 12 })]);
  const lv = facts("LV", [
    day({ dateISO: "2026-10-20", line: "LV", dept: "WeldingLV", unit: "WeldingLV", workedH: 24, earnedH: 18, people: 3 }),
  ], [vol({ line: "LV", stage: "Welding", depts: ["WeldingLV"], component: "MDB", dateISO: "2026-10-20", qty: 5 })]);

  it("adds the lines' hours once, and keeps each line's pieces apart", () => {
    const v = productionView(req(), [tr, lv], null, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    expect(v.figures.earnedH).toBe(102);
    expect(v.figures.workedH).toBe(120);
    expect(v.figures.efficiency).toBeCloseTo(102 / 120);
    expect(v.byLine.TR?.earnedH).toBe(84);
    expect(v.byLine.LV?.earnedH).toBe(18);
    expect(v.volume.stages.map((s) => [s.key, s.total, s.unit])).toEqual([["TR:Welding", 12, "pcs"], ["LV:Welding", 5, "panels"]]);
  });

  it("makes the chart, the table and a tile's rows add up to the tiles", () => {
    const v = productionView(req(), [tr, lv], null, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;
    expect(sum(v.daily.days.map((d) => d.earnedH))).toBe(v.figures.earnedH);
    expect(sum(v.daily.days.map((d) => d.workedH))).toBe(v.figures.workedH);
    expect(sum(v.table.map((r) => r.earnedH))).toBe(v.figures.earnedH);
    expect(sum(v.table.map((r) => r.workedH))).toBe(v.figures.workedH);
    expect(sum(v.table.map((r) => r.personDays))).toBe(v.figures.personDays);
    expect(sum(focusRows(v, "earned", null).map((d) => d.earnedH))).toBe(v.figures.earnedH);
    expect(v.hours.now.workedH).toBe(v.figures.workedH);
    expect(v.hours.now.earnedH).toBe(v.figures.earnedH);
    // the sheet's total row is the tiles, its departments the table's
    const sheet = productionSheetRows(v);
    expect(sheet.at(-1)).toMatchObject({ Department: "Total", "Booked h": v.figures.workedH, "Earned std-h": v.figures.earnedH, Output: "" });
    expect(sum(sheet.slice(0, -1).map((r) => Number(r["Earned std-h"])))).toBe(v.figures.earnedH);
    expect(sum(productionDayRows(v).map((r) => Number(r["Booked h"])))).toBe(v.figures.workedH);
  });

  it("compares with the stretch before on the same filter", () => {
    const before = [facts("TR", [day({ dateISO: "2026-10-13", workedH: 100, earnedH: 80, people: 10 })])];
    const v = productionView(req({ scope: "TR" }), [tr], before, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    const eff = v.kpis.find((k) => k.key === "efficiency")!;
    expect(eff.before).toBeCloseTo(0.8);
    expect(eff.delta).toEqual({ kind: "pts", value: Math.round((84 / 96 - 0.8) * 1000) / 10 });
    const earned = v.kpis.find((k) => k.key === "earned")!;
    expect(earned.delta).toEqual({ kind: "pct", value: Math.round(((84 - 80) / 80) * 1000) / 10 });
  });

  it("shows N/A against a stretch with nothing booked", () => {
    const before = [facts("TR", [day({ dateISO: "2026-10-13", workedH: 0, rows: 0 })])];
    const v = productionView(req({ scope: "TR" }), [tr], before, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    expect(v.kpis.every((k) => k.delta === null)).toBe(true);
  });
});

describe("output with no standard hours", () => {
  it("shows a department whose output is all unpriced as not priced, never 0%", () => {
    const lv = facts("LV", [day({ dateISO: "2026-10-20", line: "LV", dept: "Bending", unit: "Bending", workedH: 24, earnedH: 0, people: 3 })],
      [vol({ line: "LV", stage: "Bending", depts: ["Bending"], dateISO: "2026-10-20", qty: 10, priced: false })]);
    const v = productionView(req({ scope: "LV" }), [lv], null, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    expect(v.unpriced).toEqual(["LV:Bending"]);
    expect(v.kpis.find((k) => k.key === "efficiency")!.value).toBeNull();
    expect(v.kpis.find((k) => k.key === "booked")!.value).toBe(24);
    expect(v.table[0].efficiency).toBeNull();
    expect(v.heat.rows[0].cells[0].efficiency).toBeNull();
    expect(v.gaps).toEqual([]);
  });
});

describe("unpriced departments beside priced ones", () => {
  const tr = facts("TR", [day({ dateISO: "2026-10-20", workedH: 40, earnedH: 36, people: 5 })], [vol({ dateISO: "2026-10-20", qty: 4 })]);
  const lv = facts("LV", [day({ dateISO: "2026-10-20", line: "LV", dept: "Bending", unit: "Bending", workedH: 40, earnedH: 0, people: 5 })],
    [vol({ line: "LV", stage: "Bending", depts: ["Bending"], dateISO: "2026-10-20", qty: 10, priced: false })]);
  it("reads the efficiency over the priced departments, the booked hours over all", () => {
    const v = productionView(req(), [tr, lv], null, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    const k = (key: string) => v.kpis.find((x) => x.key === key)!.value;
    expect(k("efficiency")).toBeCloseTo(0.9);
    expect(k("booked")).toBe(80);
    expect(k("earned")).toBe(36);
    expect(v.daily.days[0].workedH).toBe(40);
    expect(productionSheetRows(v).at(-1)).toMatchObject({ "Booked h": 80, "Efficiency %": 90 });
  });
  it("keeps a department priced that earned hours another way (the shot-blast crew's panels)", () => {
    const sb = facts("TR", [day({ dateISO: "2026-10-20", dept: "ShotBlast", unit: "ShotBlast", workedH: 8, earnedH: 6, people: 1 })],
      [vol({ dateISO: "2026-10-20", stage: "Painting", depts: ["Painting", "ShotBlast"], qty: 4, priced: false })]);
    expect(productionView(req(), [sb], null, { todayISO: TODAY, holidays: NO_HOLIDAYS }).unpriced).toEqual(["TR:Painting"]);
  });
  it("leaves a line that did not load out of the split, never as zero", () => {
    const v = productionView(req(), [tr], null, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    expect(Object.keys(v.byLine)).toEqual(["TR"]);
  });
});

describe("coverageOf", () => {
  it("counts the working days since tracking began, and the output nobody booked hours against", () => {
    const tr = facts("TR", [
      day({ dateISO: "2026-10-19", workedH: 8, earnedH: 8, people: 1 }),
      day({ dateISO: "2026-10-21", workedH: 0, earnedH: 12, people: 0, rows: 0 }),
    ], [vol({ dateISO: "2026-10-19", qty: 3 }), vol({ dateISO: "2026-10-21", qty: 4, priced: false })], "2026-10-19");
    const c = coverageOf(tr.days, tr.volume, [tr], { fromISO: "2026-10-12", toISO: "2026-10-24", todayISO: TODAY, holidays: new Set(["2026-10-22"]) });
    // 19 Mon … 24 Sat: Fri 23rd and the holiday on the 22nd off
    expect(c.workingDays).toBe(4);
    expect(c.recordedDays).toBe(1);
    expect(c.beforeTracking).toEqual([{ line: "TR", sinceISO: "2026-10-19" }]);
    expect(c.unmatched).toEqual({ unitDays: 1, earnedH: 12, dates: ["2026-10-21"] });
    expect(c.priced.TR).toBeCloseTo(3 / 7);
    expect(c.todayOpen).toBe(false);
  });
  it("has no share with no working day", () => {
    const tr = facts("TR", [], [], "");
    expect(coverageOf([], [], [{ ...tr, trackingSinceISO: null }], { fromISO: "2026-10-20", toISO: "2026-10-20", todayISO: TODAY, holidays: NO_HOLIDAYS }).share).toBeNull();
  });
});

describe("workingDaysIn", () => {
  it("skips Fridays", () => {
    expect(workingDaysIn("2026-10-22", "2026-10-24", NO_HOLIDAYS)).toEqual(["2026-10-22", "2026-10-24"]);
    expect(workingDaysIn("2026-10-24", "2026-10-22", NO_HOLIDAYS)).toEqual([]);
  });
});

describe("dailyHours and performanceGaps", () => {
  const days = [
    day({ dateISO: "2026-10-20", workedH: 80, earnedH: 40, people: 10 }),
    day({ dateISO: "2026-10-20", unit: "Painting", dept: "Painting", workedH: 16, earnedH: 30, people: 2 }),
    day({ dateISO: "2026-10-21", workedH: 0, earnedH: 25 }),
  ];
  it("charts only the booked unit-days", () => {
    expect(dailyHours(days)).toEqual({
      days: [{ dateISO: "2026-10-20", earnedH: 70, workedH: 96, efficiency: 70 / 96, values: { "TR:Welding": 40, "TR:Painting": 30 } }],
      groups: [{ key: "TR:Welding", label: "Welding" }, { key: "TR:Painting", label: "Painting" }],
    });
  });
  it("lists the biggest gaps, then what is unusually above the standard", () => {
    const g = performanceGaps(days);
    expect(g.map((r) => [r.unit, r.kind])).toEqual([["Welding", "gap"], ["Painting", "above"]]);
    expect(g[0].gapH).toBe(40);
  });
});

describe("volumeOf", () => {
  it("keeps every day with output, stage by stage — never added across stages", () => {
    const v = volumeOf([
      vol({ dateISO: "2026-10-20", stage: "Cut", depts: ["Fabrication"], component: "Tank", qty: 10 }),
      vol({ dateISO: "2026-10-20", stage: "Welding", component: "Tank", qty: 6 }),
      vol({ dateISO: "2026-10-21", stage: "Welding", component: "Fins", qty: 4 }),
    ]);
    expect(v.stages.map((s) => [s.label, s.total])).toEqual([["Fabrication", 10], ["Welding", 10]]);
    expect(v.days.filter((d) => d.stage === "TR:Welding").map((d) => d.dateISO)).toEqual(["2026-10-20", "2026-10-21"]);
  });
  it("counts output net of its corrections, as the department table does", () => {
    const v = volumeOf([
      // a cancel-and-redo on one day is 30 pieces, not 60
      vol({ dateISO: "2026-10-15", stage: "Cut", depts: ["Fabrication"], component: "Cable Box", qty: 30 }),
      vol({ dateISO: "2026-10-15", stage: "Cut", depts: ["Fabrication"], component: "Cable Box", qty: -30 }),
      vol({ dateISO: "2026-10-15", stage: "Cut", depts: ["Fabrication"], component: "Cable Box", qty: 30 }),
      // recorded and taken back the same day: nothing
      vol({ dateISO: "2026-10-01", stage: "Cut", depts: ["Fabrication"], component: "Core Frame", qty: 36 }),
      vol({ dateISO: "2026-10-01", stage: "Cut", depts: ["Fabrication"], component: "Core Frame", qty: -36 }),
      // taken back on a later day: the stage's total, not that day's bar
      vol({ dateISO: "2026-10-20", stage: "Cut", depts: ["Fabrication"], component: "Tank", qty: 9 }),
      vol({ dateISO: "2026-10-24", stage: "Cut", depts: ["Fabrication"], component: "Tank", qty: -4 }),
    ]);
    expect(v.stages.map((s) => [s.label, s.total])).toEqual([["Fabrication", 35]]);
    expect(v.days.map((d) => [d.dateISO, d.total])).toEqual([["2026-10-15", 30], ["2026-10-20", 9]]);
  });
});

describe("attendanceRows", () => {
  const days = [
    day({ dateISO: "2026-10-20", workedH: 24, people: 3, rows: 4, absent: 1, day: { people: 2, hours: 16, overtimeH: 0 }, night: { people: 1, hours: 8, overtimeH: 2 }, overtimeH: 2, notSet: 1 }),
    day({ dateISO: "2026-10-21", workedH: 8, people: 1, rows: 1, day: { people: 1, hours: 8, overtimeH: 0 }, notSet: null }),
  ];
  it("splits who came by shift; absences stay whole", () => {
    const [both] = attendanceRows(days, "both");
    expect(both).toMatchObject({ rows: 5, present: 4, absent: 1, workedH: 32, overtimeH: 2 });
    const [night] = attendanceRows(days, "night");
    expect(night).toMatchObject({ present: 1, absent: 1, workedH: 8, overtimeH: 2 });
  });
  it("leaves out a department with output but no row on the shift log", () => {
    expect(attendanceRows([day({ dateISO: "2026-10-20", dept: "ShotBlast", unit: "ShotBlast", earnedH: 5, rows: 0 })], "both")).toEqual([]);
  });
  it("leaves Not set unknown where the roster cannot say", () => {
    expect(attendanceRows(days, "both")[0].notSet).toBeNull();
    expect(attendanceRows(days.slice(0, 1), "both")[0].notSet).toBe(1);
  });
});

describe("hours walk", () => {
  it("names the unexplained part, and meets the tiles", () => {
    const v = productionView(req({ scope: "TR" }), [facts("TR", [
      day({ dateISO: "2026-10-20", workedH: 88, overtimeH: 8, earnedH: 60, people: 10, rows: 11, absent: 1, absentH: 8 }),
    ])], null, { todayISO: TODAY, holidays: NO_HOLIDAYS });
    const steps = Object.fromEntries(v.hours.now.steps.map((s) => [s.key, s]));
    expect(steps.rostered.hours).toBe(88);
    expect(steps.performance.label).toBe(UNEXPLAINED_LABEL);
    expect(steps.performance.hours).toBe(-28);
    expect(v.hours.change).toBeNull();
  });
});

describe("deptTable", () => {
  it("gives each department its recorded days of the working days, and its output in its unit", () => {
    const tr = facts("TR", [day({ dateISO: "2026-10-20", workedH: 8, earnedH: 6, people: 1 })], [vol({ dateISO: "2026-10-20", qty: 3 }), vol({ dateISO: "2026-10-21", qty: 2 })]);
    const [row] = deptTable(tr.days, tr.volume, [tr], { fromISO: "2026-10-19", toISO: "2026-10-24", todayISO: TODAY, holidays: NO_HOLIDAYS });
    expect(row).toMatchObject({ label: "Welding", recordedDays: 1, workingDays: 5, output: 5, outputUnit: "pcs", lastDayISO: "2026-10-20" });
    expect(row.coverage).toBeCloseTo(0.2);
  });
});
