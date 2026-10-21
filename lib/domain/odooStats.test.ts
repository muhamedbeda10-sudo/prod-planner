import { describe, it, expect } from "vitest";
import { bomOptions, buildOdooDashboard, matchesBom, matchesProduct, pctChange, periodLabel, previousPeriod, productSeries, resolveBasis, resolveBom, resolvePeriod, resolveProduct, shortDayLabel, type OdooStatRow, comparePeriod } from "./odooStats";

describe("productSeries", () => {
  it("folds the sheet's product names however typed, keeps any other product by name, Other only for none", () => {
    expect(productSeries("Tank")).toBe("Tank");
    expect(productSeries(" top  cover ")).toBe("Top Cover");
    expect(productSeries("CB")).toBe("Cable Box");
    expect(productSeries("enclosure")).toBe("Encloser");
    expect(productSeries("Arrester")).toBe("Arrester Bracket");
    expect(productSeries("arrester bracket")).toBe("Arrester Bracket");
    expect(productSeries("Arrestor Bracket")).toBe("Arrester Bracket");
    expect(productSeries("AR")).toBe("Arrester Bracket");
    expect(productSeries("Radiator")).toBe("Radiator");
    expect(productSeries("radiator ")).toBe("Radiator");
    expect(productSeries("RADIATOR")).toBe("Radiator");
    expect(productSeries("oil  pump")).toBe("Oil Pump");
    expect(productSeries("HV Bushing")).toBe("HV Bushing");
    expect(productSeries(null)).toBe("Other");
    expect(productSeries("  ")).toBe("Other");
  });
});

describe("periods", () => {
  const today = new Date(Date.UTC(2026, 8, 7));
  it("reads a preset from the URL, defaulting to 30 days", () => {
    expect(resolvePeriod({ range: "7d" }, today)).toEqual({ range: "7d", fromISO: "2026-09-01", toISO: "2026-09-07" });
    expect(resolvePeriod({ range: "30d" }, today)).toEqual({ range: "30d", fromISO: "2026-08-09", toISO: "2026-09-07" });
    expect(resolvePeriod({ range: "month" }, today)).toEqual({ range: "month", fromISO: "2026-09-01", toISO: "2026-09-07" });
    expect(resolvePeriod({ range: "all" }, today)).toEqual({ range: "all", fromISO: null, toISO: "2026-09-07" });
    expect(resolvePeriod({ range: "today" }, today)).toEqual({ range: "today", fromISO: "2026-09-07", toISO: "2026-09-07" });
    expect(resolvePeriod({ range: "yesterday" }, today)).toEqual({ range: "yesterday", fromISO: "2026-09-06", toISO: "2026-09-06" });
    expect(previousPeriod(resolvePeriod({ range: "today" }, today))).toEqual({ fromISO: "2026-09-06", toISO: "2026-09-06" });
    expect(resolvePeriod({ range: "nope" }, today).range).toBe("30d");
    expect(resolvePeriod({}, today).range).toBe("30d");
  });
  it("reads a custom from/to, swapping them if reversed, and falls back when a date is bad", () => {
    expect(resolvePeriod({ range: "custom", from: "2026-08-01", to: "2026-08-15" }, today)).toEqual({ range: "custom", fromISO: "2026-08-01", toISO: "2026-08-15" });
    expect(resolvePeriod({ range: "custom", from: "2026-08-15", to: "2026-08-01" }, today).fromISO).toBe("2026-08-01");
    expect(resolvePeriod({ range: "custom", from: "soon", to: "2026-08-01" }, today).range).toBe("30d");
  });
  it("finds the previous period of the same length, none for all time", () => {
    expect(previousPeriod({ range: "7d", fromISO: "2026-09-01", toISO: "2026-09-07" })).toEqual({ fromISO: "2026-08-25", toISO: "2026-08-31" });
    expect(previousPeriod({ range: "all", fromISO: null, toISO: "2026-09-07" })).toBeNull();
  });
  it("labels a period and a day", () => {
    expect(shortDayLabel("2026-09-06")).toBe("6 Sep");
    expect(periodLabel({ range: "30d", fromISO: "2026-08-09", toISO: "2026-09-07" })).toBe("9 Aug – 7 Sep 2026");
    expect(periodLabel({ range: "custom", fromISO: "2025-12-20", toISO: "2026-01-05" })).toBe("20 Dec 2025 – 5 Jan 2026");
    expect(periodLabel({ range: "all", fromISO: null, toISO: "2026-09-07" })).toBe("up to 7 Sep 2026");
  });
  it("computes a signed percentage change", () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(80, 100)).toBe(-20);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(5, null)).toBeNull();
  });
});

describe("buildOdooDashboard", () => {
  const rows = [
    { dateISO: "2026-09-06", product: "Tank", qty: 5, status: "Done", doneISO: "2026-09-06" },
    { dateISO: "2026-09-06", product: "Tank", qty: 3, status: "MO to be close" },
    { dateISO: "2026-09-06", product: "Top Cover", qty: 4, status: "Pending" },
    { dateISO: "2026-09-04", product: "Core Frame", qty: 2, status: "Done", doneISO: "2026-09-04" },
    { dateISO: "2026-09-04", product: "Radiator", qty: 1, status: "Done", doneISO: "2026-09-04" },
  ];
  const period = { range: "7d" as const, fromISO: "2026-09-03", toISO: "2026-09-07" };

  it("sums qty per day and per product, filling the quiet days with zero", () => {
    const d = buildOdooDashboard(rows, period);
    expect(d.days.map((x) => x.dateISO)).toEqual(["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]);
    const sixth = d.days.find((x) => x.dateISO === "2026-09-06")!;
    expect(sixth.qty).toBe(12);
    expect(sixth.rows).toBe(3);
    expect(sixth.bySeries.Tank).toBe(8);
    expect(sixth.bySeries["Top Cover"]).toBe(4);
    expect(sixth.bySeries["Core Frame"]).toBe(0);
    expect(sixth.doneQty).toBe(5);
    const fourth = d.days.find((x) => x.dateISO === "2026-09-04")!;
    expect(fourth.bySeries.Radiator).toBe(1);
    expect(sixth.bySeries.Radiator).toBe(0);
    expect(d.series).toEqual(["Tank", "Top Cover", "Core Frame", "Radiator"]);
    expect(d.days.find((x) => x.dateISO === "2026-09-05")!.qty).toBe(0);
  });

  it("totals per product in the fixed order, only the products that appear, with their share", () => {
    const d = buildOdooDashboard(rows, period);
    expect(d.totals.map((t) => [t.series, t.qty, t.rows, t.share])).toEqual([
      ["Tank", 8, 2, 53.3], ["Top Cover", 4, 1, 26.7], ["Core Frame", 2, 1, 13.3], ["Radiator", 1, 1, 6.7],
    ]);
    expect(d.totals.every((t) => t.prevQty === null)).toBe(true);
    expect(d.previous).toBeNull();
  });

  it("carries the headline numbers", () => {
    const d = buildOdooDashboard(rows, period);
    expect(d.kpi).toEqual({
      qty: 15, rows: 5, loggedQty: 15, loggedRows: 5, doneRows: 3, doneQty: 8, doneNowRows: 3,
      activeDays: 2, qtyPerActiveDay: 7.5, prevQty: null, prevRows: null,
    });
    expect(d.basis).toBe("logged");
  });

  it("compares against the previous period, per product and overall", () => {
    const prev = [
      { dateISO: "2026-08-30", product: "Tank", qty: 4, status: "Done", doneISO: "2026-08-30" },
      { dateISO: "2026-08-31", product: "Encloser", qty: 6, status: "Done", doneISO: "2026-08-31" },
    ];
    const d = buildOdooDashboard(rows, period, prev);
    expect(d.previous).toEqual({ fromISO: "2026-08-29", toISO: "2026-09-02" });
    expect(d.kpi.prevQty).toBe(10);
    expect(d.kpi.prevRows).toBe(2);
    expect(d.totals.find((t) => t.series === "Tank")!.prevQty).toBe(4);
    expect(d.totals.find((t) => t.series === "Top Cover")!.prevQty).toBe(0);
  });

  it("shows only the logged days on an open-ended range that spans too long", () => {
    const far = [{ dateISO: "2025-01-01", product: "Tank", qty: 1, status: "Done", doneISO: "2025-01-01" }, ...rows];
    const d = buildOdooDashboard(far, { range: "all", fromISO: null, toISO: "2026-09-07" });
    expect(d.days.map((x) => x.dateISO)).toEqual(["2025-01-01", "2026-09-04", "2026-09-06"]);
  });

  it("puts new products after the sheet's, biggest first, and a nameless row last as Other", () => {
    const d = buildOdooDashboard([
      { dateISO: "2026-09-06", product: "Radiator", qty: 2, status: "Done", doneISO: "2026-09-06" },
      { dateISO: "2026-09-06", product: "Oil Pump", qty: 9, status: "Done", doneISO: "2026-09-06" },
      { dateISO: "2026-09-06", product: "", qty: 1, status: "Done", doneISO: "2026-09-06" },
      { dateISO: "2026-09-06", product: "Encloser", qty: 1, status: "Done", doneISO: "2026-09-06" },
      { dateISO: "2026-09-06", product: "Tank", qty: 1, status: "Done", doneISO: "2026-09-06" },
    ], period);
    expect(d.series).toEqual(["Tank", "Encloser", "Oil Pump", "Radiator", "Other"]);
    expect(d.totals.map((t) => t.series)).toEqual(d.series);
    expect(d.days.find((x) => x.dateISO === "2026-09-03")!.bySeries).toEqual({ Tank: 0, Encloser: 0, "Oil Pump": 0, Radiator: 0, Other: 0 });
  });

  it("compares a new product with the previous period too", () => {
    const prev = [{ dateISO: "2026-08-30", product: "Radiator", qty: 3, status: "Done", doneISO: "2026-08-30" }];
    const d = buildOdooDashboard(rows, period, prev);
    expect(d.totals.find((t) => t.series === "Radiator")!.prevQty).toBe(3);
  });

  it("counts a close on the day the status went to Done, not the day the row was logged", () => {
    const d = buildOdooDashboard([
      { dateISO: "2026-09-03", product: "Tank", qty: 5, status: "Done", doneISO: "2026-09-07" },
      { dateISO: "2026-09-04", product: "Tank", qty: 2, status: "Pending", doneISO: null },
    ], period);
    const third = d.days.find((x) => x.dateISO === "2026-09-03")!;
    const seventh = d.days.find((x) => x.dateISO === "2026-09-07")!;
    expect([third.qty, third.doneQty]).toEqual([5, 0]);
    expect([seventh.qty, seventh.doneQty, seventh.doneRows]).toEqual([0, 5, 1]);
    expect(d.kpi.doneQty).toBe(5);
    expect(d.kpi.doneRows).toBe(1);
    expect(d.kpi.doneNowRows).toBe(1);
    expect(d.kpi.rows).toBe(2);
  });

  it("counts a row logged before the period among its closings, and one closed after it not", () => {
    const d = buildOdooDashboard([
      { dateISO: "2026-08-20", product: "Tank", qty: 4, status: "Done", doneISO: "2026-09-05" },
      { dateISO: "2026-09-06", product: "Tank", qty: 3, status: "Done", doneISO: "2026-09-12" },
    ], period);
    expect(d.kpi.qty).toBe(3); // only the row logged in the period
    expect(d.kpi.rows).toBe(1);
    expect(d.kpi.doneQty).toBe(4); // only the close that fell in the period
    expect(d.kpi.doneRows).toBe(1);
    expect(d.kpi.doneNowRows).toBe(1); // the logged row is Done, just not yet inside the period
    expect(d.days.find((x) => x.dateISO === "2026-09-05")!.doneQty).toBe(4);
    expect(d.totals.map((t) => [t.series, t.qty])).toEqual([["Tank", 3]]);
    expect(d.kpi.activeDays).toBe(1);
  });

  it("on the closed basis, spreads the closings over products and days by the Done day", () => {
    const d = buildOdooDashboard([
      { dateISO: "2026-09-03", product: "Tank", qty: 5, status: "Done", doneISO: "2026-09-07" },
      { dateISO: "2026-09-03", product: "Top Cover", qty: 2, status: "Done", doneISO: "2026-09-07" },
      { dateISO: "2026-09-04", product: "Tank", qty: 9, status: "Pending", doneISO: null },
      { dateISO: "2026-08-20", product: "Radiator", qty: 4, status: "Done", doneISO: "2026-09-05" },
    ], period, null, "closed");
    expect(d.basis).toBe("closed");
    expect(d.series).toEqual(["Tank", "Top Cover", "Radiator"]);
    const seventh = d.days.find((x) => x.dateISO === "2026-09-07")!;
    expect(seventh.qty).toBe(7);
    expect(seventh.rows).toBe(2);
    expect(seventh.bySeries).toEqual({ Tank: 5, "Top Cover": 2, Radiator: 0 });
    expect([seventh.loggedQty, seventh.doneQty]).toEqual([0, 7]);
    const third = d.days.find((x) => x.dateISO === "2026-09-03")!;
    expect([third.qty, third.loggedQty, third.doneQty]).toEqual([0, 7, 0]);
    expect(d.totals.map((t) => [t.series, t.qty, t.share])).toEqual([["Tank", 5, 45.5], ["Top Cover", 2, 18.2], ["Radiator", 4, 36.4]]);
    expect(d.kpi).toEqual({
      qty: 11, rows: 3, loggedQty: 16, loggedRows: 3, doneQty: 11, doneRows: 3, doneNowRows: 2,
      activeDays: 2, qtyPerActiveDay: 5.5, prevQty: null, prevRows: null,
    });
  });

  it("compares the closed basis with the previous period's closings", () => {
    const prev = [
      { dateISO: "2026-08-30", product: "Tank", qty: 4, status: "Done", doneISO: "2026-09-04" }, // closed inside THIS period
      { dateISO: "2026-08-20", product: "Tank", qty: 9, status: "Done", doneISO: "2026-08-30" }, // closed in the previous one
    ];
    const d = buildOdooDashboard(rows, period, prev, "closed");
    expect(d.kpi.prevQty).toBe(9);
    expect(d.kpi.prevRows).toBe(1);
    expect(d.totals.find((t) => t.series === "Tank")!.prevQty).toBe(9);
  });

  it("reads the basis from the URL, closings by default", () => {
    expect(resolveBasis({})).toBe("closed");
    expect(resolveBasis({ basis: "logged" })).toBe("logged");
    expect(resolveBasis({ basis: "nope" })).toBe("closed");
  });

  it("ignores a Done day on a row whose status is no longer Done", () => {
    const d = buildOdooDashboard([{ dateISO: "2026-09-06", product: "Tank", qty: 3, status: "Pending", doneISO: "2026-09-06" }], period);
    expect(d.kpi.doneQty).toBe(0);
  });

  it("keeps the previous period to rows logged in it", () => {
    const prev = [
      { dateISO: "2026-08-30", product: "Tank", qty: 4, status: "Done", doneISO: "2026-09-04" },
      { dateISO: "2026-08-20", product: "Tank", qty: 9, status: "Done", doneISO: "2026-08-30" }, // logged before, closed inside
    ];
    const d = buildOdooDashboard(rows, period, prev);
    expect(d.kpi.prevQty).toBe(4);
    expect(d.kpi.prevRows).toBe(1);
  });

  it("is empty but well-formed with no rows", () => {
    const d = buildOdooDashboard([], { range: "30d", fromISO: "2026-08-09", toISO: "2026-09-07" });
    expect(d.days).toHaveLength(30);
    expect(d.totals).toEqual([]);
    expect(d.series).toEqual([]);
    expect(d.kpi.qtyPerActiveDay).toBe(0);
  });
});

describe("narrowing the dashboard to one BOM", () => {
  const period = { range: "custom" as const, fromISO: "2026-09-01", toISO: "2026-09-03" };
  const r = (dateISO: string, bom: string, qty: number, product = "Tank"): OdooStatRow =>
    ({ dateISO, product, qty, status: "Done", doneISO: dateISO, bom });
  const rows = [
    r("2026-09-01", "14003E11M11", 4),
    r("2026-09-01", "12008E16M18", 3, "Top Cover"),
    r("2026-09-02", "14003E11M11", 5),
    r("2026-09-02", "", 2),
    r("2026-08-20", "71005E14M16", 9), // outside the period
  ];

  it("reads the BOM from the URL, with all and none spelled out", () => {
    expect(resolveBom({})).toBeNull();
    expect(resolveBom({ bom: " " })).toBeNull();
    expect(resolveBom({ bom: "all" })).toBeNull();
    expect(resolveBom({ bom: "none" })).toBe("");
    expect(resolveBom({ bom: "14003e11m11" })).toBe("14003E11M11");
  });

  it("matches a row against the chosen BOM, and every row when none is chosen", () => {
    expect(matchesBom(rows[0], null)).toBe(true);
    expect(matchesBom(rows[0], "14003E11M11")).toBe(true);
    expect(matchesBom(rows[0], "12008E16M18")).toBe(false);
    expect(matchesBom(rows[3], "")).toBe(true);
    expect(matchesBom(rows[0], "")).toBe(false);
  });

  it("offers the BOMs the period holds, by name, the codeless ones last", () => {
    expect(bomOptions(rows, period, "closed")).toEqual([
      { bom: "12008E16M18", rows: 1, qty: 3 },
      { bom: "14003E11M11", rows: 2, qty: 9 },
      { bom: "", rows: 1, qty: 2 },
    ]);
  });

  it("counts only the chosen BOM's rows", () => {
    const d = buildOdooDashboard(rows, period, null, "closed", "14003E11M11");
    expect(d.kpi.qty).toBe(9);
    expect(d.kpi.rows).toBe(2);
    expect(d.series).toEqual(["Tank"]);
    expect(d.bom).toBe("14003E11M11");
  });

  it("still offers every BOM once one is chosen — the list is the way back", () => {
    const d = buildOdooDashboard(rows, period, null, "closed", "14003E11M11");
    expect(d.boms.map((b) => b.bom)).toEqual(["12008E16M18", "14003E11M11", ""]);
  });

  it("narrows the comparison period the same way", () => {
    const prev = [r("2026-08-30", "14003E11M11", 2), r("2026-08-30", "12008E16M18", 100)];
    const d = buildOdooDashboard(rows, period, prev, "closed", "14003E11M11");
    expect(d.kpi.prevQty).toBe(2);
  });

  it("counts everything when no BOM is chosen", () => {
    const d = buildOdooDashboard(rows, period, null, "closed");
    expect(d.kpi.qty).toBe(14);
    expect(d.bom).toBeNull();
  });
});

describe("narrowing the dashboard to one product (a click on its card)", () => {
  const period = { range: "custom" as const, fromISO: "2026-09-01", toISO: "2026-09-03" };
  const r = (dateISO: string, product: string, qty: number, bom = "14003E11M11"): OdooStatRow =>
    ({ dateISO, product, qty, status: "Done", doneISO: dateISO, bom });
  const rows = [
    r("2026-09-01", "Tank", 4),
    r("2026-09-01", "Top Cover", 3),
    r("2026-09-02", "tn", 5), // the sheet's abbreviation — a Tank row too
    r("2026-09-02", "Cable Box", 2, "12008E16M18"),
    r("2026-08-20", "Tank", 9), // outside the period
  ];

  it("reads the product from the URL, folded onto its series", () => {
    expect(resolveProduct({})).toBeNull();
    expect(resolveProduct({ product: " " })).toBeNull();
    expect(resolveProduct({ product: "all" })).toBeNull();
    expect(resolveProduct({ product: "Tank" })).toBe("Tank");
    expect(resolveProduct({ product: "cb" })).toBe("Cable Box");
    expect(resolveProduct({ product: "radiator" })).toBe("Radiator");
  });

  it("matches a row on its series, and every row when no product is chosen", () => {
    expect(matchesProduct(rows[0], null)).toBe(true);
    expect(matchesProduct(rows[0], "Tank")).toBe(true);
    expect(matchesProduct(rows[2], "Tank")).toBe(true);
    expect(matchesProduct(rows[1], "Tank")).toBe(false);
  });

  it("counts only the chosen product's rows, under the BOM narrowing", () => {
    const d = buildOdooDashboard(rows, period, null, "closed", null, "prev", "Tank");
    expect(d.product).toBe("Tank");
    expect(d.kpi.qty).toBe(9);
    expect(d.kpi.rows).toBe(2);
    expect(d.series).toEqual(["Tank"]);
    expect(d.totals).toEqual([{ series: "Tank", qty: 9, rows: 2, share: 100, prevQty: null }]);
    expect(d.days.map((p) => p.qty)).toEqual([4, 5, 0]);
    const both = buildOdooDashboard(rows, period, null, "closed", "14003E11M11", "prev", "Cable Box");
    expect(both.kpi.rows).toBe(0);
  });

  it("still offers every product's card once one is chosen, with its share of the whole and its own days", () => {
    const d = buildOdooDashboard(rows, period, null, "closed", null, "prev", "Tank");
    expect(d.products.map((t) => t.series)).toEqual(["Tank", "Top Cover", "Cable Box"]);
    expect(d.products.map((t) => t.share)).toEqual([64.3, 21.4, 14.3]);
    expect(d.products.find((t) => t.series === "Top Cover")?.qty).toBe(3);
    // the sparkline of a card that is NOT chosen still has its shape
    expect(d.products.map((t) => t.daily)).toEqual([[4, 5, 0], [3, 0, 0], [0, 2, 0]]);
  });

  it("keeps the other products' days on the axis of a long period that only lists logged days", () => {
    const d = buildOdooDashboard([r("2026-01-10", "Tank", 1), r("2026-06-10", "Top Cover", 2)], { range: "all", fromISO: null, toISO: "2026-09-07" }, null, "closed", null, "prev", "Tank");
    expect(d.days.map((p) => p.dateISO)).toEqual(["2026-01-10", "2026-06-10"]);
    expect(d.days.map((p) => p.qty)).toEqual([1, 0]);
    expect(d.products.find((t) => t.series === "Top Cover")?.daily).toEqual([0, 2]);
  });

  it("narrows the comparison the same way, on the charts and on the cards", () => {
    const prev = [r("2026-08-30", "Tank", 2), r("2026-08-30", "Top Cover", 100)];
    const d = buildOdooDashboard(rows, period, prev, "closed", null, "prev", "Tank");
    expect(d.kpi.prevQty).toBe(2);
    expect(d.totals[0].prevQty).toBe(2);
    expect(d.products.find((t) => t.series === "Top Cover")?.prevQty).toBe(100);
  });

  it("is the same dashboard as before when no product is chosen", () => {
    const d = buildOdooDashboard(rows, period, null, "closed");
    expect(d.product).toBeNull();
    expect(d.products.map((t) => ({ series: t.series, qty: t.qty, rows: t.rows, share: t.share, prevQty: t.prevQty }))).toEqual(d.totals);
    expect(d.products[0].daily).toEqual(d.days.map((p) => p.bySeries.Tank));
    expect(d.kpi.qty).toBe(14);
  });
});

describe("comparePeriod", () => {
  const p = (fromISO: string, toISO: string) => ({ range: "custom" as const, fromISO, toISO });
  it("the days just before, as many", () => {
    expect(comparePeriod(p("2026-10-01", "2026-10-11"), "prev")).toEqual({ fromISO: "2026-09-20", toISO: "2026-09-30" });
  });
  it("the same days last month, kept inside the shorter month", () => {
    expect(comparePeriod(p("2026-10-01", "2026-10-11"), "lastMonth")).toEqual({ fromISO: "2026-09-01", toISO: "2026-09-11" });
    expect(comparePeriod(p("2026-03-29", "2026-03-31"), "lastMonth")).toEqual({ fromISO: "2026-02-28", toISO: "2026-02-28" });
    expect(comparePeriod(p("2026-01-05", "2026-01-10"), "lastMonth")).toEqual({ fromISO: "2025-12-05", toISO: "2025-12-10" });
  });
  it("the same days last week and last year", () => {
    expect(comparePeriod(p("2026-10-05", "2026-10-11"), "lastWeek")).toEqual({ fromISO: "2026-09-28", toISO: "2026-10-04" });
    expect(comparePeriod(p("2026-10-01", "2026-10-11"), "lastYear")).toEqual({ fromISO: "2025-10-01", toISO: "2025-10-11" });
  });
  it("none, or an unbounded period, compares with nothing", () => {
    expect(comparePeriod(p("2026-10-01", "2026-10-11"), "none")).toBeNull();
    expect(comparePeriod({ range: "all", fromISO: null, toISO: "2026-10-11" }, "lastMonth")).toBeNull();
  });
});
