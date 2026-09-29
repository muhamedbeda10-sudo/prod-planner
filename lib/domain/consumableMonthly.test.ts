import { describe, expect, it } from "vitest";
import { buildMonthlyReport, grade, monthBounds, monthlyAllowance, reportSpan, shiftMonth, type ItemInput } from "./consumableMonthly";
import type { LimitRule, LimitUse } from "./consumableLimits";

const rule = (over: Partial<LimitRule>): LimitRule => ({ id: 1, itemId: 10, departments: ["WeldingTX"], basis: "pool", period: "week", qty: 15, ...over });
const use = (over: Partial<LimitUse>): LimitUse => ({ itemId: 10, department: "WeldingTX", workerId: 1, dayISO: "2026-09-10", qty: 1, ...over });
const item = (over: Partial<ItemInput>): ItemInput => ({ id: 10, code: "C-1", name: "Grinding Disk", uom: "PC", active: true, rules: [rule({})], ...over });

describe("the monthly allowance", () => {
  it("is a fixed multiple of the limit", () => {
    expect(monthlyAllowance({ qty: 15, period: "week" })).toBe(60);
    expect(monthlyAllowance({ qty: 30, period: "day" })).toBe(780);
    expect(monthlyAllowance({ qty: 3, period: "month" })).toBe(3);
    expect(monthlyAllowance({ qty: 1, period: "quarter" })).toBe(1); // whole, over the quarter to date
  });

  it("grades a month in four", () => {
    expect(grade(61, 60)).toBe("over");
    expect(grade(60, 60)).toBe("near");
    expect(grade(48, 60)).toBe("near");
    expect(grade(47, 60)).toBe("under");
    expect(grade(0, 60)).toBe("unused");
  });
});

describe("months", () => {
  it("bounds, shifts and spans months", () => {
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    // six months back to the month's end, the month's own edge weeks counted whole
    // (30 Sep 2026 is a Wednesday: its week runs to Friday 2 Oct)
    expect(reportSpan("2026-09")).toEqual({ from: "2026-04-01", to: "2026-10-02" });
    // a one-month trend still reaches back to the quarter's first day (and the month's first week)
    expect(reportSpan("2026-09", 1)).toEqual({ from: "2026-07-01", to: "2026-10-02" });
  });
});

describe("the monthly report", () => {
  it("counts the month against the allowance and compares with the month before", () => {
    const r = buildMonthlyReport([item({})], [use({ qty: 50 }), use({ qty: 20, dayISO: "2026-08-15" })], "2026-09");
    const row = r.rows[0];
    expect(row).toMatchObject({ allowance: 60, used: 50, status: "near", prevUsed: 20, outside: 0 });
    expect(row.change).toBeCloseTo(1.5);
    expect(row.trend.map((t) => t.month)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(row.trend.at(-1)!.used).toBe(50);
  });

  it("adds a split limit's rows into the item, and grades the item by its worst limit", () => {
    const i = item({ rules: [rule({ id: 1, departments: ["WeldingTX"] }), rule({ id: 2, departments: ["WeldingLV"] })] });
    const r = buildMonthlyReport([i], [use({ qty: 70 }), use({ qty: 5, department: "WeldingLV" })], "2026-09");
    const row = r.rows[0];
    expect(row.allowance).toBe(120);
    expect(row.used).toBe(75);
    expect(row.status).toBe("over"); // Welding TX 70 of 60, though the item is at 75 of 120
    expect(row.limits.map((l) => [l.departmentsLabel, l.used, l.status])).toEqual([["Welding TX", 70, "over"], ["Welding USS/LV", 5, "under"]]);
  });

  it("names the weeks of the month that went over, counted whole", () => {
    // week of 29 Aug runs to 4 Sep: 10 in August + 10 in September = 20 of 15
    const r = buildMonthlyReport([item({})], [use({ qty: 10, dayISO: "2026-08-31" }), use({ qty: 10, dayISO: "2026-09-02" }), use({ qty: 5, dayISO: "2026-09-08" })], "2026-09");
    const weeks = r.rows[0].limits[0].weeks;
    expect(weeks[0]).toMatchObject({ label: "week of 29 Aug", used: 20, over: true });
    expect(weeks[1]).toMatchObject({ label: "week of 5 Sep", used: 5, over: false });
    expect(weeks).toHaveLength(5);
  });

  it("lists the days a daily limit went over", () => {
    const i = item({ rules: [rule({ period: "day", qty: 30 })] });
    const r = buildMonthlyReport([i], [use({ qty: 31, dayISO: "2026-09-03" }), use({ qty: 30, dayISO: "2026-09-04" })], "2026-09");
    expect(r.rows[0].limits[0].daysOver).toEqual([{ dayISO: "2026-09-03", used: 31 }]);
    expect(r.rows[0].limits[0].allowance).toBe(780);
  });

  it("grades a per-person limit by its workers, each against his own allowance", () => {
    const i = item({ rules: [rule({ basis: "person", qty: 2 })] }); // 8 a month each
    const r = buildMonthlyReport([i], [use({ workerId: 1, qty: 9 }), use({ workerId: 2, qty: 3 })], "2026-09");
    const l = r.rows[0].limits[0];
    expect(l).toMatchObject({ allowance: 8, used: 9, usedAll: 12, status: "over", workersOver: [{ workerId: 1, used: 9 }] });
    expect(r.rows[0].allowance).toBeNull();
    expect(r.rows[0].status).toBe("over");
  });

  it("keeps hand-outs outside every limit's departments apart", () => {
    const r = buildMonthlyReport([item({})], [use({ qty: 4 }), use({ qty: 6, department: "Maintenance" })], "2026-09");
    expect(r.rows[0]).toMatchObject({ used: 10, outside: 6, status: "under" });
    expect(r.rows[0].ratio).toBeCloseTo(4 / 60);
  });

  it("lists every active item, the unused ones too, and items with no limit only when handed out", () => {
    const items = [item({ id: 10 }), item({ id: 11, name: "Unused", rules: [rule({ id: 5, itemId: 11 })] }), item({ id: 12, name: "No limit", rules: [] }), item({ id: 13, name: "Retired", active: false, rules: [rule({ id: 6, itemId: 13 })] })];
    const r = buildMonthlyReport(items, [use({ qty: 61 }), use({ itemId: 12, qty: 1 })], "2026-09");
    expect(r.rows.map((x) => [x.name, x.status])).toEqual([["Grinding Disk", "over"], ["Unused", "unused"], ["No limit", "nolimit"]]);
    expect(r.counts).toEqual({ over: 1, near: 0, under: 0, unused: 1, nolimit: 1 });
    expect(r.handOuts).toEqual({ month: 2, prev: 0 });
  });

  it("grades the trend's months the same way", () => {
    const r = buildMonthlyReport([item({})], [use({ qty: 61, dayISO: "2026-07-10" }), use({ qty: 10, dayISO: "2026-09-10" })], "2026-09");
    expect(r.countsByMonth.find((c) => c.month === "2026-07")).toMatchObject({ over: 1 });
    expect(r.countsByMonth.find((c) => c.month === "2026-09")).toMatchObject({ under: 1 });
    expect(r.countsByMonth.find((c) => c.month === "2026-08")).toMatchObject({ unused: 1 });
  });
});

describe("quarterly limits in the monthly review", () => {
  it("count the quarter so far against the whole number, not a third of it", () => {
    const i = item({ rules: [rule({ period: "quarter", qty: 1, departments: "*" })] });
    const one = buildMonthlyReport([i], [use({ qty: 1, dayISO: "2026-08-05" })], "2026-08");
    expect(one.rows[0].limits[0]).toMatchObject({ allowance: 1, used: 1, status: "near", toDate: "Q3 2026 to date" });
    // a second one in September takes the quarter over
    const two = buildMonthlyReport([i], [use({ qty: 1, dayISO: "2026-08-05" }), use({ qty: 1, dayISO: "2026-09-02" })], "2026-09");
    expect(two.rows[0].limits[0]).toMatchObject({ used: 2, status: "over", prevUsed: 1 });
    expect(two.rows[0]).toMatchObject({ allowance: null, used: 1, status: "over" });
    // a new quarter starts again
    const oct = buildMonthlyReport([i], [use({ qty: 1, dayISO: "2026-09-02" })], "2026-10");
    expect(oct.rows[0].limits[0]).toMatchObject({ used: 0, status: "unused" });
  });
});
