import { describe, expect, it } from "vitest";
import {
  EMPTY_MATERIAL_DASH_FILTERS, buildMaterialDashboard, changePct, orderPartKey, materialQuery, materialRequest, pickSheetVersions, sheetWeight, unitRate,
  utilizationFraction, type DoneRow, type MaterialRequest, type SheetLine,
} from "./materialDashboard";

const L = (over: Partial<SheetLine>): SheetLine => ({
  month: "", mo: "SF01/MO/1", soi: "S1", bom: "B1", partCode: "FB-022", partName: "TANK", material: "HR Sheet", thicknessMm: 3, sheetSize: "1220x2440",
  units: 10, sheetsPerUnit: 1, actualPerUnit: null, sheetsUsed: null, weightKg: 100, utilization: null, ...over,
});

const REQ: MaterialRequest = {
  view: "consumption", by: "thickness", fromISO: "2026-09-25", toISO: "2026-09-30",
  prev: { fromISO: "2026-09-19", toISO: "2026-09-24" }, filters: EMPTY_MATERIAL_DASH_FILTERS,
};

describe("utilizationFraction", () => {
  it("reads 0.86 and 86 alike, and nothing as unknown", () => {
    expect(utilizationFraction(0.86)).toBeCloseTo(0.86);
    expect(utilizationFraction(86)).toBeCloseTo(0.86);
    expect(utilizationFraction(null)).toBeNull();
    expect(utilizationFraction(0)).toBeNull();
  });
});

describe("one line's figures", () => {
  it("takes the sheet's weight first, then size × thickness × density, else unknown — never zero", () => {
    expect(sheetWeight(L({ weightKg: 70 }))).toEqual({ kg: 70, source: "sheet" });
    const computed = sheetWeight(L({ weightKg: null, sheetSize: "1000*2000", thicknessMm: 2, material: "Steel" }));
    expect(computed.source).toBe("computed");
    expect(computed.kg).toBeCloseTo(2 * 0.002 * 7850);
    expect(sheetWeight(L({ weightKg: null, sheetSize: "odd" }))).toEqual({ kg: null, source: "unknown" });
  });

  it("uses the nesting's rate, else the BOM's — and says which", () => {
    expect(unitRate(L({ actualPerUnit: 0.8 }))).toEqual({ perUnit: 0.8, source: "actual" });
    expect(unitRate(L({ sheetsUsed: 12, units: 10 }))).toEqual({ perUnit: 1.2, source: "actual" });
    expect(unitRate(L({}))).toEqual({ perUnit: 1, source: "bom" });
  });
});

describe("pickSheetVersions", () => {
  it("reads each MO from one sheet: the living one, else the newest month — older months stay in", () => {
    const { lines, versions } = pickSheetVersions([
      L({ month: "" }),
      L({ month: "August 2026", sheetsPerUnit: 9 }), // an older copy of MO 1: skipped
      L({ month: "July 2026", mo: "SF01/MO/2" }),
      L({ month: "August 2026", mo: "SF01/MO/2", thicknessMm: 5 }), // the newer copy of MO 2 wins, all its lines
      L({ month: "August 2026", mo: "SF01/MO/2", thicknessMm: 6 }),
      L({ month: "July 2026", mo: "SF01/MO/3" }), // only July has it: kept
    ]);
    expect(lines.map((l) => `${l.mo}|${l.month}|${l.thicknessMm}`)).toEqual([
      "SF01/MO/1||3", "SF01/MO/2|August 2026|5", "SF01/MO/2|August 2026|6", "SF01/MO/3|July 2026|3",
    ]);
    expect(versions).toEqual({ livingLines: 1, archivedLines: 3, archivedMonths: ["August 2026", "July 2026"], skippedLines: 2 });
  });
});

describe("buildMaterialDashboard", () => {
  const sheet = [
    // MO 1: two material lines, one nested (actual 0.8/unit), one not (BOM 0.5/unit)
    L({ actualPerUnit: 0.8, sheetsUsed: 8, utilization: 0.75 }),
    L({ thicknessMm: 5, weightKg: 200, sheetsPerUnit: 0.5 }),
    // MO 2: nested over its BOM, utilization 90 written as a percent
    L({ mo: "SF01/MO/2", partCode: "FB-051", partName: "TOP COVER", units: 4, sheetsUsed: 6, utilization: 90 }),
    // MO 3: no weight, no readable size — its tonnes unknown
    L({ mo: "SF01/MO/3", partCode: "FB-051", partName: "TOP COVER", units: 2, weightKg: null, sheetSize: "?", sheetsUsed: 2 }),
    // a blank-MO line: on the plan, never matched to a closing
    L({ mo: "", bom: "B9", units: 1 }),
  ];
  const done: DoneRow[] = [
    { dateISO: "2026-09-20", mo: "sf01/mo/1", qty: 4 }, // the period before
    { dateISO: "2026-09-29", mo: "SF01/MO/1", qty: 2 }, // partial close of MO 1
    { dateISO: "2026-09-30", mo: "SF01/MO/3", qty: 1 },
    { dateISO: "2026-09-29", mo: "SF01/MO/99", qty: 50 }, // not on the sheet
    { dateISO: "2026-09-29", mo: "", qty: 7 }, // blank MO: never linked
    { dateISO: "2026-09-29", mo: "  ", qty: 3 },
  ];
  const d = buildMaterialDashboard(sheet, done, REQ);

  it("books the period's closings once each, at each line's rate, whatever the number of lines", () => {
    // MO 1: 2 units × (0.8 × 100 kg + 0.5 × 200 kg) = 360 kg; MO 3: 1 × 1 sheet of unknown weight
    expect(d.consumption).toMatchObject({ closings: 2, units: 3, mos: 2, sheets: 3.6, kg: 360, unknownWeightSheets: 1, days: 2 });
    // the 0.5/unit line is at the BOM's rate — an estimate, said apart
    expect(d.consumption).toMatchObject({ bomRateSheets: 1, bomRateKg: 200 });
    // scrap only on the kg whose utilization is known: 1.6 sheets × 100 kg × 25 %
    expect(d.consumption).toMatchObject({ scrapKg: 40, utilizationKg: 160, netKg: 120 });
    expect(d.days.map((x) => [x.dateISO, x.units, x.kg])).toEqual([["2026-09-29", 2, 360], ["2026-09-30", 1, 0]]);
  });

  it("says how the period's closings link: blank MO, off the sheet, linked — by rows and by quantity", () => {
    expect(d.link).toMatchObject({ rows: 5, qty: 63, blankRows: 2, blankQty: 10, offSheetRows: 1, offSheetQty: 50, linkedRows: 2, linkedQty: 3 });
    expect(d.link.offSheetMos).toEqual([{ mo: "SF01/MO/99", qty: 50 }]);
  });

  it("compares the period with the one before only where there is a base", () => {
    expect(d.prevConsumption).toMatchObject({ units: 4, kg: 720 });
    expect(changePct(d.consumption.kg, d.prevConsumption?.kg)).toBe(-50);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(5, null)).toBeNull();
  });

  it("reads the nesting whole: plan, nested, variance on the same lines, weighted utilization", () => {
    // BOM: 10 + 5 + 4 sheets of known weight (1000 + 1000 + 400 kg), MO 3's 2 and the blank line's 1 sheet
    expect(d.nesting.planned).toMatchObject({ sheets: 22, kg: 2500, unknownWeightSheets: 2, lines: 5, mos: 3 });
    expect(d.nesting.nested).toMatchObject({ sheets: 16, kg: 1400, unknownWeightSheets: 2, lines: 3, mos: 3 });
    // nested lines only: (8 − 10) + (6 − 4) + (2 − 2) sheets; kg on the weighed ones
    expect(d.nesting.variance).toMatchObject({ sheets: 0, kg: 0, bomSheets: 16, lines: 3 });
    expect(d.nesting.utilization).toBeCloseTo((0.75 * 800 + 0.9 * 600) / 1400);
    expect(d.nesting).toMatchObject({ utilizationKg: 1400, scrapKg: 260, netKg: 1140, unknownUtilKg: 0 });
  });

  it("keeps an unknown utilization unknown — no scrap, no 100 %", () => {
    const x = buildMaterialDashboard([L({ sheetsUsed: 10 })], [{ dateISO: "2026-09-29", mo: "SF01/MO/1", qty: 5 }], REQ);
    expect(x.nesting.utilization).toBeNull();
    expect(x.nesting).toMatchObject({ scrapKg: 0, utilizationKg: 0, unknownUtilKg: 1000 });
    expect(x.consumption).toMatchObject({ kg: 500, scrapKg: 0, utilizationKg: 0 });
    expect(x.rows[0].scrapKg).toBeNull();
    expect(x.totals.scrapKg).toBeNull();
  });

  it("the detail table adds up to the cards — closed units once per MO, not once per line", () => {
    expect(d.rowsTotal).toBe(3); // MO 1's two lines and MO 3's
    // one key per line, even where two lines share MO, part and sheet spec (the panels' sheet has no part codes)
    const twins = buildMaterialDashboard([L({ partCode: "", partName: "USS" }), L({ partCode: "", partName: "LSS" })], [], { ...REQ, view: "nesting" });
    expect(new Set(twins.rows.map((r) => r.key)).size).toBe(2);
    const mo1 = d.rows.filter((r) => r.mo === "SF01/MO/1");
    expect(mo1.map((r) => r.closedQty)).toEqual([2, 2]); // the MO's quantity, on each of its lines
    expect(d.totals).toMatchObject({ closedQty: d.consumption.units, consumedSheets: d.consumption.sheets, consumedKg: d.consumption.kg, scrapKg: d.consumption.scrapKg, mos: 2 });
    expect(d.rows.find((r) => r.mo === "SF01/MO/3")?.consumedKg).toBeNull();
    expect(mo1.find((r) => r.thicknessMm === 5)?.rateSource).toBe("bom");

    const n = buildMaterialDashboard(sheet, done, { ...REQ, view: "nesting" });
    expect(n.rowsTotal).toBe(5);
    expect(n.totals).toMatchObject({ bomSheets: n.nesting.planned.sheets, actualSheets: n.nesting.nested.sheets, deltaSheets: n.nesting.variance.sheets, units: 10 + 4 + 2 + 1 });
  });

  it("narrows everything to the groups picked", () => {
    const t = buildMaterialDashboard(sheet, done, { ...REQ, filters: { ...EMPTY_MATERIAL_DASH_FILTERS, thicknessMm: 5 } });
    // only MO 1's 5 mm line: 2 units × 0.5 × 200 kg — and its closing's units still once
    expect(t.consumption).toMatchObject({ units: 2, kg: 200, sheets: 1 });
    expect(t.nesting.planned).toMatchObject({ sheets: 5, kg: 1000 });
    const p = buildMaterialDashboard(sheet, done, { ...REQ, filters: { ...EMPTY_MATERIAL_DASH_FILTERS, part: "top cover" } });
    expect(p.nesting.planned.mos).toBe(2);
    // the link coverage stays the line's own, before filters
    expect(p.link.rows).toBe(5);
  });

  it("finds the overruns and what to do", () => {
    expect(d.overruns.map((o) => [o.mo, o.deltaSheets, o.deltaKg])).toEqual([["SF01/MO/2", 2, 200]]);
    expect(d.parts.find((p) => p.partCode === "FB-022")).toMatchObject({ item: "TN", bomSheets: 10, actualSheets: 8, lines: 1 });
    expect(d.actions.map((a) => a.target.kind)).toEqual(["odoo", "material", "material", "material", "material", "filter"]);
  });

  it("links a backorder to the MO it came from, as the ODOO tab does", () => {
    const x = buildMaterialDashboard([L({})], [
      { dateISO: "2026-09-29", mo: "SF01/MO/1-002", qty: 2 }, // a backorder of MO 1
      { dateISO: "2026-09-29", mo: "SF01/MO/12", qty: 1 }, // another MO, not a backorder
    ], REQ);
    expect(x.link).toMatchObject({ linkedRows: 1, offSheetRows: 1 });
    expect(x.consumption).toMatchObject({ units: 2, kg: 200 });
    // and a closing of the parent finds the sheet's backorder line
    const y = buildMaterialDashboard([L({ mo: "SF01/MO/7-001" })], [{ dateISO: "2026-09-29", mo: "SF01/MO/7", qty: 1 }], REQ);
    expect(y.link.linkedRows).toBe(1);
  });

  it("books a closing against its part only, where the sheet files the transformer's MO", () => {
    const order = "PF01/MO/35256-005";
    const sheet = [
      L({ mo: order, partCode: "FB-022", closingKey: orderPartKey(order, "FB-022"), weightKg: 100 }),
      L({ mo: order, partCode: "FB-051", partName: "TOP COVER", closingKey: orderPartKey(order, "FB-051"), weightKg: 50 }),
    ];
    const x = buildMaterialDashboard(sheet, [{ dateISO: "2026-09-29", mo: orderPartKey(order, "fb-022"), qty: 2 }], REQ);
    expect(x.link.linkedRows).toBe(1);
    // the tank's two units × 1 sheet × 100 kg — the top cover is not touched
    expect(x.consumption).toMatchObject({ units: 2, kg: 200 });
    // an order × part the sheet does not carry is off the sheet, never a "backorder" of another order
    const y = buildMaterialDashboard(sheet, [{ dateISO: "2026-09-29", mo: orderPartKey("PF01/MO/35256-006", "FB-022"), qty: 1 }], REQ);
    expect(y.link).toMatchObject({ linkedRows: 0, offSheetRows: 1 });
  });

  it("each group of the breakdown carries its own filter — a blank one none", () => {
    const x = buildMaterialDashboard([L({}), L({ mo: "SF01/MO/2", material: "" })], [], { ...REQ, by: "material" });
    expect(x.breakdown.map((b) => [b.key, b.filter])).toEqual(expect.arrayContaining([["HR Sheet", { material: "HR Sheet" }], ["—", null]]));
  });

  it("sums up the coverage once: shares, the partial verdict and the period changes", () => {
    expect(d.summary).toMatchObject({ linkRows: 2 / 5, actualRate: 1 - 1 / 3.6, partial: true, consumptionChangePct: -50 });
    // the period before had a known utilization (MO 1's 0.75 line), so its scrap compares
    expect(d.summary.scrapChangePct).toBe(-50);
    const none = buildMaterialDashboard([L({ sheetsUsed: 10 })], [{ dateISO: "2026-09-29", mo: "SF01/MO/1", qty: 5 }], REQ);
    expect(none.summary.scrapChangePct).toBeNull();
  });

  it("an MO closed past its units is flagged", () => {
    const x = buildMaterialDashboard([L({ units: 2 })], [{ dateISO: "2026-09-29", mo: "SF01/MO/1", qty: 3 }], REQ);
    expect(x.link.overClosedMos).toBe(1);
  });

  it("reads the panels' sheet partially: no part, no weight, no utilization", () => {
    const lv = [
      L({ partCode: "", partName: "USS", weightKg: null, sheetSize: "1250*2500", thicknessMm: 2, material: "Steel", units: 3, sheetsPerUnit: 2, actualPerUnit: 1.8 }),
      L({ mo: "LV/MO/2", partCode: "", partName: "LSS", weightKg: null, sheetSize: "1250*2500", thicknessMm: 1.5, material: "Steel", units: 1, sheetsPerUnit: 4 }),
    ];
    const x = buildMaterialDashboard(lv, [{ dateISO: "2026-09-29", mo: "SF01/MO/1", qty: 1 }], REQ);
    expect(x.consumption.sheets).toBe(1.8);
    expect(x.consumption.kg).toBeGreaterThan(0);
    expect(x.nesting.utilization).toBeNull();
    expect(x.coverage).toMatchObject({ lines: 2, nestedLines: 1, utilizationLines: 0, actualRateLines: 1 });
    expect(x.coverage.weight).toEqual({ sheet: 0, computed: 2, unknown: 0 });
  });
});

describe("materialRequest", () => {
  const today = "2026-10-26";
  it("opens on the last 90 days of consumption, by thickness", () => {
    const r = materialRequest({}, today);
    expect(r).toMatchObject({ view: "consumption", by: "thickness", fromISO: "2026-07-29", toISO: today, prev: { fromISO: "2026-04-30", toISO: "2026-07-28" } });
    expect(materialQuery(r, {}, today)).toBe("");
  });

  it("reads the period, the view and the filters, and writes them back", () => {
    const r = materialRequest({ view: "nesting", by: "size", from: "2026-10-10", to: "2026-10-01", thickness: "5", mo: "SF01/MO/1", part: "FB-022" }, today);
    expect(r).toMatchObject({ view: "nesting", by: "size", fromISO: "2026-10-01", toISO: "2026-10-10", prev: { fromISO: "2026-09-21", toISO: "2026-09-30" } });
    expect(r.filters).toMatchObject({ thicknessMm: 5, mo: "SF01/MO/1", part: "FB-022", material: "" });
    expect(materialRequest(Object.fromEntries(new URLSearchParams(materialQuery(r, {}, today))), today)).toEqual(r);
  });

  it("keeps an old ?days= link's window, and all=1 is everything with no period before", () => {
    expect(materialRequest({ days: "30" }, today)).toMatchObject({ fromISO: "2026-09-27", toISO: today });
    expect(materialRequest({ days: "0" }, today)).toMatchObject({ fromISO: null, prev: null });
    expect(materialRequest({ all: "1" }, today)).toMatchObject({ fromISO: null, prev: null });
  });

  it("a period given by its end alone runs back the default length from it", () => {
    expect(materialRequest({ to: "2026-03-31" }, today)).toMatchObject({ fromISO: "2026-01-01", toISO: "2026-03-31" });
  });

  it("ignores nonsense", () => {
    expect(materialRequest({ view: "x", by: "y", from: "nope", thickness: "-3" }, today)).toMatchObject({ view: "consumption", by: "thickness", fromISO: "2026-07-29", filters: { thicknessMm: null } });
  });
});
