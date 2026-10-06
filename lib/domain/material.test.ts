import { describe, it, expect } from "vitest";
import {
  normalizeMaterialType, normalizeSheetSize, parseSheetNumber, sheetsForJob, sheetsDifference,
  actualPerUnit, rateIsTyped, sheetsForProduced, summarizeMaterial, parseNestingTracker, materialKey, round3, partNameFor,
  filterMaterialLines, EMPTY_MATERIAL_FILTERS, groupMaterialBySoi,
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
    // the sheet's own rate is handed straight back, never re-derived
    expect(actualPerUnit(1.6667, 50, 30)).toBe(1.6667);
    expect(sheetsForProduced(1.6667, null, 0, 5)).toBe(8.3335);
    // …and the division only stands in where the line carries no rate
    expect(actualPerUnit(null, 50, 30)).toBeCloseTo(1.6667, 4);
    expect(sheetsForProduced(null, 50, 30, 5)).toBe(8.3333);
  });
  it("uses the job's ACTUAL rate, not the BOM's", () => {
    // BOM says 1.243/unit; the nester actually used 17 for 22 units
    expect(sheetsForProduced(null, 17, 22, 22)).toBe(17);
    expect(sheetsForProduced(null, 17, 22, 11)).toBe(8.5);
  });
  it("stays blank until the job is nested, or when nothing was produced yet", () => {
    expect(sheetsForProduced(null, null, 30, 5)).toBeNull();
    expect(sheetsForProduced(null, 50, 30, null)).toBeNull();
    expect(actualPerUnit(null, 50, 0)).toBeNull(); // nothing to divide by, and no rate of its own
    // …but a line WITH the sheet's rate keeps it even with no units at all
    expect(actualPerUnit(0.568, null, 0)).toBe(0.568);
  });
});

describe("materialKey", () => {
  it("separates the same line filed under two months", () => {
    const base = { bom: "12008E18M18", mo: "", partCode: "FB-022", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440" };
    expect(materialKey({ ...base, month: "July 2026" })).not.toBe(materialKey({ ...base, month: "August 2026" }));
  });
  it("separates the same BOM's tank and top-cover lines", () => {
    const base = { month: "September 2026", bom: "40012E11M11", mo: "", material: "Stainless steel", thicknessMm: 5, sheetSize: "1220*2440" };
    expect(materialKey({ ...base, partCode: "FB-022" })).not.toBe(materialKey({ ...base, partCode: "FB-051" }));
  });
  it("knows the parts' names by code", () => {
    expect(partNameFor("fb-022")).toBe("TANK");
    expect(partNameFor("FB-051")).toBe("TOP COVER");
    expect(partNameFor("XX-1")).toBe("");
  });
});

function line(over: Partial<MaterialLineView>): MaterialLineView {
  return {
    id: 1, month: "July 2026", bom: "B1", mo: "", units: 10, partCode: "FB-022", partName: "TANK", materialCode: "T-SSS-5MM",
    material: "Steel", thicknessMm: 5, sheetSize: "1220*2440",
    sheetsPerUnit: 1, sheetsUsed: 10, producedQty: null, note: null, soi: "", mtr: "", weightKg: null, utilization: null, actualWeightKg: null, producedAuto: null, producedUsed: null, remainingUnits: null,
    forJob: 10, difference: 0, actualPerUnit: 1, actualPerUnitManual: false, forProduced: null,
    updatedISO: "2026-09-07", recordedBy: null, ...over,
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

describe("filterMaterialLines", () => {
  const rows = [
    line({ id: 1, bom: "10017E11M11", soi: "S01035-1", partCode: "FB-022", partName: "TANK", sheetsUsed: 6.4, difference: 2.4, producedQty: 1 }),
    line({ id: 2, bom: "40012E11M11", partCode: "FB-051", partName: "TOP COVER", sheetsUsed: null, difference: null, producedQty: null }),
    line({ id: 3, bom: "40012E11M11", partCode: "FB-022", partName: "TANK", material: "Steel", thicknessMm: 4, sheetsUsed: 9, difference: -1, note: "re-nest" }),
  ];
  const ids = (f: Partial<typeof EMPTY_MATERIAL_FILTERS>) => filterMaterialLines(rows, { ...EMPTY_MATERIAL_FILTERS, ...f }).map((l) => l.id);
  it("passes everything through with empty filters", () => {
    expect(ids({})).toEqual([1, 2, 3]);
  });
  it("narrows by part, material, thickness and size", () => {
    expect(ids({ partCode: "FB-051" })).toEqual([2]);
    expect(ids({ partCode: "FB-022", thicknessMm: "4" })).toEqual([3]);
    expect(ids({ sheetSize: "1500*3000" })).toEqual([]);
  });
  it("narrows by where the line stands", () => {
    expect(ids({ status: "nested" })).toEqual([1, 3]);
    expect(ids({ status: "notNested" })).toEqual([2]);
    expect(ids({ status: "produced" })).toEqual([1]);
    expect(ids({ status: "over" })).toEqual([3]);
    expect(ids({ status: "within" })).toEqual([1]);
  });
  it("searches BOM, SOI, part, code and note, any case, any part", () => {
    expect(ids({ q: "40012" })).toEqual([2, 3]);
    expect(ids({ q: "s01035" })).toEqual([1]);
    expect(ids({ q: "top cover" })).toEqual([2]);
    expect(ids({ q: "re-nest" })).toEqual([3]);
    expect(ids({ q: "nothing" })).toEqual([]);
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
const PROJECT_HEADER = [
  "BOM Ref", "Quantity of Units", "Part Code", "Part Name", "Codes", "Material", "Thickness (mm)", "Sheet Size",
  "No. of Sheets in BOM for one Unit", "No. of Sheets in BOM for Job", "No. of Sheets in Actual Nesting for one Unit",
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
    expect(rows[0]).toMatchObject({ bom: "10017E11M11", units: 22, material: "Steel", thicknessMm: 5, sheetSize: "1220*2440", sheetsPerUnit: 1.243, sheetsUsed: 17, note: null, partCode: "", partName: "", materialCode: "" });
    expect(rows[1]).toMatchObject({ material: "Stainless steel", note: "check" });
  });
  it("reads the project tracker's part columns and takes the job from its actual-per-unit column", () => {
    const grid: unknown[][] = [
      ["NESTING PROJECT TRACKER"],
      PROJECT_HEADER,
      ["10017E11M11", 29, "fb-022", "Tank", "t-sss-5mm", "Stainless steal", 5, "1220*2440", 0.3048, 8.8392, 0.2207, 6.4, 2.4392, null],
      ["40012E11M11", 7, "FB-051", "TOP COVER", "T-SSS-5MM", "Stainless steal", 5, "1220*2440", 0.022, 0.154, null, null, null, null],
      ["40012E11M11", 7, "FB-022", null, "T-SSS-5MM", "Stainless steal", 5, "1220*2440", 0.0014, 0.0098, null, null, null, "re-nest"],
    ];
    const { rows, issues } = parseNestingTracker(grid);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(3);
    // 29 units × 0.2207 nested a unit = 6.4 for the job, which is what the sheet says too
    expect(rows[0]).toMatchObject({ bom: "10017E11M11", units: 29, partCode: "FB-022", partName: "TANK", materialCode: "T-SSS-5MM", material: "Stainless steel", sheetsPerUnit: 0.3048, actualPerUnit: 0.2207, sheetsUsed: 6.4 });
    expect(rows[1]).toMatchObject({ partCode: "FB-051", partName: "TOP COVER", sheetsUsed: null });
    // a blank part name is filled from the code
    expect(rows[2]).toMatchObject({ partCode: "FB-022", partName: "TANK", note: "re-nest" });
  });
  it("keeps the sheet's own job figure and only counts a disagreement with its rate", () => {
    // the planner's tracker carries rows like this: the job grew to 90 units
    // and the "for Job" column kept the answer for the 31 it was. It is his
    // figure — kept as written, counted so he can look
    const grid: unknown[][] = [
      PROJECT_HEADER,
      ["40013E11M11", 90, "FB-022", "TANK", "C-SHR-004", "HR Sheet", 4, "1220*2440", 0.568, 51.12, 0.568, 17.6, null, null],
    ];
    const { rows, recomputed } = parseNestingTracker(grid);
    expect(rows[0].sheetsUsed).toBe(17.6);
    expect(rows[0].actualPerUnit).toBe(0.568);
    expect(recomputed).toBe(1);
  });
  it("keeps four decimals and does not call a rounding difference a disagreement", () => {
    const grid: unknown[][] = [
      PROJECT_HEADER,
      // 29 × 0.0128 is 0.3712; the sheet rounded its rate and wrote 0.3701
      ["10017E11M11", 29, "FB-024", "CABLE BOX", "C-SHR-005", "HR Sheet", 5, "1220*2440", 0.02, 0.58, 0.0128, 0.3701, null, null],
      // the job column blank: the rate × units stands in, to four decimals
      ["10017E11M11", 29, "FB-024", "CABLE BOX", "C-SHR-003", "HR Sheet", 3, "1220*2440", 1.35, 39.15, 1.4008, null, null, null],
    ];
    const { rows, recomputed } = parseNestingTracker(grid);
    expect(rows[0].sheetsUsed).toBe(0.3701);
    expect(rows[1].sheetsUsed).toBe(40.6232);
    expect(recomputed).toBe(0);
  });
  it("reports a row that repeats another's identity — the later one replaces it", () => {
    const grid: unknown[][] = [
      PROJECT_HEADER,
      ["14003E14M15", 3, "FB-022", "TANK", "T-SSS-5MM", "Stainless Steel", 5, "1220*2440", 0.0547, 0.1641, null, null, null, null],
      ["14003E14M15", 3, "FB-022", "TANK", "T-SSS-5MM", "Stainless Steel", 5, "1220*2440", 0.054, 0.162, null, null, null, null],
    ];
    const { rows, issues } = parseNestingTracker(grid);
    expect(rows).toHaveLength(2);
    expect(issues).toEqual([expect.stringMatching(/^Row 3 .* repeats row 2/)]);
  });
  it("falls back to the job column on a sheet that has no per-unit rate", () => {
    const { rows, recomputed } = parseNestingTracker([HEADER, ["10017E11M11", 22, "Steel", 5, "1220*2440", 1.243, 27.346, 17, 10.346, null]]);
    expect(rows[0]).toMatchObject({ actualPerUnit: null, sheetsUsed: 17 });
    expect(recomputed).toBe(0);
  });
  it("keeps a nested-nothing row at zero, not empty", () => {
    const grid: unknown[][] = [
      PROJECT_HEADER,
      ["81004E12M11", 3, "FB-022", "TANK", "C-SHR-004", "HR Sheet", 4, "1220*2440", 0.564, 1.692, 0, 0, null, null],
    ];
    const { rows } = parseNestingTracker(grid);
    expect(rows[0].sheetsUsed).toBe(0);
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

describe("rateIsTyped — whose figure the per-unit rate is", () => {
  const sheet = { actualPerUnit: 0.25, actualPerUnitManual: false };
  const typed = { actualPerUnit: 0.4, actualPerUnitManual: true };

  it("claims the rate when a figure is typed over a line the sheet filled", () => {
    expect(rateIsTyped(sheet, 0.4)).toBe(true);
  });

  it("leaves an imported line alone when the box is saved untouched", () => {
    expect(rateIsTyped(sheet, 0.25)).toBe(false);
  });

  it("claims the rate on a line the sheet left blank", () => {
    expect(rateIsTyped({ actualPerUnit: null, actualPerUnitManual: false }, 0.33)).toBe(true);
  });

  it("keeps a typed rate typed when the line is saved again unchanged", () => {
    expect(rateIsTyped(typed, 0.4)).toBe(true);
  });

  it("hands the line back to the sheet when the box is cleared", () => {
    expect(rateIsTyped(typed, null)).toBe(false);
    expect(rateIsTyped(sheet, null)).toBe(false);
  });

  it("treats a typed zero as a figure, not as an empty box", () => {
    expect(rateIsTyped(sheet, 0)).toBe(true);
  });
});

describe("parseNestingTracker — the sheet with Odoo's MO per part", () => {
  const grid: unknown[][] = [
    ["SOI", "MO", "BOM Ref", "Quantity of Units", "Part Code", "Part Name", "Material Code", "Material", "Thickness (mm)", "Sheet Size", "Weight(Kg)", "BOM Qty for one Unit", "No. of Pieces in Actual Nesting for one Unit", "BOM Pieces for Job", "No. of Pieces in Actual Nesting for Job", "Average Utilization", "Actual Weight (Kg)", "Difference", "Notes"],
    ["S01194-12", "SF01/MO/20941", "00007S15", 11, "FB-024", "CABLE BOX", "C-SHR-003", "HR Sheet", 3, "1220x2440", 70.1, 0.79, null, 8.69, null, null, null, null, null],
    ["S01194-12", "SF01/MO/20943", "00007S15", 4, "FB-024", "CABLE BOX", "C-SHR-003", "HR Sheet", 3, "1220x2440", 70.1, 0.79, 0.75, 3.16, 3, null, null, null, "ok"],
  ];

  it("reads the MO, keeps one line per MO, and takes the per-unit and job columns", () => {
    const { rows, issues } = parseNestingTracker(grid);
    expect(issues).toEqual([]);
    expect(rows.map((r) => [r.mo, r.bom, r.units])).toEqual([["SF01/MO/20941", "00007S15", 11], ["SF01/MO/20943", "00007S15", 4]]);
    expect(rows[0]).toMatchObject({ partCode: "FB-024", materialCode: "C-SHR-003", material: "HR Sheet", thicknessMm: 3, sheetSize: "1220*2440", sheetsPerUnit: 0.79, actualPerUnit: null, sheetsUsed: null });
    expect(rows[1]).toMatchObject({ actualPerUnit: 0.75, sheetsUsed: 3, note: "ok" });
  });

  it("leaves the MO empty on the older sheet with no MO column", () => {
    const old = grid.map((r) => [...r.slice(0, 1), ...r.slice(2)]);
    expect(parseNestingTracker(old).rows.every((r) => r.mo === "")).toBe(true);
  });
});

describe("parseNestingTracker — the sheet with SOI, weight and utilization", () => {
  const head = ["SOI", "MO", "BOM Ref", "Quantity of Units", "Part Code", "Part Name", "Material Code", "Material", "Thickness (mm)", "Sheet Size", "Weight(Kg)",
    "BOM Qty for one Unit", "No. of Pieces in Actual Nesting for one Unit", "BOM Pieces for Job", "No. of Pieces in Actual Nesting for Job", "Average Utilization", "Actual Weight (Kg)", "Difference", "Notes"];
  const grid = [head, ["S01194-12", "SF01/MO/20941", "00007S15", 11, "FB-024", "CABLE BOX", "C-SHR-003", "HR Sheet", 3, "1220x2440", 70.1, 0.79, 0.7, 8.69, 7.7, 0.86, null, null, "ok"]];
  it("reads every column into its place", () => {
    const { rows, issues } = parseNestingTracker(grid);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      soi: "S01194-12", mo: "SF01/MO/20941", bom: "00007S15", units: 11, partCode: "FB-024", materialCode: "C-SHR-003", material: "HR Sheet",
      thicknessMm: 3, weightKg: 70.1, sheetsPerUnit: 0.79, actualPerUnit: 0.7, sheetsUsed: 7.7, utilization: 0.86, note: "ok",
    });
  });
});

describe("parseNestingTracker — the sheet that opens with MTR Request #", () => {
  const head = ["MTR Request #", "SOI", "MO", "BOM Ref", "Quantity of Units", "Part Code", "Part Name", "Material Code", "Material", "Thickness (mm)", "Sheet Size", "Weight(Kg)",
    "BOM Qty for one Unit", "No. of Pieces in Actual Nesting for one Unit", "BOM Pieces for Job", "No. of Pieces in Actual Nesting for Job", "Average Utilization", "Actual Weight (Kg)", "Difference (Pc)", "Notes"];
  it("reads the MTR and still finds every other column", () => {
    const grid = [head, ["mtr/0412", "S01194-12", "SF01/MO/20941", "00007S15", 11, "FB-024", "CABLE BOX", "C-SHR-003", "HR Sheet", 3, "1220x2440", 70.1, 0.79, 0.7, 8.69, 7.7, 0.86, null, null, "ok"]];
    const { rows, issues } = parseNestingTracker(grid);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      mtr: "MTR/0412", soi: "S01194-12", mo: "SF01/MO/20941", bom: "00007S15", units: 11, partCode: "FB-024", materialCode: "C-SHR-003", material: "HR Sheet",
      thicknessMm: 3, weightKg: 70.1, sheetsPerUnit: 0.79, actualPerUnit: 0.7, sheetsUsed: 7.7, utilization: 0.86, note: "ok",
    });
  });
  it("leaves the MTR empty when the cell is blank, or the sheet has no such column", () => {
    const blank = [head, [null, "S01194-12", "SF01/MO/20941", "00007S15", 11, "FB-024", "CABLE BOX", "C-SHR-003", "HR Sheet", 3, "1220x2440", 70.1, 0.79, null, 8.69, null, null, null, null, null]];
    expect(parseNestingTracker(blank).rows[0].mtr).toBe("");
    expect(parseNestingTracker(blank.map((r) => r.slice(1))).rows[0].mtr).toBe("");
  });
});

describe("groupMaterialBySoi", () => {
  it("groups by SOI in first-seen order, MOs together inside, every line exactly once", () => {
    const ls = [
      line({ id: 1, soi: "S1", mo: "MO-A", forJob: 2, sheetsUsed: 2, difference: 0 }),
      line({ id: 2, soi: "S2", mo: "MO-C", forJob: 1, sheetsUsed: null, difference: null }),
      line({ id: 3, soi: "S1", mo: "MO-B", forJob: 3, sheetsUsed: 4, difference: -1 }),
      line({ id: 4, soi: "S1", mo: "MO-A", forJob: 1.5, sheetsUsed: 1, difference: 0.5 }),
      line({ id: 5, soi: "", mo: "", forJob: 1 }),
    ];
    const g = groupMaterialBySoi(ls);
    expect(g.map((x) => x.soi)).toEqual(["S1", "S2", ""]);
    expect(g[0].lines.map((l) => l.id)).toEqual([1, 4, 3]);
    expect(g[0].mos).toEqual(["MO-A", "MO-B"]);
    expect(g[0]).toMatchObject({ forJob: 6.5, sheetsUsed: 7, difference: -0.5 });
    expect(g[1]).toMatchObject({ sheetsUsed: null, difference: null });
    expect(g[2].mos).toEqual([]);
    expect(g.flatMap((x) => x.lines).length).toBe(ls.length);
  });
});
