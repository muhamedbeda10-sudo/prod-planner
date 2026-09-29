import { describe, expect, it } from "vitest";
import { OTHER_KEY, consumablesStats, pctChange, previousPeriod, spanDays, type StatsRow } from "./consumablesStats";

const row = (over: Partial<StatsRow>): StatsRow => ({
  item: "Gloves", qty: 1, department: "WeldingTX", departmentLabel: "Welding TX",
  workerId: 1, workerName: "Ali", empId: "E1", dayISO: "2026-09-28", hour: 9, ...over,
});

describe("the consumables dashboard", () => {
  it("counts one item however it was typed, named the way it was typed most", () => {
    const s = consumablesStats([
      row({ item: "Welding wire", qty: 2 }),
      row({ item: "welding  wire", qty: 1.5, workerId: 2 }),
      row({ item: "Welding wire", qty: 0.5 }),
      row({ item: "Gloves", qty: 3 }),
    ], "2026-09-28", "2026-09-28", 0);
    expect(s.items[0]).toEqual({ item: "Welding wire", issues: 3, qty: 4, workers: 2 });
    expect(s.items[1]).toEqual({ item: "Gloves", issues: 1, qty: 3, workers: 1 });
    expect(s.totals).toEqual({ issues: 4, items: 2, workers: 2, departments: 1 });
  });

  it("splits a single day by hour, a longer period by day", () => {
    const one = consumablesStats([row({ hour: 6 }), row({ hour: 10 }), row({ hour: 10 })], "2026-09-28", "2026-09-28", 0);
    expect(one.timeline.unit).toBe("hour");
    expect(one.timeline.buckets[0]).toEqual({ key: "6", label: "06:00", issues: 1 });
    expect(one.timeline.buckets.at(-1)?.key).toBe("17"); // the working day at least
    expect(one.timeline.buckets.find((b) => b.key === "10")?.issues).toBe(2);

    const week = consumablesStats([row({ dayISO: "2026-09-22" }), row({ dayISO: "2026-09-28" })], "2026-09-22", "2026-09-28", 0);
    expect(week.timeline.unit).toBe("day");
    expect(week.timeline.buckets).toHaveLength(7);
    expect(week.timeline.buckets[0]).toMatchObject({ key: "2026-09-22", issues: 1, label: "Tue 22 Sep" });
    expect(week.timeline.buckets[3].issues).toBe(0); // an empty day still has its column
  });

  it("puts each item's quantity under the department it went to", () => {
    const s = consumablesStats([
      row({ item: "Paint", qty: 5, department: "PaintingTX", departmentLabel: "Painting TX" }),
      row({ item: "Paint", qty: 2, department: "PaintingTX", departmentLabel: "Painting TX" }),
      row({ item: "Paint", qty: 1, department: "Maintenance", departmentLabel: "Maintenance" }),
      row({ item: "Gloves", qty: 4 }),
    ], "2026-09-28", "2026-09-28", 0);
    const pi = s.matrix.items.indexOf("Paint");
    const pd = s.matrix.departments.findIndex((d) => d.department === "PaintingTX");
    const md = s.matrix.departments.findIndex((d) => d.department === "Maintenance");
    expect(s.matrix.qty[pi][pd]).toBe(7);
    expect(s.matrix.qty[pi][md]).toBe(1);
    expect(s.departments[0]).toMatchObject({ department: "PaintingTX", issues: 2, items: 1 });
  });

  it("compares with the period of the same length just before", () => {
    expect(spanDays("2026-09-22", "2026-09-28")).toBe(7);
    expect(previousPeriod("2026-09-22", "2026-09-28")).toEqual({ fromISO: "2026-09-15", toISO: "2026-09-21" });
    expect(previousPeriod("2026-09-28", "2026-09-28")).toEqual({ fromISO: "2026-09-27", toISO: "2026-09-27" });
    expect(pctChange(12, 10)).toBe(20);
    expect(pctChange(5, 0)).toBeNull();
  });

  it("ranks workers by hand-outs and keeps the top ones", () => {
    const rows = [1, 2, 2, 3, 3, 3].map((id) => row({ workerId: id, workerName: `W${id}` }));
    const s = consumablesStats(rows, "2026-09-28", "2026-09-28", 0, { topWorkers: 2 });
    expect(s.workers.map((w) => [w.name, w.issues])).toEqual([["W3", 3], ["W2", 2]]);
  });
});

describe("the richer consumables dashboard", () => {
  it("builds a daily series with a trailing 7-day average once a week is in", () => {
    const rows = ["2026-09-01", "2026-09-01", "2026-09-03", "2026-09-07", "2026-09-08"].map((d) => row({ dayISO: d }));
    const s = consumablesStats(rows, "2026-09-01", "2026-09-10", 0);
    expect(s.daily).toHaveLength(10);
    expect(s.daily[0]).toMatchObject({ dayISO: "2026-09-01", issues: 2, avg7: null });
    expect(s.daily[5].avg7).toBeNull();
    expect(s.daily[6].avg7).toBe(Math.round((4 / 7) * 10) / 10); // 1–7 Sep: 2+1+1
    expect(s.daily[7].avg7).toBe(Math.round((3 / 7) * 10) / 10); // 2–8 Sep: 1+1+1
    expect(s.kpis.activeDays).toBe(4);
    expect(s.kpis.perActiveDay).toBe(1.3);
  });

  it("counts hand-outs by weekday and hour, and names the busiest slot", () => {
    // 2026-09-28 is a Monday, 2026-09-27 a Sunday
    const s = consumablesStats([
      row({ dayISO: "2026-09-28", hour: 9 }), row({ dayISO: "2026-09-28", hour: 9 }), row({ dayISO: "2026-09-27", hour: 20 }),
    ], "2026-09-27", "2026-09-28", 0);
    expect(s.weekHour.hours[0]).toBe(7);
    expect(s.weekHour.hours.at(-1)).toBe(20); // widened to the late hand-out
    expect(s.weekHour.counts[1][s.weekHour.hours.indexOf(9)]).toBe(2);
    expect(s.weekHour.counts[0][s.weekHour.hours.indexOf(20)]).toBe(1);
    expect(s.kpis.busiestSlot).toEqual({ weekday: 1, hour: 9, issues: 2 });
  });

  it("folds departments past the fifth into Other, in the share and the trend", () => {
    const depts = ["A", "B", "C", "D", "E", "F", "G"];
    const rows = depts.flatMap((d, i) => Array.from({ length: 7 - i }, () => row({ department: d, departmentLabel: d })));
    const s = consumablesStats(rows, "2026-09-28", "2026-09-28", 0);
    expect(s.departmentShare.map((x) => x.key)).toEqual(["A", "B", "C", "D", "E", OTHER_KEY]);
    expect(s.departmentShare.at(-1)).toMatchObject({ label: "Other (2)", issues: 3 });
    expect(s.departmentShare.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1);
    expect(s.departmentTrend.series.map((x) => x.key)).toEqual(["A", "B", "C", "D", "E", OTHER_KEY]);
    expect(s.departmentTrend.buckets[0].values[OTHER_KEY]).toBe(3);
    expect(s.kpis.topDepartmentShare).toBeCloseTo(7 / 28);
  });

  it("groups a long period's department trend by week", () => {
    const s = consumablesStats([row({ dayISO: "2026-08-01" }), row({ dayISO: "2026-08-09" })], "2026-08-01", "2026-09-10", 0);
    expect(s.departmentTrend.unit).toBe("week");
    expect(s.departmentTrend.buckets[0]).toMatchObject({ key: "2026-08-01", total: 1 });
    expect(s.departmentTrend.buckets[1]).toMatchObject({ key: "2026-08-08", total: 1 });
    expect(s.departmentTrend.buckets).toHaveLength(6);
  });

  it("finds the items that make up 80% of hand-outs", () => {
    const rows = [...Array(6).fill("Wire"), ...Array(2).fill("Gloves"), "Disc", "Tape"].map((item) => row({ item }));
    const s = consumablesStats(rows, "2026-09-28", "2026-09-28", 0);
    expect(s.pareto.rows.map((r) => [r.item, r.cumulative])).toEqual([["Wire", 0.6], ["Gloves", 0.8], ["Disc", 0.9], ["Tape", 1]]);
    expect(s.pareto.vitalFew).toBe(2);
    expect(s.kpis.vitalFew).toBe(2);
  });

  it("tiles each item with the department that takes it most", () => {
    const s = consumablesStats([
      row({ item: "Paint", department: "PaintingTX", departmentLabel: "Painting TX" }),
      row({ item: "Paint", department: "PaintingTX", departmentLabel: "Painting TX" }),
      row({ item: "Paint", department: "Maintenance", departmentLabel: "Maintenance" }),
    ], "2026-09-28", "2026-09-28", 0);
    expect(s.itemTiles[0]).toMatchObject({ item: "Paint", issues: 3, department: "PaintingTX", departmentLabel: "Painting TX" });
  });

  it("names the busiest slot as one weekday and hour that actually happened", () => {
    // Mon 09:00 ×2, Sun 20:00 ×1, Sun 09:00 — never — though 09:00 and Sunday are each "busiest" apart
    const s = consumablesStats([
      row({ dayISO: "2026-09-28", hour: 9 }), row({ dayISO: "2026-09-28", hour: 9 }),
      row({ dayISO: "2026-09-27", hour: 20 }), row({ dayISO: "2026-09-27", hour: 21 }), row({ dayISO: "2026-09-27", hour: 22 }),
    ], "2026-09-27", "2026-09-28", 0);
    expect(s.kpis.busiestSlot).toEqual({ weekday: 1, hour: 9, issues: 2 });
  });

  it("counts each department once in the scatter", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row({ item: i === 1 ? "gloves" : "Gloves", qty: 2, dayISO: `2026-09-2${i + 1}` })),
      row({ item: "Wire", workerId: 2, workerName: "Omar" }),
    ];
    const s = consumablesStats(rows, "2026-09-21", "2026-09-28", 0);
    expect(s.workerPoints.map((w) => [w.name, w.issues, w.items])).toEqual([["Ali", 3, 1], ["Omar", 1, 1]]);
    expect(s.kpis.perWorker).toBe(2);
  });

  it("gives an empty period empty figures", () => {
    const s = consumablesStats([], "2026-09-28", "2026-09-28", 0);
    expect(s.kpis).toMatchObject({ activeDays: 0, perActiveDay: 0, perWorker: 0, vitalFew: 0, busiestSlot: null });
    expect(s.departmentShare).toEqual([]);
  });
});

describe("where each item goes", () => {
  it("folds the departments past the top ones into Other, so a row adds up", () => {
    const rows = ["A", "B", "C"].map((d, i) => row({ item: "Shot", qty: i + 1, department: d, departmentLabel: d }));
    const s = consumablesStats(rows, "2026-09-28", "2026-09-28", 0, { topDepartments: 2 });
    expect(s.matrix.departments.map((d) => d.department)).toEqual(["A", "B", OTHER_KEY]);
    expect(s.matrix.departments[2].label).toBe("Other (1)");
    expect(s.matrix.qty[0].reduce((a, b) => a + b, 0)).toBe(6);
  });
});
