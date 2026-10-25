import { describe, expect, it } from "vitest";
import { lvActualRate, lvRemainingUnits, parseConsumedCell, parseLvConsumption } from "./lvMaterial";

// the planner's sheet, as sheet_to_json(header:1) hands it over
const grid: unknown[][] = [
  ["Sr.No", "Product", "Sec Item", "Planned qty", "MO", "BOM ", "Material", "Thickness", "Sheet Size", "No. of Sheets In BOM For One Unit", "Sheets Qty as Per Bom ", "Actually Consumed Sheets Qty as per Nesting", "REMARKS"],
  [1, "Uss", 908569105, 12, "SF01/MO/03673-003", "FG-SUA-AS-AA-000004-1", "GI Sheet", "1.5 mm", "1220 × 2440", 1.8, 21.6, 21.6, "Done"],
  [null, null, null, null, null, null, null, "2 mm", "1220 × 2440", 9, 108, 108, null],
  [null, null, null, null, null, null, null, "3 mm", "1220 × 2440", 0.024, 0.288, 0.288, null],
  [2, "Uss", 908569105, 19, "SF01/MO/03673-005", "FG-SUA-AS-AA-000004-1", "GI Sheet", "1.5 mm", "1220 × 2440", 1.8, 34.2, "For 8 Units 14.4 Sheets Consumed", "11 Units Remaining"],
  [null, null, null, null, null, null, null, "2 mm", "1220 × 2440", 9, 171, "For 8 Units 72 Sheets Consumed", null],
  [null, null, null, null, null, null, null, "3 mm", "1220 × 2440", 0.024, 0.456, null, null],
  // a running block whose consumed cell is a bare number — neither Done nor "For N Units"
  [3, "Lss", 908569106, 30, "SF01/MO/03673-007", "FG-SUA-AS-AA-000004-2", "GI Sheet", "1.5 mm", "1220 × 2440", 1.2, 36, 14.4, null],
];

describe("parseLvConsumption", () => {
  const p = parseLvConsumption(grid);
  it("reads one line per thickness, the block's head repeated down its rows", () => {
    expect(p.issues).toEqual([]);
    expect(p.skipped).toBe(0);
    expect(p.rows).toHaveLength(7);
    const r = p.rows[1];
    expect(r).toMatchObject({ mo: "SF01/MO/03673-003", bom: "FG-SUA-AS-AA-000004-1", product: "USS", secItem: "908569105", units: 12, material: "Galvanized steel", thicknessMm: 2, sheetSize: "1220*2440", sheetsPerUnit: 9 });
  });
  it("marks a Done block as fully produced with the job's sheets consumed", () => {
    expect(p.rows[0]).toMatchObject({ done: true, producedQty: 12, consumed: 21.6 });
    expect(p.rows[2]).toMatchObject({ done: true, producedQty: 12, consumed: 0.288 });
  });
  it("reads a running block's 'For N Units X Sheets Consumed'", () => {
    expect(p.rows[3]).toMatchObject({ mo: "SF01/MO/03673-005", units: 19, producedQty: 8, consumed: 14.4, done: false });
    expect(p.rows[4]).toMatchObject({ producedQty: 8, consumed: 72 });
    expect(p.rows[5]).toMatchObject({ producedQty: null, consumed: null });
  });
  it("keeps a bare number short of the job as sheets consumed, with no produced count and not Done", () => {
    expect(p.rows[6]).toMatchObject({ mo: "SF01/MO/03673-007", units: 30, sheetsPerUnit: 1.2, producedQty: null, consumed: 14.4, done: false });
  });
  it("refuses a sheet with no MO / thickness header", () => {
    const bad = parseLvConsumption([["a", "b"], [1, 2]]);
    expect(bad.issues[0]).toMatch(/header/);
    expect(bad.skipped).toBe(0);
  });
  it("counts each thickness row it had to leave out — and only those", () => {
    const g: unknown[][] = [
      grid[0],
      // a thickness row before any order: skipped
      [null, null, null, null, null, null, null, "2 mm", "1220 × 2440", 9, 108, 108, null],
      // no planned qty: a note, 0 assumed — the row is still read
      [1, "Uss", 908569105, null, "SF01/MO/03673-009", "FG-SUA-AS-AA-000004-1", "GI Sheet", "1.5 mm", "1220 × 2440", 1.8, 0, null, null],
      // no sheets-per-unit: skipped
      [null, null, null, null, null, null, null, "3 mm", "1220 × 2440", null, null, null, null],
      // a spacer row (no thickness) is not a skipped row
      [null, null, null, null, null, null, null, null, null, null, null, null, null],
    ];
    const r = parseLvConsumption(g);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toBe(2);
    expect(r.issues.filter((i) => / — skipped\.$/.test(i))).toHaveLength(2);
  });
});

describe("parseConsumedCell", () => {
  it("takes a number as sheets, and the sheet's sentence as units + sheets", () => {
    expect(parseConsumedCell(21.6)).toEqual({ producedQty: null, consumed: 21.6 });
    expect(parseConsumedCell("For 8 Units 14.4 Sheets Consumed")).toEqual({ producedQty: 8, consumed: 14.4 });
    expect(parseConsumedCell("for 1 unit 0.5 sheet consumed")).toEqual({ producedQty: 1, consumed: 0.5 });
    expect(parseConsumedCell("")).toEqual({ producedQty: null, consumed: null });
  });
});

describe("lvActualRate", () => {
  it("is consumed over produced on a running block that states both", () => {
    expect(lvActualRate({ done: false, producedQty: 8, consumed: 14.4 })).toBe(1.8);
    expect(lvActualRate({ done: false, producedQty: 3, consumed: 5 })).toBe(1.6667);
  });
  it("is null when Done, when the cell gave no unit count, or when nothing was consumed", () => {
    expect(lvActualRate({ done: true, producedQty: 12, consumed: 21.6 })).toBeNull();
    expect(lvActualRate({ done: false, producedQty: null, consumed: 14.4 })).toBeNull();
    expect(lvActualRate({ done: false, producedQty: 0, consumed: 14.4 })).toBeNull();
    expect(lvActualRate({ done: false, producedQty: 8, consumed: null })).toBeNull();
  });
});

describe("lvRemainingUnits", () => {
  it("is planned less produced, floored at zero", () => {
    expect(lvRemainingUnits(19, 8)).toBe(11);
    expect(lvRemainingUnits(12, null)).toBe(12);
    expect(lvRemainingUnits(5, 9)).toBe(0);
  });
});
