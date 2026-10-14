import { describe, expect, it } from "vitest";
import { buildMonthlyReport, grade, monthBounds, monthlyAllowance, reportSpan, shiftMonth, type ItemInput } from "./consumableMonthly";
import type { LimitRule, LimitUse } from "./consumableLimits";

const rule = (over: Partial<LimitRule>): LimitRule => ({ id: 1, itemId: 10, departments: ["WeldingTX"], basis: "pool", period: "month", qty: 60, ...over });
const use = (over: Partial<LimitUse>): LimitUse => ({ itemId: 10, department: "WeldingTX", workerId: 1, dayISO: "2026-09-10", qty: 1, ...over });
const item = (over: Partial<ItemInput>): ItemInput => ({ id: 10, code: "C-1", name: "Grinding Disk", uom: "PC", active: true, rules: [rule({})], ...over });

describe("the monthly allowance", () => {
  it("is the month's number, or a longer limit's whole number", () => {
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
    // back to the year's first day (every multi-month window of the month is
    // inside it), to the month's own last day — nothing outside the month
    expect(reportSpan("2026-09")).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    // the trend starts in October: a yearly limit graded then counts from
    // that year's first day
    expect(reportSpan("2027-03", 6)).toEqual({ from: "2026-01-01", to: "2027-03-31" });
    // January: the month before is December, whose year began a year earlier
    expect(reportSpan("2027-01", 1)).toEqual({ from: "2026-01-01", to: "2027-01-31" });
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

  it("counts only the month's own days — a draw on the 31st is last month's", () => {
    const r = buildMonthlyReport([item({})], [use({ qty: 50, dayISO: "2026-08-31" }), use({ qty: 10, dayISO: "2026-09-01" })], "2026-09");
    expect(r.rows[0].limits[0]).toMatchObject({ used: 10, prevUsed: 50, status: "under" });
  });

  it("makes a per-worker limit each department's own: the number times its workers", () => {
    // 8 a month per worker; Welding TX has 5 workers → 40, Transformer Painting 2 → 16.
    // Hand-outs are recorded to the department, named after whoever collected
    // them — the collector is not the one held to the per-worker number.
    const i = item({ rules: [rule({ basis: "person", qty: 8, departments: ["WeldingTX", "PaintingTX"] })] });
    const headcount = new Map([["WeldingTX", 5], ["PaintingTX", 2]]);
    const r = buildMonthlyReport([i], [use({ workerId: 1, qty: 30 }), use({ workerId: 1, qty: 9 }), use({ department: "PaintingTX", workerId: 7, qty: 17 })], "2026-09", { headcountOf: () => headcount });
    const byDept = Object.fromEntries(r.rows[0].limits.map((l) => [l.departmentsLabel, l]));
    expect(byDept["Welding TX"]).toMatchObject({ allowance: 40, used: 39, left: 1, status: "near", basis: "person", qty: 8, perWorker: { qty: 8, workers: 5 }, sourceId: 1 });
    expect(byDept["Transformer Painting"]).toMatchObject({ allowance: 16, used: 17, left: -1, status: "over" });
    expect(r.rows[0]).toMatchObject({ allowance: 56, used: 56, covered: 56, status: "over" });
    // worst first
    expect(r.rows[0].limits[0].departmentsLabel).toBe("Transformer Painting");
  });

  it("gives every department of an 'each department' limit the whole number, not one number between them", () => {
    const i = item({ rules: [rule({ basis: "each", qty: 10, departments: ["WeldingTX", "PaintingTX"] })] });
    const r = buildMonthlyReport([i], [use({ qty: 9 }), use({ department: "PaintingTX", qty: 9 })], "2026-09");
    // 18 between them used to read as 18 of 10 — over; each is 9 of its own 10
    expect(r.rows[0].limits.map((l) => [l.departmentsLabel, l.used, l.allowance, l.status])).toEqual([
      ["Transformer Painting", 9, 10, "near"], ["Welding TX", 9, 10, "near"],
    ]);
    expect(r.rows[0]).toMatchObject({ allowance: 20, status: "near" });
  });

  it("covers every department an 'all departments' per-worker limit's item went to", () => {
    const i = item({ rules: [rule({ basis: "person", qty: 2, departments: "*" })] });
    const r = buildMonthlyReport([i], [use({ department: "Maintenance", qty: 3 })], "2026-09", { headcountOf: () => new Map([["WeldingTX", 4]]) });
    const byDept = Object.fromEntries(r.rows[0].limits.map((l) => [l.departmentsLabel, [l.allowance, l.used, l.status]]));
    // nobody on the list for Maintenance — counted as one worker
    expect(byDept).toEqual({ "Welding TX": [8, 0, "unused"], Maintenance: [2, 3, "over"] });
    expect(r.rows[0].outside).toBe(0);
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

describe("the month's own headcount and overlapping limits", () => {
  it("holds each month graded to the workers it had", () => {
    const i = item({ rules: [rule({ basis: "person", qty: 2 })] });
    const headcountOf = (m: string) => new Map([["WeldingTX", m === "2026-09" ? 10 : 5]]);
    const r = buildMonthlyReport([i], [use({ qty: 14, dayISO: "2026-08-10" }), use({ qty: 14 })], "2026-09", { headcountOf });
    // September: 10 workers → 20; August (in the trend) had 5 → 10, over
    expect(r.rows[0].limits[0]).toMatchObject({ allowance: 20, used: 14, status: "under" });
    expect(r.countsByMonth.find((c) => c.month === "2026-08")).toMatchObject({ over: 1 });
  });

  it("does not add two limits on the same department into one number", () => {
    const i = item({ rules: [rule({ id: 1, qty: 10 }), rule({ id: 2, qty: 40, departments: "*" })] });
    const r = buildMonthlyReport([i], [use({ qty: 11 })], "2026-09");
    expect(r.rows[0]).toMatchObject({ allowance: null, overlapping: true, status: "over" });
    expect(r.rows[0].ratio).toBeCloseTo(1.1);
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
