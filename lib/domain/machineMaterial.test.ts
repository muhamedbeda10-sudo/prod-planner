import { describe, it, expect } from "vitest";
import { lineMaterialOf, pickJobLines, sheetsFor, thicknessLabel, type NestingLineLite } from "./machineMaterial";

const L = (o: Partial<NestingLineLite>): NestingLineLite => ({
  month: "October 2026", soi: "", mo: "", partName: "TANK", material: "Steel", materialCode: "", thicknessMm: 3,
  sheetSize: "1220*2440", units: 10, sheetsPerUnit: 0.5, actualPerUnit: null, sheetsUsed: null, ...o,
});

describe("pickJobLines", () => {
  it("takes the order's own SOI first, then the BOM-wide lines", () => {
    const all = [L({ soi: "S1", thicknessMm: 4 }), L({ thicknessMm: 3 }), L({ soi: "S2", thicknessMm: 5 })];
    expect(pickJobLines(all, "s1").map((l) => l.thicknessMm)).toEqual([4]);
    expect(pickJobLines(all, "S9").map((l) => l.thicknessMm)).toEqual([3]);
  });
  it("falls back on every job of the BOM when none is the order's", () => {
    const all = [L({ soi: "S1" }), L({ soi: "S2" })];
    expect(pickJobLines(all, "S9")).toHaveLength(2);
  });
});

describe("lineMaterialOf", () => {
  it("reads the order's plan month, one spec per sheet, the actual rate before the BOM's", () => {
    const m = lineMaterialOf([
      L({ month: "September 2026", thicknessMm: 2 }),
      L({ thicknessMm: 3, actualPerUnit: 0.6 }),
      L({ thicknessMm: 3, actualPerUnit: 0.9 }), // a second job's line for the same sheet
      L({ thicknessMm: 5, material: "Galvanized steel", sheetsUsed: 4, units: 10 }),
      L({ thicknessMm: 1.5 }),
    ], ["October 2026"])!;
    expect(m.month).toBe("October 2026");
    expect(m.specs.map((s) => [s.thicknessMm, s.perUnit, s.actual])).toEqual([[5, 0.4, true], [3, 0.6, true], [1.5, 0.5, false]]);
  });
  it("falls back on the newest month the tracker has", () => {
    const m = lineMaterialOf([L({ month: "August 2026", thicknessMm: 2 }), L({ month: "September 2026", thicknessMm: 4 })], ["October 2026"])!;
    expect(m.month).toBe("September 2026");
    expect(m.specs.map((s) => s.thicknessMm)).toEqual([4]);
  });
  it("is null with no nesting", () => {
    expect(lineMaterialOf([])).toBeNull();
  });
});

describe("sheetsFor / thicknessLabel", () => {
  it("scales the rate to the pieces on the machine", () => {
    expect(sheetsFor({ material: "Steel", materialCode: "", thicknessMm: 3, sheetSize: "", perUnit: 0.333, actual: true }, 7)).toBe(2.33);
    expect(thicknessLabel({ thicknessMm: 2.5, material: "Galvanized steel" })).toBe("2.5 mm GI");
  });
});
