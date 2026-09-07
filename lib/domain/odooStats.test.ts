import { describe, it, expect } from "vitest";
import { buildOdooDashboard, parseOdooRange, productSeries, rangeBounds, shortDayLabel } from "./odooStats";

describe("productSeries", () => {
  it("folds the sheet's product names, however typed, and gathers the rest as Other", () => {
    expect(productSeries("Tank")).toBe("Tank");
    expect(productSeries(" top  cover ")).toBe("Top Cover");
    expect(productSeries("CB")).toBe("Cable Box");
    expect(productSeries("enclosure")).toBe("Encloser");
    expect(productSeries("Radiator")).toBe("Other");
    expect(productSeries(null)).toBe("Other");
  });
});

describe("ranges", () => {
  const today = new Date(Date.UTC(2026, 8, 7));
  it("parses the range from the URL, defaulting to 30 days", () => {
    expect(parseOdooRange("7d")).toBe("7d");
    expect(parseOdooRange("nope")).toBe("30d");
    expect(parseOdooRange(undefined)).toBe("30d");
  });
  it("bounds each preset to whole days ending today", () => {
    expect(rangeBounds("7d", today)).toEqual({ fromISO: "2026-09-01", toISO: "2026-09-07" });
    expect(rangeBounds("30d", today)).toEqual({ fromISO: "2026-08-09", toISO: "2026-09-07" });
    expect(rangeBounds("month", today)).toEqual({ fromISO: "2026-09-01", toISO: "2026-09-07" });
    expect(rangeBounds("all", today)).toEqual({ fromISO: null, toISO: "2026-09-07" });
  });
  it("labels a day short", () => {
    expect(shortDayLabel("2026-09-06")).toBe("6 Sep");
  });
});

describe("buildOdooDashboard", () => {
  const rows = [
    { dateISO: "2026-09-06", product: "Tank", qty: 5, status: "Done" },
    { dateISO: "2026-09-06", product: "Tank", qty: 3, status: "MO to be close" },
    { dateISO: "2026-09-06", product: "Top Cover", qty: 4, status: "Pending" },
    { dateISO: "2026-09-04", product: "Core Frame", qty: 2, status: "Done" },
    { dateISO: "2026-09-04", product: "Radiator", qty: 1, status: "Done" },
  ];
  const bounds = { fromISO: "2026-09-03", toISO: "2026-09-07" };

  it("sums qty per day and per product, filling the quiet days with zero", () => {
    const d = buildOdooDashboard(rows, "7d", bounds);
    expect(d.days.map((x) => x.dateISO)).toEqual(["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]);
    const sixth = d.days.find((x) => x.dateISO === "2026-09-06")!;
    expect(sixth.qty).toBe(12);
    expect(sixth.rows).toBe(3);
    expect(sixth.bySeries.Tank).toBe(8);
    expect(sixth.bySeries["Top Cover"]).toBe(4);
    expect(sixth.bySeries["Core Frame"]).toBe(0);
    expect(sixth.doneQty).toBe(5);
    const fourth = d.days.find((x) => x.dateISO === "2026-09-04")!;
    expect(fourth.bySeries.Other).toBe(1);
    expect(d.days.find((x) => x.dateISO === "2026-09-05")!.qty).toBe(0);
  });

  it("totals per product in the fixed order, only the products that appear", () => {
    const d = buildOdooDashboard(rows, "7d", bounds);
    expect(d.totals.map((t) => [t.series, t.qty, t.rows])).toEqual([
      ["Tank", 8, 2], ["Top Cover", 4, 1], ["Core Frame", 2, 1], ["Other", 1, 1],
    ]);
  });

  it("carries the headline numbers", () => {
    const d = buildOdooDashboard(rows, "7d", bounds);
    expect(d.kpi).toEqual({ qty: 15, rows: 5, doneRows: 3, doneQty: 8, activeDays: 2, qtyPerActiveDay: 7.5 });
  });

  it("shows only the logged days on an open-ended range that spans too long", () => {
    const far = [{ dateISO: "2025-01-01", product: "Tank", qty: 1, status: "Done" }, ...rows];
    const d = buildOdooDashboard(far, "all", { fromISO: null, toISO: "2026-09-07" });
    expect(d.days.map((x) => x.dateISO)).toEqual(["2025-01-01", "2026-09-04", "2026-09-06"]);
  });

  it("is empty but well-formed with no rows", () => {
    const d = buildOdooDashboard([], "30d", { fromISO: "2026-08-09", toISO: "2026-09-07" });
    expect(d.days).toHaveLength(30);
    expect(d.totals).toEqual([]);
    expect(d.kpi.qtyPerActiveDay).toBe(0);
  });
});
