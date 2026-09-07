import { describe, it, expect } from "vitest";
import {
  normalizeMaterialType, normalizeSheetSize, parseSheetNumber, sheetsForJob, sheetsDifference,
  actualPerUnit, sheetsForProduced, summarizeMaterial, parseNestingTracker, materialKey, round3,
  type MaterialLineView,
} from "./material";
import { monthLabelFromInput, monthInputFromLabel, monthLabelSortKey } from "./dates";

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
    expect(parseSheetNumber(" ")).toBeNull();
    expect(parseSheetNumber("#VALUE!")).toBeNull();
    expect(parseSheetNumber(NaN)).toBeNull();
  });
});

describe("the sheet's formula columns", () => {
  it("multiplies out the job without Excel's float dust", () => {
    expect(sheetsForJob(0.564, 3)).toBe(1.692); // Excel stored 1.6919999999999997
    expect(sheetsForJob(1.243, 22)).toBe(27.346);
  });
  it("difference is sheets-for-job minus what was actually nested", () => {
    expect(sheetsDifference(27.346, 17)).toBe(10.346);
    expect(sheetsDifference(1.287, 2)).toBe(-0.713); // over-consumption is negative, not an error
    expect(sheetsDifference(27.346, null)).toBeNull();
    expect(sheetsDifference(3, 0)).toBe(3); // a nested ZERO is nested
  });
  it("round3 keeps three decimals", () => {
    expect(round3(1.6919999999999997)).toBe(1.692);
  });
});

describe("what the produced units really consumed", () => {
  it("answers the planner's question: 50 sheets made 30 units, I made 5", () => {
    expect(actualPerUnit(50, 30)).toBeCloseTo(1.6667, 4);
    expect(sheetsForProduced(50, 30, 5)).toBe(8.333);
  });
  it("uses the job's ACTUAL rate, not the BOM's", () => {
    // BOM says 1.243/unit; the nester actually used 17 for 22 units
    expect(sheetsForProduced(17, 22, 22)).toBe(17);
    expect(sheetsForProduced(17, 22, 11)).toBe(8.5);
  });
  it("stays blank until the job is nested, or when nothing was produced yet", () => {
    expect(sheetsForProduced(null, 30, 5)).toBeNull();
    expect(sheetsForProduced(50, 30, null)).toBeNull();
    expect(actualPerUnit(50, 0)).toBeNull(); // no units on the sheet — no rate
  });
});

describe("materialKey", () => {
  it("separates the same line filed under two months", () => {
    const base = { bom: "12008E18M18", mo: "", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440" };
    expect(materialKey({ ...base, month: "July 2026" })).not.toBe(materialKey({ ...base, month: "August 2026" }));
  });
});

function line(over: Partial<MaterialLineView>): MaterialLineView {
  return {
    id: 1, month: "July 2026", bom: "B1", mo: "", units: 10, material: "Steel", thicknessMm: 5, sheetSize: "1220*2440",
    sheetsPerUnit: 1, sheetsUsed: 10, producedQty: null, note: null, soi: null,
    forJob: 10, difference: 0, actualPerUnit: 1, forProduced: null, updatedISO: "2026-09-07", recordedBy: null, ...over,
  };
}

describe("summarizeMaterial", () => {
  it("adds up the job, the nesting and the produced consumption per material and size", () => {
    const totals = summarizeMaterial([
      line({ id: 1, forJob: 10, sheetsUsed: 8, forProduced: 4 }),
      line({ id: 2, bom: "B2", forJob: 5.5, sheetsUsed: 5, forProduced: 2.5 }),
      line({ id: 3, material: "Stainless steel", forJob: 2, sheetsUsed: 2, forProduced: null }),
    ]);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ material: "Stainless steel", forJob: 2, used: 2, forProduced: 0, linesNotNested: 0 });
    expect(totals[1]).toMatchObject({ material: "Steel", forJob: 15.5, used: 13, forProduced: 6.5, linesNotNested: 0 });
  });
  it("counts lines not nested yet instead of treating them as zero", () => {
    const [t] = summarizeMaterial([line({ id: 1, forJob: 10, sheetsUsed: null }), line({ id: 2, forJob: 4, sheetsUsed: 4 })]);
    expect(t.forJob).toBe(14);
    expect(t.used).toBe(4);
    expect(t.linesNotNested).toBe(1);
  });
});

describe("month labels", () => {
  it("round-trips the monthly plan's label format", () => {
    expect(monthLabelFromInput("2026-07")).toBe("July 2026");
    expect(monthInputFromLabel("July 2026")).toBe("2026-07");
    expect(monthLabelFromInput("2026-13")).toBeNull();
    expect(monthInputFromLabel("Q3 2026")).toBeNull();
  });
  it("sorts labels as dates and files non-months last", () => {
    expect(monthLabelSortKey("August 2026")).toBeGreaterThan(monthLabelSortKey("July 2026"));
    expect(monthLabelSortKey("January 2027")).toBeGreaterThan(monthLabelSortKey("December 2026"));
    expect(monthLabelSortKey("")).toBe(-1);
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
    expect(rows[0]).toMatchObject({ bom: "10017E11M11", units: 22, material: "Steel", thicknessMm: 5, sheetSize: "1220*2440", sheetsPerUnit: 1.243, sheetsUsed: 17, note: null });
    expect(rows[1]).toMatchObject({ material: "Stainless steel", note: "check" });
  });
  it("skips the blank template rows the tracker is padded with", () => {
    const grid: unknown[][] = [HEADER, [null, null, null, null, null, null, "=IF(...)", null, "=IF(...)", null]];
    const { rows, issues } = parseNestingTracker(grid);
    expect(rows).toEqual([]);
    expect(issues).toContain("No material rows found under the header.");
  });
  it("leaves the actual nesting empty when the sheet has none", () => {
    const { rows } = parseNestingTracker([HEADER, ["81004E12M11", 3, "Steel", 3, "1220*2440", 0.429, 1.287, null, null, null]]);
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
    expect(issues[0]).toMatch(/Row 2 \(40013E11M11\): sheets per unit/);
  });
  it("finds the columns wherever the planner moved them", () => {
    const grid: unknown[][] = [
      ["Notes", "Thickness (mm)", "BOM Ref", "Sheet Size", "Material Type", "No. of Sheets in BOM for one Unit", "Quantity of Units"],
      ["re-nest", 8, "12005E14M13", "1500*3000", "Steel", 0.015, 65],
    ];
    const { rows, issues } = parseNestingTracker(grid);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({ bom: "12005E14M13", thicknessMm: 8, sheetSize: "1500*3000", material: "Steel", sheetsPerUnit: 0.015, units: 65, note: "re-nest", sheetsUsed: null });
  });
  it("says so when the file is not a nesting tracker at all", () => {
    const { rows, issues } = parseNestingTracker([["Plan No", "MO", "Qty"], [1, "MO-1", 5]]);
    expect(rows).toEqual([]);
    expect(issues[0]).toMatch(/No header row found/);
  });
});
