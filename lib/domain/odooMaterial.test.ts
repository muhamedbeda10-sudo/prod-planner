import { describe, expect, it } from "vitest";
import { bookText, candidateBoms, candidateMos, EMPTY_NEED_CONTEXT, entryMaterialNeed, jobLines, materialNeed, materialNeedText, moKey, monthLabelOfISO, nestingKey, splitFgCode, varianceOf, varianceText, type NestingLine, type NestingLookup } from "./odooMaterial";

function line(over: Partial<NestingLine> & { id: number }): NestingLine {
  return {
    month: "September 2026", bom: "14003E11M11", partCode: "FB-022", partName: "TANK",
    materialCode: "C-SHR-004", material: "HR Sheet", thicknessMm: 4, sheetSize: "1220*2440",
    units: 29, sheetsPerUnit: 2.504, actualPerUnit: null, sheetsUsed: 73, note: null,
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
    expect(rows[0]).toBe("Code\tMaterial\tThk mm\tSheet\tSheets for 5\tvs BOM");
    expect(rows[1]).toBe("C-SHR-004\tHR Sheet\t4\t1220*2440\t12.586\t+1%");
    expect(rows[2]).toBe("C-SHR-016\tHR Sheet\t16\t1220*2440\t0.115 (BOM)\t");
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

describe("variance of actual against BOM", () => {
  it("judges the rate: within 15% ok, past it warn, past 30% bad — either way", () => {
    expect(varianceOf(2.5172, 2.504)).toEqual({ pct: 1, tone: "ok" });
    expect(varianceOf(3, 2.5)).toEqual({ pct: 20, tone: "warn" });
    expect(varianceOf(2, 2.5)).toEqual({ pct: -20, tone: "warn" });
    expect(varianceOf(4, 2.5)).toEqual({ pct: 60, tone: "bad" });
    expect(varianceOf(1, 2.5)).toEqual({ pct: -60, tone: "bad" });
    expect(varianceOf(null, 2.5)).toEqual({ pct: null, tone: null });
    expect(varianceOf(1, 0)).toEqual({ pct: null, tone: null });
  });

  it("writes it signed", () => {
    expect(varianceText(18)).toBe("+18%");
    expect(varianceText(-7)).toBe("−7%");
    expect(varianceText(0)).toBe("0%");
    expect(varianceText(null)).toBe("");
  });

  it("carries it on the lines and counts the ones off the BOM", () => {
    const wide: NestingLookup = {
      [nestingKey("FB-022", "X")]: [
        line({ id: 1, bom: "X", sheetsPerUnit: 2, sheetsUsed: 2 * 29 }), // spot on
        line({ id: 2, bom: "X", materialCode: "B", thicknessMm: 5, sheetsPerUnit: 1, sheetsUsed: 1.25 * 29 }), // +25 → warn
        line({ id: 3, bom: "X", materialCode: "C", thicknessMm: 6, sheetsPerUnit: 1, sheetsUsed: 2 * 29 }), // +100 → bad
        line({ id: 4, bom: "X", materialCode: "D", thicknessMm: 8, sheetsPerUnit: 1, sheetsUsed: null }), // not nested
      ],
    };
    const need = materialNeed(wide, "FB-022-X", 4, "September 2026")!;
    expect(need.lines.map((l) => [l.materialCode, l.variancePct, l.varianceTone])).toEqual([
      ["C-SHR-004", 0, "ok"], ["B", 25, "warn"], ["C", 100, "bad"], ["D", null, null],
    ]);
    expect(need.offBom).toBe(2);
    // over the nested lines: actual 2 + 1.25 + 2 = 5.25 against BOM 2 + 1 + 1 = 4 → +31%
    expect(need.totalVariancePct).toBe(31);
    expect(need.totalVarianceTone).toBe("bad");
  });

  it("has no total variance while nothing is nested", () => {
    const none: NestingLookup = { [nestingKey("FB-022", "Y")]: [line({ id: 1, bom: "Y", sheetsUsed: null })] };
    const need = materialNeed(none, "FB-022-Y", 4, "September 2026")!;
    expect(need.totalVariancePct).toBeNull();
    expect(need.offBom).toBe(0);
  });
});

describe("materialNeed — the rate the popup multiplies is the sheet's own", () => {
  const key = nestingKey("FB-022", "14003E11M11");

  it("takes the line's stored rate rather than dividing the job's sheets again", () => {
    // 0.568 a unit is what the sheet said; 17.6 over 29 units is the stale
    // "for Job" column that the division would have recovered
    const l: NestingLookup = { [key]: [line({ id: 1, actualPerUnit: 0.568, sheetsUsed: 16.472, units: 29 })] };
    const need = materialNeed(l, "FB-022-14003E11M11", 10, "September 2026")!;
    expect(need.lines[0].actualPerUnit).toBe(0.568);
    expect(need.lines[0].forQtyActual).toBe(5.68);
  });

  it("still divides for a line that carries no rate of its own", () => {
    const l: NestingLookup = { [key]: [line({ id: 1, actualPerUnit: null, sheetsUsed: 58, units: 29 })] };
    const need = materialNeed(l, "FB-022-14003E11M11", 10, "September 2026")!;
    expect(need.lines[0].actualPerUnit).toBe(2);
    expect(need.lines[0].forQtyActual).toBe(20);
  });

  it("keeps a rate even when the line names no units at all", () => {
    const l: NestingLookup = { [key]: [line({ id: 1, actualPerUnit: 0.5, sheetsUsed: null, units: 0 })] };
    const need = materialNeed(l, "FB-022-14003E11M11", 8, "September 2026")!;
    expect(need.lines[0].forQtyActual).toBe(4);
  });
});

describe("panels — the material is the order's, keyed by MO", () => {
  const lvLine = (over: Partial<NestingLine> & { id: number }): NestingLine =>
    line({ bom: "FG-SUA-AS-AA-000004-1", partCode: "", partName: "USS", materialCode: "908569105", material: "Galvanized steel", sheetSize: "1250*2500", units: 50, ...over });
  const lookup: NestingLookup = {
    [moKey("SF01/MO/03673-001")]: [
      // 8 units consumed 14.4 sheets → 1.8 a unit, against a BOM of 1.6
      lvLine({ id: 1, thicknessMm: 1.5, sheetsPerUnit: 1.6, actualPerUnit: 1.8, sheetsUsed: null }),
      lvLine({ id: 2, thicknessMm: 2, sheetsPerUnit: 0.5, actualPerUnit: null, sheetsUsed: null }),
    ],
    [moKey("SF01/MO/06206")]: [lvLine({ id: 3, thicknessMm: 1.5, sheetsPerUnit: 1.6, actualPerUnit: 1.6, sheetsUsed: 8, units: 5 })],
  };
  const ctx = { lv: true, soiBoms: {}, soiMos: { "S00653-2": ["SF01/MO/03673-001", "SF01/MO/03673-003"], "S01035-1": ["SF01/MO/06206"] } };

  it("lists the candidate orders in lookup order: the closing's, the typed MO, then the SOI's", () => {
    expect(candidateMos({ mo: "sf01/mo/06206", odooMo: "SF01/MO/03673-001", soi: "S00653-2" }, ctx.soiMos["S00653-2"])).toEqual([
      { mo: "SF01/MO/06206", via: "ledger" }, { mo: "SF01/MO/03673-001", via: "odoo" }, { mo: "SF01/MO/03673-003", via: "order" },
    ]);
    expect(candidateMos({ mo: null, odooMo: "", soi: null }, [])).toEqual([]);
  });

  it("scales the order's rows to the row's qty, consumed rate first, BOM where nothing was consumed", () => {
    const need = entryMaterialNeed(lookup, { fgCode: "FG-SUA-AS-AA-000004", dateISO: "2026-09-21", soi: "S00653-2", odooMo: "", mo: "SF01/MO/03673-001" }, 24, ctx)!;
    expect(need.mo).toBe("SF01/MO/03673-001");
    expect(need.via).toBe("ledger");
    expect(need.bom).toBe("FG-SUA-AS-AA-000004-1");
    expect(need.partCode).toBe("");
    expect(need.lines.map((l) => [l.thicknessMm, l.forQtyBom, l.forQtyActual, l.book, l.bookIsActual])).toEqual([
      [1.5, 38.4, 43.2, 43.2, true],
      [2, 12, null, 12, false],
    ]);
    expect(need.lines[0].variancePct).toBe(12);
    expect(need.totalActual).toBe(43.2);
    expect(need.notNested).toBe(1);
  });

  it("falls back to the SOI's orders when the row links to no closing and has no MO typed", () => {
    const need = entryMaterialNeed(lookup, { fgCode: "FG-SUA-AS-AA-000004", dateISO: "2026-09-21", soi: "s01035-1", odooMo: "", mo: null }, 2, ctx)!;
    expect(need.mo).toBe("SF01/MO/06206");
    expect(need.via).toBe("order");
    expect(need.lines[0].forQtyActual).toBe(3.2);
  });

  it("is null when none of the row's orders has lines yet — the FG code alone finds nothing", () => {
    expect(entryMaterialNeed(lookup, { fgCode: "FG-SUA-AS-AA-000004", dateISO: "2026-09-21", soi: "S01060-1", odooMo: "SF01/MO/03673-003", mo: null }, 2, ctx)).toBeNull();
  });

  it("still finds a transformer part the old way when the context is not the panels'", () => {
    const trLookup: NestingLookup = { [nestingKey("FB-022", "14003E11M11")]: [line({ id: 1 })] };
    const need = entryMaterialNeed(trLookup, { fgCode: "FB-022-14003E11M11", dateISO: "2026-09-07", soi: null, odooMo: "WH/MO/1", mo: null }, 2, EMPTY_NEED_CONTEXT)!;
    expect(need.via).toBe("fg");
    expect(need.mo).toBeNull();
  });
});

describe("a transformer row finds the lines filed under its own Odoo MO first", () => {
  const withMo: NestingLookup = {
    ...lookup,
    [moKey("SF01/MO/20905")]: [line({ id: 50, units: 11, sheetsPerUnit: 0.8, sheetsUsed: null, materialCode: "C-SHR-004" })],
  };
  const row = { fgCode: "FB-022-14003E11M11", dateISO: "2026-09-20", soi: null, odooMo: "sf01/mo/20905 " };

  it("uses the MO's lines when the material sheet names that MO", () => {
    const need = entryMaterialNeed(withMo, row, 11, EMPTY_NEED_CONTEXT)!;
    expect(need.mo).toBe("SF01/MO/20905");
    expect(need.via).toBe("odoo");
    expect(need.partCode).toBe("FB-022");
    expect(need.lines.map((l) => l.id)).toEqual([50]);
    expect(need.totalBom).toBeCloseTo(8.8);
  });

  it("falls back to part × BOM when the MO has no lines", () => {
    const need = entryMaterialNeed(withMo, { ...row, odooMo: "SF01/MO/99999" }, 11, EMPTY_NEED_CONTEXT)!;
    expect(need.mo).toBeNull();
    expect(need.lines.map((l) => l.id)).toEqual([1, 3, 2]);
  });
});

describe("a row's material is its own BOM's and its own job's", () => {
  const job = (soi: string, mo: string, id: number, over: Partial<NestingLine> = {}) =>
    line({ id, bom: "12008E14M14", soi, mo, units: 12, ...over });
  const shared: NestingLookup = {
    [nestingKey("FB-022", "12008E14M14")]: [
      job("S01134-3", "", 1, { sheetsUsed: 4 }),
      job("S01316-1", "SF01/MO/17036", 2, { sheetsUsed: null }),
      job("S01317-2", "SF01/MO/17102", 3, { sheetsUsed: null }),
    ],
  };
  const row = { fgCode: "FB-022-12008E23M14", dateISO: "2026-10-03", soi: "S01134-3", odooMo: "SF01/MO/15285" };
  const ctx = { ...EMPTY_NEED_CONTEXT, soiBoms: { "S01134-3": ["12008E14M14", "12008E23M14"] } };

  it("never borrows another BOM of the same SOI when the row knows its own", () => {
    expect(entryMaterialNeed(shared, { ...row, bom: { boms: ["12008E23M14"] } }, 26, ctx)).toBeNull();
    expect(candidateBoms(row.fgCode, ["12008E14M14", "12008E23M14"], ["12008E23M14"])?.boms).toEqual([{ bom: "12008E23M14", via: "row" }]);
  });

  it("shows only the lines of the row's own order, not every order of the BOM", () => {
    const need = entryMaterialNeed(shared, { ...row, bom: { boms: ["12008E14M14"] } }, 26, ctx);
    expect(need?.lines.map((l) => l.id)).toEqual([1]);
    expect(need?.via).toBe("row");
  });

  it("matches the Odoo MO before the SOI, and falls back to lines that cover the whole BOM", () => {
    expect(jobLines(shared[nestingKey("FB-022", "12008E14M14")], { soi: "S01134-3", odooMo: "SF01/MO/17102" }).map((l) => l.id)).toEqual([3]);
    const bomWide = [line({ id: 7 }), line({ id: 8, soi: "S09999-1" })];
    expect(jobLines(bomWide, { soi: "S01134-3", odooMo: "" }).map((l) => l.id)).toEqual([7]);
    expect(jobLines(shared[nestingKey("FB-022", "12008E14M14")], { soi: "S04444-1", odooMo: "" })).toEqual([]);
  });
});
