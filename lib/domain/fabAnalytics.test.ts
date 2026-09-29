import { describe, expect, it } from "vitest";
import { billsOf, buildClosedConsumption, buildFabAnalytics, densityOf, sheetAreaM2, sheetKg, type NestingRow, type OutputRow } from "./fabAnalytics";

const nest = (over: Partial<NestingRow>): NestingRow => ({
  month: "September 2026", bom: "B1", mo: "", partCode: "FB-022", material: "HR Sheet",
  thicknessMm: 5, sheetSize: "1220*2440", sheetsPerUnit: 1, ...over,
});
const out = (over: Partial<OutputRow>): OutputRow => ({ dateISO: "2026-09-10", bom: "B1", item: "TN", qty: 1, ...over });

describe("sheet geometry", () => {
  it("reads the plant's sheet sizes and weighs one", () => {
    expect(sheetAreaM2("1220*2440")).toBeCloseTo(2.9768, 4);
    expect(sheetAreaM2("1500 x 3000")).toBeCloseTo(4.5, 4);
    expect(sheetAreaM2("odd")).toBeNull();
    // 1220×2440 at 5 mm of steel
    expect(sheetKg("1220*2440", 5, "HR Sheet")!).toBeCloseTo(116.8, 1);
    expect(sheetKg("odd", 5, "HR Sheet")).toBeNull();
  });

  it("weighs aluminium and stainless as themselves, anything else as steel", () => {
    expect(densityOf("Aluminium")).toBe(2700);
    expect(densityOf("stainless steel")).toBe(8000);
    expect(densityOf("HR Sheet")).toBe(7850);
    expect(densityOf("something nobody typed before")).toBe(7850);
  });
});

describe("billsOf — a part's bill of sheets", () => {
  it("adds a part's thicknesses into one sheets-per-unit", () => {
    const bills = billsOf([
      nest({ thicknessMm: 5, sheetsPerUnit: 1.2 }),
      nest({ thicknessMm: 3, sheetsPerUnit: 0.8 }),
    ]);
    expect(bills.get("B1|FB-022")!.perUnit).toBe(2);
    expect(bills.get("B1|FB-022")!.lines).toHaveLength(2);
  });

  it("takes the NEWEST month, never the sum of months", () => {
    // the same tank planned twice — 2 sheets then re-nested to 1.5, not 3.5
    const bills = billsOf([
      nest({ month: "July 2026", sheetsPerUnit: 2 }),
      nest({ month: "September 2026", sheetsPerUnit: 1.5 }),
    ]);
    expect(bills.get("B1|FB-022")!.perUnit).toBe(1.5);
  });

  it("averages several MOs of the same month — they describe one part", () => {
    const bills = billsOf([
      nest({ mo: "MO-1", sheetsPerUnit: 2 }),
      nest({ mo: "MO-2", sheetsPerUnit: 4 }),
    ]);
    expect(bills.get("B1|FB-022")!.perUnit).toBe(3);
  });

  it("ignores a line with no part code or no sheets", () => {
    expect(billsOf([nest({ partCode: "" }), nest({ sheetsPerUnit: 0 })]).size).toBe(0);
  });
});

describe("buildFabAnalytics", () => {
  const bill = [
    nest({ bom: "B1", partCode: "FB-022", thicknessMm: 5, sheetsPerUnit: 1 }),
    nest({ bom: "B1", partCode: "FB-022", thicknessMm: 3, sheetsPerUnit: 0.5 }),
    nest({ bom: "B1", partCode: "FB-051", thicknessMm: 3, sheetsPerUnit: 0.25 }),
  ];

  it("turns pieces into sheets through the BOM's own bill", () => {
    const a = buildFabAnalytics([out({ item: "TN", qty: 10 }), out({ item: "TC", qty: 4 })], bill);
    expect(a.pieces).toBe(14);
    expect(a.sheets).toBe(16); // 10×1.5 + 4×0.25
    expect(a.coverage).toBe(1);
  });

  it("weighs the sheets it counted", () => {
    // 10 tanks: 10 sheets at 5 mm (116.8 kg) + 5 at 3 mm (70.1 kg) ≈ 1518 kg
    const a = buildFabAnalytics([out({ item: "TN", qty: 10 })], bill);
    expect(a.tons).toBeCloseTo(1.52, 1);
  });

  it("splits the sheets over the thicknesses that made them", () => {
    const a = buildFabAnalytics([out({ item: "TN", qty: 10 })], bill);
    expect(a.thicknesses.map((t) => [t.thicknessMm, t.sheets])).toEqual([[3, 5], [5, 10]]);
    expect(a.thicknesses.find((t) => t.thicknessMm === 5)!.share).toBeCloseTo(2 / 3, 4);
  });

  it("gives each item the sheets one of its pieces really takes, and the spread", () => {
    // the same item on two BOMs: one light, one heavy — the spread is the point
    const heavy = [...bill, nest({ bom: "B2", partCode: "FB-022", thicknessMm: 5, sheetsPerUnit: 4.5 })];
    const a = buildFabAnalytics([out({ bom: "B1", qty: 10 }), out({ bom: "B2", qty: 10 })], heavy);
    const tn = a.items.find((i) => i.item === "TN")!;
    expect(tn).toMatchObject({ boms: 2, pieces: 20, min: 1.5, max: 4.5, avg: 3 });
  });

  it("takes the spread over BOMs, not over pieces", () => {
    // B1 run a hundred times and B2 once still reads as a 1.5–4.5 spread
    const heavy = [...bill, nest({ bom: "B2", partCode: "FB-022", sheetsPerUnit: 4.5 })];
    const a = buildFabAnalytics([out({ bom: "B1", qty: 100 }), out({ bom: "B2", qty: 1 })], heavy);
    expect(a.items[0]).toMatchObject({ min: 1.5, max: 4.5 });
  });

  it("counts a piece with no bill, and says so instead of flattering the rate", () => {
    const a = buildFabAnalytics([out({ bom: "B1", qty: 10 }), out({ bom: "NOBILL", qty: 10 })], bill);
    expect(a.pieces).toBe(20);
    expect(a.sheets).toBe(15); // only B1's
    expect(a.uncoveredPieces).toBe(10);
    expect(a.coverage).toBe(0.5);
    expect(a.uncoveredBoms).toEqual([{ bom: "NOBILL", pieces: 10 }]);
  });

  it("reports per day, and rates over the days that actually ran", () => {
    const a = buildFabAnalytics(
      [out({ dateISO: "2026-09-10", qty: 10 }), out({ dateISO: "2026-09-11", qty: 2 })],
      bill
    );
    expect(a.days.map((d) => [d.dateISO, d.sheets])).toEqual([["2026-09-10", 15], ["2026-09-11", 3]]);
    expect(a.workedDays).toBe(2);
    expect(a.sheetsPerDay).toBe(9);
  });

  it("keeps a correction in the totals without counting it as a produced BOM", () => {
    const a = buildFabAnalytics([out({ bom: "NOBILL", qty: 10 }), out({ bom: "NOBILL", qty: -3 })], bill);
    expect(a.pieces).toBe(7);
    expect(a.uncoveredBoms).toEqual([{ bom: "NOBILL", pieces: 10 }]);
  });

  it("says nothing rather than dividing by nothing when there is no output", () => {
    const a = buildFabAnalytics([], bill);
    expect(a).toMatchObject({ pieces: 0, sheets: 0, tons: 0, sheetsPerDay: 0, coverage: 0, workedDays: 0 });
    expect(a.days).toEqual([]);
    expect(a.items).toEqual([]);
  });
});

describe("buildClosedConsumption", () => {
  const lines = [
    { mo: "SF01/MO/1", partCode: "FB-022", material: "HR Sheet", thicknessMm: 3, sheetSize: "1220x2440", sheetsPerUnit: 0.8, actualPerUnit: 0.5, weightKg: 70 },
    { mo: "SF01/MO/1", partCode: "FB-022", material: "HR Sheet", thicknessMm: 5, sheetSize: "1220x2440", sheetsPerUnit: 0.2, actualPerUnit: null, weightKg: 117 },
  ];
  it("books the closed qty × each line's sheets on the closing day, by MO", () => {
    const r = buildClosedConsumption([{ dateISO: "2026-09-29", mo: "sf01/mo/1", qty: 10 }, { dateISO: "2026-09-29", mo: "SF01/MO/9", qty: 4 }], lines);
    // actual 0.5 × 10 = 5 sheets of 3 mm, BOM 0.2 × 10 = 2 of 5 mm
    expect(r.sheets).toBe(7);
    expect(r.tons).toBe(Math.round((5 * 70 + 2 * 117) / 100) / 10);
    expect(r.thicknesses.map((t) => [t.thicknessMm, t.sheets])).toEqual([[3, 5], [5, 2]]);
    expect(r.items[0]).toMatchObject({ item: "TN", pieces: 10, avg: 0.7 });
    expect(r.pieces).toBe(14);
    expect(r.uncoveredBoms).toEqual([{ bom: "SF01/MO/9", pieces: 4 }]);
    expect(r.days).toEqual([{ dateISO: "2026-09-29", pieces: 14, uncoveredPieces: 4, sheets: 7, kg: 584 }]);
  });
});
