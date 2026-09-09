import { describe, expect, it } from "vitest";
import { bookText, candidateBoms, materialNeed, materialNeedText, monthLabelOfISO, nestingKey, splitFgCode, type NestingLine, type NestingLookup } from "./odooMaterial";

function line(over: Partial<NestingLine> & { id: number }): NestingLine {
  return {
    month: "September 2026", bom: "14003E11M11", partCode: "FB-022", partName: "TANK",
    materialCode: "C-SHR-004", material: "HR Sheet", thicknessMm: 4, sheetSize: "1220*2440",
    units: 29, sheetsPerUnit: 2.504, sheetsUsed: 73, note: null,
    ...over,
  };
}

const lookup: NestingLookup = {
  [nestingKey("FB-022", "14003E11M11")]: [
    line({ id: 1 }),
    line({ id: 2, materialCode: "T-SSS-5MM", material: "Stainless steel", thicknessMm: 5, sheetsPerUnit: 0.3048, sheetsUsed: 6.4 }),
    line({ id: 3, materialCode: "C-SHR-016", material: "HR Sheet", thicknessMm: 16, sheetsPerUnit: 0.023, sheetsUsed: null }),
    line({ id: 4, month: "August 2026", units: 10, sheetsPerUnit: 2.5, sheetsUsed: 30 }),
  ],
  [nestingKey("FB-051", "14003E11M11")]: [line({ id: 9, partCode: "FB-051", partName: "TOP COVER", sheetsPerUnit: 0.363, sheetsUsed: 1.1678 })],
};

describe("splitFgCode", () => {
  it("splits the office's FG-CODE into part and BOM", () => {
    expect(splitFgCode("FB-022-14003E11M11")).toEqual({ partCode: "FB-022", bom: "14003E11M11" });
    expect(splitFgCode(" fb-024-00007S14 ")).toEqual({ partCode: "FB-024", bom: "00007S14" });
    expect(splitFgCode("FB-058-19970-002")).toEqual({ partCode: "FB-058", bom: "19970-002" });
  });
  it("is null for a bare BOM or nothing", () => {
    expect(splitFgCode("14003E11M11")).toBeNull();
    expect(splitFgCode("")).toBeNull();
    expect(splitFgCode("FB-022")).toBeNull();
  });
});

describe("monthLabelOfISO", () => {
  it("names the month a row was logged in", () => {
    expect(monthLabelOfISO("2026-09-07")).toBe("September 2026");
    expect(monthLabelOfISO("bad")).toBe("");
  });
});

describe("materialNeed", () => {
  it("scales the part's lines on its BOM to the row's qty, actual rate first", () => {
    const need = materialNeed(lookup, "FB-022-14003E11M11", 5, "September 2026");
    expect(need).not.toBeNull();
    expect(need!.month).toBe("September 2026");
    expect(need!.partName).toBe("TANK");
    expect(need!.otherMonths).toEqual(["August 2026"]);
    expect(need!.lines.map((l) => l.materialCode)).toEqual(["C-SHR-004", "C-SHR-016", "T-SSS-5MM"]);
    const hr4 = need!.lines[0];
    expect(hr4.forQtyBom).toBe(12.52); // 2.504 × 5
    expect(hr4.forQtyActual).toBe(12.586); // 73 / 29 × 5
    expect(hr4.book).toBe(12.586);
    expect(hr4.bookIsActual).toBe(true);
  });

  it("falls back to the BOM rate while a line is not nested, and says so", () => {
    const need = materialNeed(lookup, "FB-022-14003E11M11", 5, "September 2026")!;
    const hr16 = need.lines.find((l) => l.materialCode === "C-SHR-016")!;
    expect(hr16.forQtyActual).toBeNull();
    expect(hr16.book).toBe(0.115);
    expect(hr16.bookIsActual).toBe(false);
    expect(need.notNested).toBe(1);
    expect(need.totalBom).toBe(14.159); // 12.52 + 0.115 + 1.524
    expect(need.totalActual).toBe(13.689); // 12.586 + 1.103
  });

  it("uses the newest month that has the BOM when the row's month does not", () => {
    const need = materialNeed(lookup, "FB-022-14003E11M11", 2, "October 2026")!;
    expect(need.month).toBe("September 2026");
    expect(need.otherMonths).toEqual(["August 2026"]);
  });

  it("uses the row's own month when the tracker has it", () => {
    const need = materialNeed(lookup, "FB-022-14003E11M11", 2, "August 2026")!;
    expect(need.month).toBe("August 2026");
    expect(need.lines).toHaveLength(1);
    expect(need.lines[0].forQtyActual).toBe(6); // 30 / 10 × 2
  });

  it("keeps the same BOM's parts apart", () => {
    const need = materialNeed(lookup, "FB-051-14003E11M11", 4, "September 2026")!;
    expect(need.partName).toBe("TOP COVER");
    expect(need.lines).toHaveLength(1);
    expect(need.lines[0].forQtyBom).toBe(1.452);
  });

  it("is null with no lines or an unsplittable code", () => {
    expect(materialNeed(lookup, "FB-024-00007S14", 3, "September 2026")).toBeNull();
    expect(materialNeed(lookup, "14003E11M11", 3, "September 2026")).toBeNull();
  });

  it("treats a bad qty as zero rather than NaN", () => {
    const need = materialNeed(lookup, "FB-022-14003E11M11", NaN, "September 2026")!;
    expect(need.qty).toBe(0);
    expect(need.lines[0].book).toBe(0);
  });
});

describe("materialNeedText", () => {
  it("is tab-separated, one line per material, BOM-rate lines marked", () => {
    const need = materialNeed(lookup, "FB-022-14003E11M11", 5, "September 2026")!;
    const text = materialNeedText(need);
    const rows = text.split("\n");
    expect(rows[0]).toBe("Code\tMaterial\tThk mm\tSheet\tSheets for 5");
    expect(rows[1]).toBe("C-SHR-004\tHR Sheet\t4\t1220*2440\t12.586");
    expect(rows[2]).toBe("C-SHR-016\tHR Sheet\t16\t1220*2440\t0.115 (BOM)");
  });
  it("writes numbers without trailing zeros", () => {
    expect(bookText(12.5)).toBe("12.5");
    expect(bookText(6)).toBe("6");
    expect(bookText(1.6919999999999997)).toBe("1.692");
  });
});

describe("materialNeed through the SOI's order", () => {
  // the top cover's FG-CODE carries its own drawing code, not the transformer's
  // BOM; the SOI's order in the registry names the transformer
  const soiLookup: NestingLookup = {
    ...lookup,
    [nestingKey("FB-051", "12011E16M13")]: [line({ id: 20, bom: "12011E16M13", partCode: "FB-051", partName: "TOP COVER", sheetsPerUnit: 0.5, sheetsUsed: null, units: 10 })],
    [nestingKey("FB-022", "12011E16M13")]: [line({ id: 21, bom: "12011E16M13" })],
  };

  it("finds the part under the SOI's BOM when the FG-CODE's suffix is not it", () => {
    const need = materialNeed(soiLookup, "FB-051-12011E12M12", 5, "September 2026", ["12011E16M13"])!;
    expect(need).not.toBeNull();
    expect(need.bom).toBe("12011E16M13");
    expect(need.via).toBe("soi");
    expect(need.partName).toBe("TOP COVER");
    expect(need.lines[0].forQtyBom).toBe(2.5);
  });

  it("prefers the SOI's BOM over the FG-CODE's when both have lines", () => {
    const need = materialNeed(soiLookup, "FB-022-14003E11M11", 1, "September 2026", ["12011E16M13"])!;
    expect(need.bom).toBe("12011E16M13");
    expect(need.via).toBe("soi");
  });

  it("falls back to the FG-CODE's BOM when the SOI's has no line for the part", () => {
    const need = materialNeed(soiLookup, "FB-022-14003E11M11", 1, "September 2026", ["99999E11M11"])!;
    expect(need.bom).toBe("14003E11M11");
    expect(need.via).toBe("fg");
  });

  it("is null when the part is under neither — the BOM being there is not enough", () => {
    expect(materialNeed(soiLookup, "FB-059-12011E16M13", 1, "September 2026", ["12011E16M13"])).toBeNull();
  });

  it("lists the candidates in lookup order without doubling", () => {
    expect(candidateBoms("FB-022-14003E11M11", ["12011E16M13", "14003e11m11", ""])).toEqual({
      partCode: "FB-022",
      boms: [{ bom: "12011E16M13", via: "soi" }, { bom: "14003E11M11", via: "soi" }],
    });
    expect(candidateBoms("FB-022-14003E11M11", [])).toEqual({ partCode: "FB-022", boms: [{ bom: "14003E11M11", via: "fg" }] });
    expect(candidateBoms("14003E11M11", ["12011E16M13"])).toBeNull();
  });
});
