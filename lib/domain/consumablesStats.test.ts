import { describe, expect, it } from "vitest";
import { consumablesStats, pctChange, previousPeriod, spanDays, type StatsRow } from "./consumablesStats";

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
