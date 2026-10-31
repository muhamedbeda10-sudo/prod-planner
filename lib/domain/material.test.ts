import { describe, it, expect } from "vitest";
import {
  normalizeMaterialType, normalizeSheetSize, parseSheetNumber, sheetNumberOr, sheetsForJob, sheetsDifference,
  actualPerUnit, sheetsForProduced, parseNestingTracker, materialKey, round3, partNameFor,
  filterMaterialLines, EMPTY_MATERIAL_FILTERS, groupMaterialBySoi,
  materialPlanIndex, materialPlanMonths, materialClosings, lineClosings, withBackorders, itemOfPartCode, adoptedPartLine, materialPlanMonthOptions, materialSummary, sheetsConsumed, resolvePlanMonth, traceMaterialMatch, NO_PLAN_MONTH,
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

describe("sheetNumberOr", () => {
  it("is parseSheetNumber where that reads a number", () => {
    expect(sheetNumberOr(0.429)).toBe(0.429);
    expect(sheetNumberOr("1,220")).toBe(1220);
    expect(sheetNumberOr(" 7 ")).toBe(7);
    expect(sheetNumberOr(0, 5)).toBe(0); // a real zero is not the fallback
  });
  it("reads a figure with a note beside it as the number it starts with", () => {
    expect(sheetNumberOr("60 (urgent)")).toBe(60);
    expect(sheetNumberOr("1,200 pcs")).toBe(1200);
    expect(sheetNumberOr("5 (rework)", NaN)).toBe(5);
  });
  it("is the fallback for blanks, text and Excel errors — 0 unless told otherwise", () => {
    for (const v of [null, undefined, "", " ", "-", "#VALUE!", "abc", NaN, Infinity, "Infinity"]) {
      expect(sheetNumberOr(v)).toBe(0);
      expect(sheetNumberOr(v, NaN)).toBeNaN();
      expect(sheetNumberOr(v, -1)).toBe(-1);
    }
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
    forJob: 10, difference: 0, actualPerUnit: 1, forProduced: null,
    updatedISO: "2026-09-07", recordedBy: null, planMonths: [], planMatch: null, orderMos: [], partMos: [], ...over,
  };
}

describe("filterMaterialLines", () => {
  const rows = [
    line({ id: 1, bom: "10017E11M11", soi: "S01035-1", partCode: "FB-022", partName: "TANK", sheetsUsed: 6.4, difference: 2.4, producedQty: null, producedAuto: 1, producedUsed: 1 }),
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
  it("narrows by plan month, and to the lines no plan carries", () => {
    const planned = [
      line({ id: 1, planMonths: ["October 2026", "September 2026"] }),
      line({ id: 2, planMonths: ["September 2026"] }),
      line({ id: 3, planMonths: [] }),
    ];
    const pick = (planMonth: string) => filterMaterialLines(planned, { ...EMPTY_MATERIAL_FILTERS, planMonth }).map((l) => l.id);
    expect(pick("")).toEqual([1, 2, 3]);
    expect(pick("September 2026")).toEqual([1, 2]);
    expect(pick("October 2026")).toEqual([1]);
    expect(pick(NO_PLAN_MONTH)).toEqual([3]);
    expect(pick("August 2026")).toEqual([]);
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
    const { rows, issues, headerRow, skipped } = parseNestingTracker(grid);
    expect(headerRow).toBe(2);
    expect(issues).toEqual([]);
    expect(skipped).toBe(0);
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
    const { rows, issues, skipped } = parseNestingTracker(grid);
    expect(rows).toHaveLength(2);
    expect(issues).toEqual([expect.stringMatching(/^Row 3 .* repeats row 2/)]);
    expect(skipped).toBe(0); // a repeat is read, not skipped
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
    const { rows, issues, skipped } = parseNestingTracker(grid);
    expect(rows).toEqual([]);
    expect(issues).toContain("No material rows found under the header.");
    expect(skipped).toBe(0); // template rows carry no BOM — not data rows
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
    const { rows, issues, skipped } = parseNestingTracker(grid);
    expect(rows).toHaveLength(1);
    expect(issues[0]).toMatch(/Row 2 \(40013E11M11\): sheets per unit/);
    expect(skipped).toBe(1);
  });
  it("counts every row it had to leave out, whatever the reason", () => {
    const grid: unknown[][] = [
      HEADER,
      ["B1", 1, null, 5, "1220*2440", 0.5, 0.5, null, null, null], // no material
      ["B2", 1, "Steel", "#VALUE!", "1220*2440", 0.5, 0.5, null, null, null], // no thickness
      ["B3", 1, "Steel", 5, null, 0.5, 0.5, null, null, null], // no size
      ["B4", 1, "Steel", 5, "1220*2440", null, null, null, null, null], // no sheets per unit
      ["B5", null, "Steel", 5, "1220*2440", 0.5, null, null, null, null], // no units
      ["B6", 2, "Steel", 5, "1220*2440", 0.5, 1, null, null, null], // read
    ];
    const { rows, issues, skipped } = parseNestingTracker(grid);
    expect(rows.map((r) => r.bom)).toEqual(["B6"]);
    expect(skipped).toBe(5);
    expect(issues).toHaveLength(5);
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
    const { rows, issues, skipped } = parseNestingTracker([["Plan No", "MO", "Qty"], [1, "MO-1", 5]]);
    expect(rows).toEqual([]);
    expect(issues[0]).toMatch(/No header row found/);
    expect(skipped).toBe(0);
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

describe("materialPlanMonths", () => {
  const idx = materialPlanIndex([
    { mo: "SF01/MO/100", soi: "S01035-1", bom: "10017E11M11", months: ["September 2026"] },
    { mo: "SF01/MO/200", soi: "S01035-1", bom: "10017E11M11", months: ["October 2026", " September 2026 "] },
    { mo: "SF01/MO/300", soi: null, bom: "40012E11M11", months: ["August 2026", ""] },
    { mo: "SF01/MO/400", soi: "S09999-1", bom: "50000E11M11", months: [] },
  ]);
  it("finds the order by its MO first, any case and spacing", () => {
    expect(materialPlanMonths({ mo: " sf01/mo/100 ", soi: "S01035-1", bom: "10017E11M11" }, idx)).toEqual({ months: ["September 2026"], match: "mo" });
  });
  it("falls back to the SOI — every order of it, newest month first", () => {
    expect(materialPlanMonths({ mo: "SF01/MO/999", soi: "s01035-1", bom: "X" }, idx)).toEqual({ months: ["October 2026", "September 2026"], match: "soi" });
  });
  it("takes the SOI's order on the line's own BOM before the SOI as a whole", () => {
    const sb = materialPlanIndex([
      { mo: "PF01/MO/1", soi: "S00262-1", bom: "14002E17M18", months: ["October 2026"] },
      { mo: "PF01/MO/2", soi: "S00262-1", bom: "14002E14M14", months: ["November 2026"] },
    ]);
    expect(materialPlanMonths({ mo: "SF01/MO/20432", soi: "S00262-1", bom: "14002e17m18" }, sb)).toEqual({ months: ["October 2026"], match: "soiBom" });
    // a sub-assembly's code no order carries: the SOI's months
    expect(materialPlanMonths({ mo: "SF01/MO/20500", soi: "S00262-1", bom: "00013S11" }, sb)).toEqual({ months: ["November 2026", "October 2026"], match: "soi" });
  });
  it("takes the months of the order the part MO was closed against on the ODOO log before its SOI", () => {
    const linked = materialPlanIndex([
      { mo: "PF01/MO/1", soi: "S1", bom: "B1", months: ["October 2026"] },
      { mo: "PF01/MO/2", soi: "S1", bom: "B1", months: ["November 2026"] },
    ]);
    expect(materialPlanMonths({ mo: "SF01/MO/9", soi: "S1", bom: "B1" }, linked, null, ["pf01/mo/2"])).toEqual({ months: ["November 2026"], match: "odoo" });
    expect(materialPlanMonths({ mo: "SF01/MO/9", soi: "S1", bom: "B1" }, linked, null, ["PF01/MO/404"])).toEqual({ months: ["November 2026", "October 2026"], match: "soiBom" });
  });
  it("leaves the plans that began after its MO was closed Done on the ODOO log", () => {
    const carried = materialPlanIndex([
      { mo: "PF01/MO/1", soi: "S1", bom: "B1", months: ["October 2026"] },
      { mo: "PF01/MO/1-001", soi: "S1", bom: "B1", months: ["November 2026"] },
    ]);
    const l = { mo: "SF01/MO/9", soi: "S1", bom: "B1" };
    expect(materialPlanMonths(l, carried, "2026-10-20").months).toEqual(["October 2026"]);
    // closed on the month's first day: still that month's
    expect(materialPlanMonths(l, carried, "2026-11-01").months).toEqual(["November 2026", "October 2026"]);
    expect(materialPlanMonths(l, carried, null).months).toEqual(["November 2026", "October 2026"]);
    // closed before every month on record: the earliest stands
    expect(materialPlanMonths(l, carried, "2026-08-02").months).toEqual(["October 2026"]);
    // a label that is no month never stands in for the months
    const odd = materialPlanIndex([{ mo: "PF01/MO/3", soi: "S2", bom: "B2", months: ["November 2026", "Backlog"] }]);
    expect(materialPlanMonths({ mo: "SF01/MO/8", soi: "S2", bom: "B2" }, odd, "2026-10-15").months).toEqual(["November 2026", "Backlog"]);
  });
  it("goes by the BOM only for a line with neither MO nor SOI — one covering the whole BOM", () => {
    expect(materialPlanMonths({ mo: "", soi: " ", bom: "40012e11m11" }, idx)).toEqual({ months: ["August 2026"], match: "bom" });
  });
  it("never guesses a mistyped MO or SOI through the BOM: the line is in no plan", () => {
    expect(materialPlanMonths({ mo: "SF01/MO/0", soi: "S-TYPO", bom: "40012E11M11" }, idx)).toEqual({ months: [], match: null });
  });
  it("skips an order with no month to the next key, and leaves a line nothing finds in no plan", () => {
    expect(materialPlanMonths({ mo: "SF01/MO/400", soi: "S09999-1", bom: "50000E11M11" }, idx)).toEqual({ months: [], match: null });
    expect(materialPlanMonths({ mo: "", soi: "", bom: "" }, idx)).toEqual({ months: [], match: null });
  });
  it("lists the lines' months newest first, once each", () => {
    expect(materialPlanMonthOptions([{ planMonths: ["September 2026"] }, { planMonths: ["January 2027", "September 2026"] }, { planMonths: [] }]))
      .toEqual(["January 2027", "September 2026"]);
  });
});

describe("materialSummary", () => {
  it("adds up the lines shown and counts their orders by SOI (as the SOI groups write it), else MO, else BOM", () => {
    const s = materialSummary([
      line({ id: 1, soi: "S1", mo: "MO-A", forJob: 2.5, sheetsUsed: 3, actualWeightKg: 120, difference: -0.5 }),
      line({ id: 2, soi: "s1", mo: "MO-B", forJob: 1, sheetsUsed: null, actualWeightKg: null, difference: null }),
      line({ id: 3, soi: "", mo: "MO-C", forJob: 4, sheetsUsed: 3.5, actualWeightKg: 80.25, difference: 0.5 }),
      line({ id: 4, soi: "", mo: "", bom: "B9", forJob: 0, sheetsUsed: null, actualWeightKg: null, difference: null }),
    ]);
    // "S1" and "s1" are two SOI groups on the table, so two orders here too
    expect(s).toMatchObject({ lines: 4, orders: 4, forJob: 7.5, sheetsUsed: 6.5, actualWeightKg: 200.25, difference: 0, overLines: 1 });
  });
  it("follows the filters: the strip adds up only the lines a filter leaves", () => {
    const ls = [
      line({ id: 1, soi: "S1", planMonths: ["October 2026"], forJob: 2, sheetsUsed: 3, difference: -1 }),
      line({ id: 2, soi: "S2", planMonths: ["September 2026"], forJob: 5, sheetsUsed: 4, difference: 1, thicknessMm: 3 }),
      line({ id: 3, soi: "S3", planMonths: ["October 2026"], forJob: 1, sheetsUsed: 1, difference: 0, thicknessMm: 3 }),
    ];
    const sum = (f: Partial<typeof EMPTY_MATERIAL_FILTERS>) => materialSummary(filterMaterialLines(ls, { ...EMPTY_MATERIAL_FILTERS, ...f }));
    expect(sum({ planMonth: "October 2026" })).toMatchObject({ orders: 2, forJob: 3, sheetsUsed: 4, overLines: 1 });
    expect(sum({ planMonth: "October 2026", thicknessMm: "3" })).toMatchObject({ orders: 1, forJob: 1, sheetsUsed: 1, overLines: 0 });
    expect(sum({ status: "over" })).toMatchObject({ lines: 1, forJob: 2 });
  });
  it("counts a panel line's consumed sheets as its column does — the BOM's rate × produced where the line has no costing", () => {
    expect(materialSummary([
      line({ forProduced: 6.6, producedUsed: 6 }),
      line({ forProduced: null, producedUsed: 3, sheetsPerUnit: 1.25 }),
      line({ forProduced: null, producedUsed: null }),
    ]).forProduced).toBe(10.35);
  });
  it("counts a job's units once, though a panel order has a line per thickness", () => {
    const s = materialSummary([
      line({ id: 1, mo: "SF01/MO/1", bom: "B1", thicknessMm: 1.5, units: 45, remainingUnits: 1 }),
      line({ id: 2, mo: "SF01/MO/1", bom: "B1", thicknessMm: 2, units: 45, remainingUnits: 1 }),
      line({ id: 3, mo: "SF01/MO/1", bom: "B1", thicknessMm: 3, units: 45, remainingUnits: 1 }),
      line({ id: 4, mo: "SF01/MO/2", bom: "B2", units: 12, remainingUnits: 0 }),
      line({ id: 5, mo: "", bom: "B3", units: 19, remainingUnits: null }),
    ]);
    expect(s).toMatchObject({ units: 76, remainingUnits: 1 });
  });
    it("leaves a figure no line carries empty, not zero", () => {
    expect(materialSummary([line({ sheetsUsed: null, actualWeightKg: null, difference: null, forProduced: null, remainingUnits: null })]))
      .toMatchObject({ sheetsUsed: null, actualWeightKg: null, difference: null, forProduced: null, remainingUnits: null, overLines: 0 });
    expect(materialSummary([])).toMatchObject({ lines: 0, orders: 0, forJob: 0, sheetsUsed: null });
  });
});

describe("sheetsConsumed", () => {
  it("is the line's own costing, else the BOM's rate × produced, else nothing", () => {
    expect(sheetsConsumed({ forProduced: 2.5, producedUsed: 4, sheetsPerUnit: 1 })).toBe(2.5);
    expect(sheetsConsumed({ forProduced: null, producedUsed: 4, sheetsPerUnit: 0.33333 })).toBe(1.3333);
    expect(sheetsConsumed({ forProduced: null, producedUsed: null, sheetsPerUnit: 1 })).toBeNull();
  });
});

describe("resolvePlanMonth", () => {
  const months = ["October 2026", "September 2026"];
  it("finds the lines' own label whatever case it was asked in", () => {
    expect(resolvePlanMonth(" october 2026 ", months)).toBe("October 2026");
  });
  it("reads none (or the mark) as the lines no plan carries, and nothing as any month", () => {
    expect(resolvePlanMonth("None", months)).toBe(NO_PLAN_MONTH);
    expect(resolvePlanMonth(NO_PLAN_MONTH, months)).toBe(NO_PLAN_MONTH);
    expect(resolvePlanMonth("  ", months)).toBe("");
  });
  it("refuses a month no line carries", () => {
    expect(resolvePlanMonth("March 2020", months)).toBeNull();
  });
});

describe("traceMaterialMatch", () => {
  // S01193-3 has orders on E18 and E20; the sheet also files E16 (an older
  // revision) and 00001D11 (a sub-assembly) under it
  const soiOrders = [
    { mo: "PF01/MO/35256-004", soi: "S01193-3", bom: "12008E18M18" },
    { mo: "PF01/MO/35256-005", soi: "S01193-3", bom: "12008E18M18" },
    { mo: "PF01/MO/35300", soi: "S01193-3", bom: "12008E20M18" },
  ];
  const lines = [
    { id: 1, mo: "SF01/MO/1", soi: "S01193-3", bom: "12008E18M18", orderMos: [] as string[] },
    { id: 2, mo: "SF01/MO/2", soi: "s01193-3", bom: "12008E16M18", orderMos: [] as string[] },
    { id: 3, mo: "SF01/MO/3", soi: "S01193-3", bom: "00001D11", orderMos: [] as string[] },
    { id: 4, mo: "SF01/MO/4", soi: "S01193-3", bom: "12008E20M18", orderMos: [] as string[] },
    { id: 5, mo: "SF01/MO/5", soi: "S09999-1", bom: "12008E18M18", orderMos: [] as string[] },
    { id: 6, mo: "", soi: "", bom: "12008e18m18", orderMos: [] as string[] },
    { id: 7, mo: "PF01/MO/35256-004", soi: "", bom: "X", orderMos: [] as string[] },
    { id: 8, mo: "PF01/MO/35256-005", soi: "S01193-3", bom: "12008E18M18", orderMos: [] as string[] },
  ];
  const ids = (scope: "mo" | "bom") =>
    lines.filter(traceMaterialMatch({ scope, mos: ["PF01/MO/35256-004"], sois: ["S01193-3"], bom: "12008E18M18", soiOrders })).map((l) => l.id);
  it("a code's trace: every line on the code, the SOI's lines on codes no order carries, and the order's own MO", () => {
    expect(ids("bom")).toEqual([1, 2, 3, 5, 6, 7, 8]);
  });
  it("an order's trace leaves out another SOI's lines on the same code", () => {
    expect(ids("mo")).toEqual([1, 2, 3, 6, 7]);
  });
  it("an order's trace leaves out a line filed on the SOI's other order's MO", () => {
    expect(ids("mo")).not.toContain(8);
  });
  it("an exact link on the ODOO log wins: the part's line belongs to the order it was closed against", () => {
    const linked = [
      { id: 21, mo: "SF01/MO/16397-001", soi: "S01193-3", bom: "12008E16M18", orderMos: ["PF01/MO/35256-004"] },
      { id: 22, mo: "SF01/MO/16400", soi: "S01193-3", bom: "12008E18M18", orderMos: ["PF01/MO/35256-005"] },
    ];
    const pick = (scope: "mo" | "bom", mos: string[]) =>
      linked.filter(traceMaterialMatch({ scope, mos, sois: ["S01193-3"], bom: "12008E18M18", soiOrders })).map((l) => l.id);
    expect(pick("mo", ["PF01/MO/35256-004"])).toEqual([21]);
    expect(pick("mo", ["PF01/MO/35256-005"])).toEqual([22]);
    expect(pick("bom", ["PF01/MO/35256-004", "PF01/MO/35256-005"])).toEqual([21, 22]);
    // a code's trace with no registry order: a line on the code still shows, closed or not
    const lone = traceMaterialMatch({ scope: "bom", mos: [], sois: [], bom: "12008E18M18", soiOrders: [] });
    expect(lone({ mo: "SF01/MO/16400", soi: "S01193-3", bom: "12008E18M18", orderMos: ["PF01/MO/1"] })).toBe(true);
  });
  it("never takes the SOI's line on another order's code", () => {
    expect(ids("bom")).not.toContain(4);
    expect(ids("mo")).not.toContain(4);
  });
});

describe("materialClosings / lineClosings", () => {
  // order PF01/MO/1's tank closings: the clerk typed part MO SF01/MO/9 on both
  // rows; one is Done, one still open; a cancelled row ties nothing
  const ledger = new Map([[10, { mo: "pf01/mo/1", item: "TN" }], [11, { mo: "PF01/MO/1", item: "TN" }], [12, { mo: "PF01/MO/1", item: "TC" }]]);
  const c = materialClosings([
    { odooMo: "SF01/MO/9", status: "Done", qty: 6, ledgerId: 10 },
    { odooMo: "SF01/MO/9", status: "MO to be close", qty: 4, ledgerId: 11 },
    { odooMo: "SF01/MO/7", status: "Cancelled", qty: 5, ledgerId: 12 },
    { odooMo: "SF01/MO/8", status: "Done", qty: 3, ledgerId: null },
  ], ledger);
  const isOrder = (mo: string) => mo === "PF01/MO/1";
  it("knows a part code's component", () => {
    expect(itemOfPartCode(" fb-022 ")).toBe("TN");
    expect(itemOfPartCode("FB-999")).toBeNull();
  });
  it("a line filed on the ORDER's MO finds its part MOs and closed pieces through the order's closings of the part", () => {
    expect(lineClosings({ mo: "PF01/MO/1", partCode: "FB-022", units: 10 }, isOrder, c)).toEqual({ orderMos: ["PF01/MO/1"], partMos: ["SF01/MO/9"], closed: 6 });
    // nothing closed of the top cover yet (its only row was cancelled): 0, not unknown
    expect(lineClosings({ mo: "PF01/MO/1", partCode: "FB-051", units: 10 }, isOrder, c)).toEqual({ orderMos: ["PF01/MO/1"], partMos: [], closed: 0 });
    // a part code no component answers
    expect(lineClosings({ mo: "PF01/MO/1", partCode: "XX-1", units: 10 }, isOrder, c).closed).toBeNull();
  });
  it("a line filed on the PART's MO finds its order and its closed pieces, never more than its units", () => {
    expect(lineClosings({ mo: "SF01/MO/9", partCode: "FB-022", units: 4 }, isOrder, c)).toEqual({ orderMos: ["PF01/MO/1"], partMos: ["SF01/MO/9"], closed: 4 });
    expect(lineClosings({ mo: "SF01/MO/8", partCode: "FB-022", units: 10 }, isOrder, c)).toEqual({ orderMos: [], partMos: ["SF01/MO/8"], closed: 3 });
    expect(lineClosings({ mo: "", partCode: "FB-022", units: 10 }, isOrder, c)).toEqual({ orderMos: [], partMos: [], closed: null });
  });
  it("a cancelled row ties and counts nothing", () => {
    expect(c.ordersByPart.has("SF01/MO/7")).toBe(false);
    expect(c.doneByPart.has("SF01/MO/7")).toBe(false);
  });
  it("counts a backorder's closings on the line its job is filed under, its own line first", () => {
    const b = materialClosings([
      { odooMo: "SF01/MO/15337", status: "Done", qty: 6, ledgerId: null },
      { odooMo: "SF01/MO/15337-002", status: "Done", qty: 20, ledgerId: 10 },
      { odooMo: "SF01/MO/15337-003", status: "Done", qty: 10, ledgerId: null },
      { odooMo: "SF01/MO/20000-001", status: "Done", qty: 4, ledgerId: null },
      { odooMo: "SF01/MO/20000-002", status: "Done", qty: 5, ledgerId: null },
      { odooMo: "SF01/MO/30000-002", status: "Done", qty: 7, ledgerId: null },
    ], ledger);
    // the sheet files 15337 (its backorders have no line), 20000-001 (and its
    // sibling's closings come to it), and 30000-002 on its own
    const r = withBackorders(b, ["SF01/MO/15337", "sf01/mo/20000-001", "SF01/MO/30000-002", "SF01/MO/30000-003"]);
    const closed = (mo: string) => lineClosings({ mo, partCode: "FB-022", units: 100 }, () => false, r).closed;
    expect(closed("SF01/MO/15337")).toBe(36);
    expect(closed("SF01/MO/20000-001")).toBe(9);
    expect(closed("SF01/MO/30000-002")).toBe(7);
    expect(closed("SF01/MO/30000-003")).toBe(0);
    expect(r.ordersByPart.get("SF01/MO/15337")).toEqual(new Set(["PF01/MO/1"]));
  });
});

describe("adoptedPartLine", () => {
  const spec = { bom: "B1", partCode: "FB-022", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440", soi: "S1" };
  const registry = new Set(["PF01/MO/1", "PF01/MO/2"]);
  const isOrder = (mo: string) => registry.has(mo);
  const closed: Record<string, string[]> = { "SF01/MO/9": ["PF01/MO/1"], "SF01/MO/8": ["PF01/MO/2"], "SF01/MO/5": ["PF01/MO/50"] };
  const ordersOf = (mo: string) => closed[mo] ?? [];
  const row = { ...spec, mo: "PF01/MO/1" };
  const adopt = (r: typeof row, older: ({ id: number } & typeof row)[], rivals: typeof row[] = [r]) => adoptedPartLine(r, older, rivals, isOrder, ordersOf);
  it("takes over the part-MO line closed against this order on the ODOO log", () => {
    expect(adopt(row, [{ id: 1, ...spec, mo: "SF01/MO/8" }, { id: 2, ...spec, mo: "SF01/MO/9" }])?.id).toBe(2);
    // the order not on the Plan Tracker yet: the ODOO log's closing still ties them
    expect(adopt({ ...row, mo: "PF01/MO/50" }, [{ id: 7, ...spec, mo: "SF01/MO/5" }])?.id).toBe(7);
    // the part's code in another case is the same part
    expect(adopt({ ...row, partCode: "fb-022" }, [{ id: 2, ...spec, mo: "SF01/MO/9" }])?.id).toBe(2);
  });
  it("else the SOI's one part-MO line not closed anywhere yet, when the row is the SOI's only order on it", () => {
    expect(adopt(row, [{ id: 3, ...spec, mo: "SF01/MO/7" }])?.id).toBe(3);
    // two open candidates: neither is taken
    expect(adopt(row, [{ id: 3, ...spec, mo: "SF01/MO/7" }, { id: 4, ...spec, mo: "SF01/MO/6" }])).toBeNull();
    // another order of the SOI on the same part and sheet: whose the line is can't be told
    expect(adopt(row, [{ id: 3, ...spec, mo: "SF01/MO/7" }], [row, { ...row, mo: "PF01/MO/2" }])).toBeNull();
    // no SOI to tie them by
    expect(adopt({ ...row, soi: "" }, [{ id: 3, ...spec, soi: "", mo: "SF01/MO/7" }])).toBeNull();
    // closed against ANOTHER order: never this one's
    expect(adopt(row, [{ id: 1, ...spec, mo: "SF01/MO/8" }])).toBeNull();
  });
  it("never for another sheet or part, nor for a row on a part's MO", () => {
    expect(adopt(row, [{ id: 5, ...spec, thicknessMm: 3, mo: "SF01/MO/9" }])).toBeNull();
    expect(adopt({ ...row, mo: "SF01/MO/9" }, [{ id: 3, ...spec, mo: "SF01/MO/7" }])).toBeNull();
    // an order's own line is never taken over
    expect(adopt(row, [{ id: 6, ...spec, mo: "PF01/MO/2" }])).toBeNull();
  });
});
