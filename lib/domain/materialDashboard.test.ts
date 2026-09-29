import { describe, expect, it } from "vitest";
import { buildMaterialDashboard, utilizationFraction, type SheetLine } from "./materialDashboard";

const L = (over: Partial<SheetLine>): SheetLine => ({
  mo: "SF01/MO/1", soi: "S1", bom: "B1", partCode: "FB-022", partName: "TANK", material: "HR Sheet", thicknessMm: 3, sheetSize: "1220x2440",
  units: 10, sheetsPerUnit: 1, actualPerUnit: null, sheetsUsed: null, weightKg: 100, utilization: null, ...over,
});

describe("utilizationFraction", () => {
  it("reads 0.86 and 86 alike, and nothing as unknown", () => {
    expect(utilizationFraction(0.86)).toBeCloseTo(0.86);
    expect(utilizationFraction(86)).toBeCloseTo(0.86);
    expect(utilizationFraction(null)).toBeNull();
    expect(utilizationFraction(0)).toBeNull();
  });
});

describe("buildMaterialDashboard", () => {
  const lines = [
    L({ actualPerUnit: 0.8, sheetsUsed: 8, utilization: 0.75 }), // nested: 8 sheets = 800 kg, scrap 200 kg, BOM 10 → saved 2
    L({ thicknessMm: 5, weightKg: 200, sheetsPerUnit: 0.5 }), // not nested: BOM 5 sheets = 1000 kg
    L({ mo: "SF01/MO/2", partCode: "FB-051", partName: "TOP COVER", units: 4, sheetsPerUnit: 1, sheetsUsed: 6, utilization: 90 }), // over BOM by 2 sheets
  ];
  const d = buildMaterialDashboard(lines, [
    { dateISO: "2026-09-20", mo: "sf01/mo/1", qty: 4 },
    { dateISO: "2026-09-29", mo: "SF01/MO/1", qty: 2 },
    { dateISO: "2026-09-29", mo: "SF01/MO/99", qty: 50 }, // not on the sheet: ignored
  ], "2026-09-25");

  it("books only the window's closings of the sheet's MOs, at the nesting's rate", () => {
    // 2 units × (0.8 × 100 kg + 0.5 × 200 kg)
    expect(d.consumed).toMatchObject({ units: 2, closings: 1, mos: 1, sheets: 2.6, kg: 360 });
    // scrap only where utilization is known: 1.6 sheets × 100 kg × 25 %
    expect(d.consumed.scrapKg).toBe(40);
    expect(d.days.map((x) => x.dateISO)).toEqual(["2026-09-29"]);
  });

  it("reads the sheet whole: plan, nesting, overspend, scrap, utilization", () => {
    expect(d.planned).toEqual({ sheets: 19, kg: 2400 });
    expect(d.nested).toMatchObject({ sheets: 14, kg: 1400, lines: 2, linesTotal: 3 });
    expect(d.overBom).toEqual({ sheets: 0, kg: 0 }); // −2 on MO 1, +2 on MO 2
    expect(d.scrap.kg).toBe(260); // 200 + 60
    expect(d.utilization).toBeCloseTo((0.75 * 800 + 0.9 * 600) / 1400);
    expect(d.mos).toEqual({ total: 2, nested: 2, closed: 1, open: 2 });
    expect(d.remaining.units).toBe(4 + 4); // MO 1: 10 − 6, MO 2: 4
    expect(d.topOver.map((m) => m.mo)).toEqual(["SF01/MO/2"]);
    expect(d.topScrap.map((m) => m.mo)).toEqual(["SF01/MO/1", "SF01/MO/2"]);
    expect(d.parts.map((p) => p.item)).toEqual(["TN", "TC"]);
  });
});
