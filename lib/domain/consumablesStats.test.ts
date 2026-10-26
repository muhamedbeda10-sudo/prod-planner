import { describe, expect, it } from "vitest";
import { consumablesStats, hourLabel, hourSpan, pctChange, previousPeriod, spanDays, type StatsRow } from "./consumablesStats";

const row = (over: Partial<StatsRow>): StatsRow => ({ item: "Gloves", qty: 1, department: "WeldingTX", ...over });

describe("consumables by item", () => {
  it("counts one item however it was typed, named the way it was typed most", () => {
    const items = consumablesStats([
      row({ item: "Welding wire", qty: 2 }),
      row({ item: "welding  wire", qty: 1.5, department: "Maintenance" }),
      row({ item: "Welding wire", qty: 0.5 }),
      row({ item: "Gloves", qty: 3 }),
    ]);
    expect(items[0]).toEqual({ item: "Welding wire", issues: 3, qty: 4, workers: 2 });
    expect(items[1]).toEqual({ item: "Gloves", issues: 1, qty: 3, workers: 1 });
  });

  it("compares with the period of the same length just before", () => {
    expect(spanDays("2026-09-22", "2026-09-28")).toBe(7);
    expect(previousPeriod("2026-09-22", "2026-09-28")).toEqual({ fromISO: "2026-09-15", toISO: "2026-09-21" });
    expect(previousPeriod("2026-09-28", "2026-09-28")).toEqual({ fromISO: "2026-09-27", toISO: "2026-09-27" });
    expect(pctChange(12, 10)).toBe(20);
    expect(pctChange(5, 0)).toBeNull();
  });

  it("spans a single day's hours over the working day at least", () => {
    expect(hourSpan([])).toEqual({ first: 7, last: 17 });
    expect(hourSpan([6, 10, 20])).toEqual({ first: 6, last: 20 });
    expect(hourLabel(6)).toBe("06:00");
  });
});
