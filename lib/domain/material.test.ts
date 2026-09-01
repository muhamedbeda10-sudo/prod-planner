import { describe, it, expect } from "vitest";
import {
  normalizeMaterialType,
  normalizeSheetSize,
  parseSheetNumber,
  sheetsForJob,
  sheetsDifference,
  resolveUnits,
  summarizeMaterial,
  parseNestingTracker,
  materialKey,
  round3,
  type MaterialLineView,
} from "./material";

describe("normalizeMaterialType", () => {
  it("folds the tracker's spellings of the same material", () => {
    expect(normalizeMaterialType("Steel")).toBe("Steel");
    expect(normalizeMaterialType(" steel ")).toBe("Steel");
    expect(normalizeMaterialType("MS")).toBe("Steel");
    // the real sheet spells it "Stainless steal" throughout
    expect(normalizeMaterialType("Stainless steal")).toBe("Stainless steel");
    expect(normalizeMaterialType("S.S")).toBe("Stainless steel");
    expect(normalizeMaterialType("aluminum")).toBe("Aluminium");
  });

  it("keeps an unknown material as typed, tidied", () => {
    expect(normalizeMaterialType("  brass   sheet ")).toBe("Brass sheet");
    expect(normalizeMaterialType("")).toBe("");
    expect(normalizeMaterialType(null)).toBe("");
  });
});

describe("normalizeSheetSize", () => {
  it("brings every spelling to width*length", () => {
    expect(normalizeSheetSize("1220*2440")).toBe("1220*2440");
    expect(normalizeSheetSize("1220x2440")).toBe("1220*2440");
    expect(normalizeSheetSize("1220 × 2440")).toBe("1220*2440");
    expect(normalizeSheetSize(" 1500*3000 mm ")).toBe("1500*3000");
  });

  it("keeps text it cannot read rather than dropping it", () => {
    expect(normalizeSheetSize("coil")).toBe("coil");
    expect(normalizeSheetSize("")).toBe("");
  });
});

describe("parseSheetNumber", () => {
  it("reads numbers and refuses everything else", () => {
    expect(parseSheetNumber(0.429)).toBe(0.429);
    expect(parseSheetNumber("1.287")).toBe(1.287);
    expect(parseSheetNumber("1,220")).toBe(1220);
    expect(parseSheetNumber("")).toBeNull();
    expect(parseSheetNumber("  ")).toBeNull();
    // the workbook leaves #VALUE! and stray spaces in the numeric columns
    expect(parseSheetNumber("#VALUE!")).toBeNull();
    expect(parseSheetNumber(" ")).toBeNull();
    expect(parseSheetNumber(null)).toBeNull();
    expect(parseSheetNumber(NaN)).toBeNull();
  });
});

describe("the two computed columns", () => {
  it("multiplies out the job without Excel's float dust", () => {
    // the sheet stored 0.564 * 3 as 1.6919999999999997
    expect(sheetsForJob(0.564, 3)).toBe(1.692);
    expect(sheetsForJob(1.243, 22)).toBe(27.346);
    expect(sheetsForJob(0, 90)).toBe(0);
  });

  it("difference is BOM-for-job minus what was actually nested", () => {
    expect(sheetsDifference(27.346, 17)).toBe(10.346);
    expect(sheetsDifference(2.97, 0.5)).toBe(2.47);
    // over-consumption is a negative difference, not an error
    expect(sheetsDifference(5, 8)).toBe(-3);
  });

  it("stays blank while the job has not been nested", () => {
    expect(sheetsDifference(27.346, null)).toBeNull();
  });

  it("counts a nested ZERO as nested", () => {
    expect(sheetsDifference(3, 0)).toBe(3);
  });

  it("round3 keeps three decimals", () => {
    expect(round3(1.6919999999999997)).toBe(1.692);
    expect(round3(0.0244 * 90)).toBe(2.196);
  });
});

describe("resolveUnits", () => {
  it("takes the quantity from the registry by default", () => {
    expect(resolveUnits(null, 22)).toEqual({ units: 22, fromRegistry: true });
  });

  it("lets a typed override win for a BOM the registry does not carry", () => {
    expect(resolveUnits(65, 0)).toEqual({ units: 65, fromRegistry: false });
  });

  it("ignores a zero override — it would silently zero the whole job", () => {
    expect(resolveUnits(0, 12)).toEqual({ units: 12, fromRegistry: true });
  });
});

describe("materialKey", () => {
  it("separates the same sheet on two different orders of one BOM", () => {
    const base = { bom: "12008E18M18", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440" };
    expect(materialKey({ ...base, mo: "" })).not.toBe(materialKey({ ...base, mo: "MO-1" }));
  });
});

function line(over: Partial<MaterialLineView>): MaterialLineView {
  return {
    id: 1, bom: "B1", mo: "", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440",
    sheetsPerUnit: 1, sheetsUsed: null, unitsOverride: null, note: null,
    units: 10, unitsFromRegistry: true, required: 10, difference: null,
    updatedISO: "2026-09-01", recordedBy: null, ...over,
  };
}

describe("summarizeMaterial", () => {
  it("adds up required and nested per material, thickness and size", () => {
    const totals = summarizeMaterial([
      line({ id: 1, required: 10, sheetsUsed: 8 }),
      line({ id: 2, bom: "B2", required: 5.5, sheetsUsed: 5 }),
      line({ id: 3, material: "Stainless steel", required: 2, sheetsUsed: 2 }),
    ]);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ material: "Stainless steel", required: 2, used: 2, pendingLines: 0 });
    expect(totals[1]).toMatchObject({ material: "Steel", required: 15.5, used: 13, pendingLines: 0 });
  });

  it("counts lines that were never nested instead of treating them as zero", () => {
    const [t] = summarizeMaterial([line({ id: 1, required: 10, sheetsUsed: null }), line({ id: 2, required: 4, sheetsUsed: 4 })]);
    expect(t.required).toBe(14);
    expect(t.used).toBe(4);
    expect(t.pendingLines).toBe(1);
  });
});

// The real workbook's layout, header row and all.
const HEADER = [
  "BOM Ref", "Quantity of Units", "Material Type", "Thickness (mm)", "Sheet Size",
  "No. of Sheets in BOM for one Unit", "No. of Sheets in BOM for Job",
  "No. of Sheets in Actual Nesting for Job", "Difference", "Notes",
];

describe("parseNestingTracker", () => {
  it("reads the tracker's rows and ignores its formula columns", () => {
    const grid: unknown[][] = [
      ["NESTING PROJECT TRACKER"],
      HEADER,
      ["10017E11M11", 22, "Steel", 5, "1220*2440", 1.243, 27.346, 17, 10.346, null],
      ["10017E11M11", 22, "Stainless steal", 5, "1220*2440", 0.3034, 6.6748, 5, 1.6748, "check"],
    ];
    const { rows, issues, headerRow } = parseNestingTracker(grid);
    expect(headerRow).toBe(2);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      bom: "10017E11M11", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440",
      sheetsPerUnit: 1.243, sheetsUsed: 17, units: 22, note: null,
    });
    // the misspelling is folded, and the note comes across
    expect(rows[1]).toMatchObject({ material: "Stainless steel", note: "check" });
  });

  it("skips the blank template rows the tracker is padded with", () => {
    const grid: unknown[][] = [HEADER, [null, null, null, null, null, null, "=IF(...)", null, "=IF(...)", null]];
    const { rows, issues } = parseNestingTracker(grid);
    expect(rows).toEqual([]);
    expect(issues).toContain("No material rows found under the header.");
  });

  it("leaves the actual nesting empty when the sheet has none", () => {
    const grid: unknown[][] = [HEADER, ["81004E12M11", 3, "Steel", 3, "1220*2440", 0.429, 1.287, null, null, null]];
    const { rows } = parseNestingTracker(grid);
    expect(rows[0].sheetsUsed).toBeNull();
  });

  it("reports the row it could not read instead of importing a broken line", () => {
    const grid: unknown[][] = [
      HEADER,
      ["40013E11M11", 90, "Steel", 5, "1220*2440", " ", " ", 90, "#VALUE!", null],
      ["40013E11M11", 90, "Steel", 4, "1220*2440", 0.568, 51.12, 51, 0.12, null],
    ];
    const { rows, issues } = parseNestingTracker(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].thicknessMm).toBe(4);
    expect(issues[0]).toMatch(/Row 2 \(40013E11M11\): sheets per unit/);
  });

  it("finds the columns wherever the planner moved them", () => {
    const grid: unknown[][] = [
      ["Notes", "Thickness (mm)", "BOM Ref", "Sheet Size", "Material Type", "No. of Sheets in BOM for one Unit"],
      ["re-nest", 8, "12005E14M13", "1500*3000", "Steel", 0.015],
    ];
    const { rows, issues } = parseNestingTracker(grid);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      bom: "12005E14M13", thicknessMm: 8, sheetSize: "1500*3000", material: "Steel",
      sheetsPerUnit: 0.015, note: "re-nest", units: null, sheetsUsed: null,
    });
  });

  it("says so when the file is not a nesting tracker at all", () => {
    const { rows, issues } = parseNestingTracker([["Plan No", "MO", "Qty"], [1, "MO-1", 5]]);
    expect(rows).toEqual([]);
    expect(issues[0]).toMatch(/No header row found/);
  });
});
