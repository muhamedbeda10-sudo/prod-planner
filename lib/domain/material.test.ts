import { describe, it, expect } from "vitest";
import {
  normalizeMaterialType,
  normalizeSheetSize,
  parseSheetNumber,
  sheetsForJob,
  sheetsDifference,
  resolveUnits,
  summarizeMaterial,
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

describe("the two comparison columns", () => {
  it("multiplies out what the BOM allows without Excel's float dust", () => {
    // the sheet stored 0.564 * 3 as 1.6919999999999997
    expect(sheetsForJob(0.564, 3)).toBe(1.692);
    expect(sheetsForJob(1.243, 22)).toBe(27.346);
    expect(sheetsForJob(0, 90)).toBe(0);
  });

  it("difference is what the BOM allowed minus what was really used", () => {
    expect(sheetsDifference(27.346, 17)).toBe(10.346);
    expect(sheetsDifference(2.97, 0.5)).toBe(2.47);
    // eating more than the BOM allows is a negative difference, not an error
    expect(sheetsDifference(5, 8)).toBe(-3);
  });

  it("goes silent when the line carries no BOM figure to compare against", () => {
    expect(sheetsForJob(null, 22)).toBeNull();
    expect(sheetsDifference(null, 17)).toBeNull();
  });

  it("treats a genuine zero usage as a real number, not a blank", () => {
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
    sheetsUsed: 10, sheetsPerUnit: 1, unitsOverride: null, note: null,
    units: 10, unitsFromRegistry: true, allowed: 10, difference: 0,
    updatedISO: "2026-09-01", recordedBy: null, ...over,
  };
}

describe("summarizeMaterial", () => {
  it("adds up what was used, and what the BOM allowed, per material and size", () => {
    const totals = summarizeMaterial([
      line({ id: 1, sheetsUsed: 8, allowed: 10 }),
      line({ id: 2, bom: "B2", sheetsUsed: 5, allowed: 5.5 }),
      line({ id: 3, material: "Stainless steel", sheetsUsed: 2, allowed: 2 }),
    ]);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ material: "Stainless steel", used: 2, allowed: 2, linesWithoutBom: 0 });
    expect(totals[1]).toMatchObject({ material: "Steel", used: 13, allowed: 15.5, linesWithoutBom: 0 });
  });

  it("still totals the real usage when a line carries no BOM figure", () => {
    const [t] = summarizeMaterial([
      line({ id: 1, sheetsUsed: 10, sheetsPerUnit: null, allowed: null }),
      line({ id: 2, sheetsUsed: 4, allowed: 4 }),
    ]);
    // the usage total is complete; the BOM column says so itself
    expect(t.used).toBe(14);
    expect(t.allowed).toBe(4);
    expect(t.linesWithoutBom).toBe(1);
  });
});
