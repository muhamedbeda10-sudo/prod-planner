import { describe, expect, it } from "vitest";
import { MAX_SPLIT_SHEETS, cellNumber, isTotalRow, layoutSheets, type Layout } from "./sheetLayout";

const nested = [
  { MO: "A", "Thickness mm": 3, "BOM sheets": 4, "Actual sheets": 5, "Delta sheets": 1 },
  { MO: "B", "Thickness mm": 2, "BOM sheets": 2.5, "Actual sheets": 2, "Delta sheets": -0.5 },
  { MO: "C", "Thickness mm": 3, "BOM sheets": 6, "Actual sheets": "", "Delta sheets": "" },
  { MO: "D", "Thickness mm": "3", "BOM sheets": 1, "Actual sheets": 1, "Delta sheets": 0 },
  { MO: "E", "Thickness mm": "", "BOM sheets": 1, "Actual sheets": 1, "Delta sheets": 0 },
];

const ok = (r: Layout | { error: string }): Layout => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("layoutSheets", () => {
  it("leaves the rows as they are when nothing is asked", () => {
    const r = ok(layoutSheets(nested, "Nesting", {}));
    expect(r.sheets).toEqual([{ name: "Nesting", rows: nested }]);
    expect(r).toMatchObject({ dropped: 0, notNumbers: 0 });
  });

  it("puts each thickness on its own sheet, smallest first, the blank last — a number and its text one sheet", () => {
    const r = ok(layoutSheets(nested, "Nesting", { splitBy: "thickness MM" }));
    expect(r.sheets.map((s) => [s.name, s.rows.map((x) => x.MO)])).toEqual([
      ["2 mm", ["B"]],
      ["3 mm", ["A", "C", "D"]],
      ["(blank)", ["E"]],
    ]);
  });

  it("keeps only the rows actually nested, and closes each sheet with its totals", () => {
    const r = ok(layoutSheets(nested, "Nesting", { splitBy: "Thickness mm", nonBlank: ["Actual sheets"], totals: ["BOM sheets", "Actual sheets", "Delta sheets"] }));
    expect(r.dropped).toBe(1);
    const three = r.sheets.find((s) => s.name === "3 mm")!;
    expect(three.rows.map((x) => x.MO)).toEqual(["A", "D"]);
    expect(three.total).toEqual({ MO: "Total", "Thickness mm": "", "BOM sheets": 5, "Actual sheets": 6, "Delta sheets": 1 });
    expect(r.sheets.find((s) => s.name === "2 mm")!.total).toMatchObject({ "BOM sheets": 2.5, "Actual sheets": 2, "Delta sheets": -0.5 });
  });

  it("adds up numbers written as text, without the float's tail, and counts the text it cannot", () => {
    const rows = [{ Name: "x", Qty: "1,200.1" }, { Name: "y", Qty: 0.2 }, { Name: "z", Qty: "n/a" }, { Name: "w", Qty: "" }];
    const r = ok(layoutSheets(rows, "S", { totals: ["Qty"] }));
    expect(r.sheets[0].total).toEqual({ Name: "Total", Qty: 1200.3 });
    expect(r.notNumbers).toBe(1);
    expect(r.sheets[0].rows).toHaveLength(4);
  });

  it("refuses a column the sheet does not have, naming the ones it has", () => {
    expect(layoutSheets(nested, "S", { totals: ["Weight"] })).toEqual({ error: expect.stringMatching(/no column "Weight".*MO, Thickness mm/) });
    expect(layoutSheets(nested, "S", { splitBy: "Size", nonBlank: ["Kg"] })).toEqual({ error: expect.stringContaining(`"Size", "Kg"`) });
  });

  it("refuses totals over every column — the Total label needs one", () => {
    expect(layoutSheets([{ a: 1, b: 2 }], "S", { totals: ["a", "B"] })).toEqual({ error: expect.stringContaining("label") });
  });

  it("refuses more sheets than one file holds", () => {
    const many = Array.from({ length: MAX_SPLIT_SHEETS + 1 }, (_, i) => ({ T: i }));
    expect(layoutSheets(many, "S", { splitBy: "T" })).toEqual({ error: expect.stringContaining(`${MAX_SPLIT_SHEETS + 1} sheets`) });
  });

  it("names a split by text as the text, and leaves no sheet when every row is dropped", () => {
    const rows = [{ Material: "HR Sheet", Qty: 1 }, { Material: "hr sheet", Qty: 2 }, { Material: "Galvanized", Qty: 3 }];
    expect(ok(layoutSheets(rows, "S", { splitBy: "Material" })).sheets.map((s) => [s.name, s.rows.length])).toEqual([["Galvanized", 1], ["HR Sheet", 2]]);
    expect(ok(layoutSheets([{ A: "" }], "S", { splitBy: "A", nonBlank: ["A"] })).sheets).toEqual([]);
  });
});

describe("a split sheet's name", () => {
  it("carries the unit the column's heading ends in, whatever its form", () => {
    const names = (column: string) => ok(layoutSheets([{ [column]: 2, Q: 1 }], "S", { splitBy: column })).sheets[0].name;
    expect([names("Thickness (mm)"), names("thickness_mm"), names("Weight kg"), names("Cable mm2"), names("Sheet size"), names("Plan")]).toEqual(["2 mm", "2 mm", "2 kg", "2 mm2", "2", "2"]);
  });
});

describe("isTotalRow", () => {
  it("reads Total in the first filled cell that is not a number — never a Total further along", () => {
    expect(isTotalRow({ Line: "", Department: "Total", Booked: 16 })).toBe(true);
    expect(isTotalRow({ Qty: 5, Name: "Total" })).toBe(true);
    expect(isTotalRow(["", "12", "Total"])).toBe(true);
    expect(isTotalRow({ MO: "A", Status: "Total" })).toBe(false);
    expect(isTotalRow({ MO: "Totals" })).toBe(false);
    expect(isTotalRow(undefined)).toBe(false);
  });
});

describe("cellNumber", () => {
  it("reads numbers and the text of one, nothing else", () => {
    expect([cellNumber(3), cellNumber(" -2.5 "), cellNumber("1,234"), cellNumber(".5"), cellNumber("12,345,678.9"), cellNumber("3,4"), cellNumber("1,23"), cellNumber("3 mm"), cellNumber(""), cellNumber(undefined), cellNumber(Number.NaN)]).toEqual([3, -2.5, 1234, 0.5, 12345678.9, null, null, null, null, null, null]);
  });
});
