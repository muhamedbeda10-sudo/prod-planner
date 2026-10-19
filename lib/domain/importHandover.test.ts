import { describe, it, expect } from "vitest";
import { parseCellDate, parseHandoverGrid, validateHandoverRow } from "./importHandover";
import { excelSerialToDate, toDisplayDate } from "./dates";

describe("parseCellDate", () => {
  it("reads Excel serials, m/d/yyyy strings, and ISO strings as the same UTC day", () => {
    expect(toDisplayDate(parseCellDate(46207)!)).toBe("04/07/2026"); // serial
    expect(toDisplayDate(parseCellDate("7/4/2026")!)).toBe("04/07/2026"); // sheet locale m/d/yyyy
    expect(toDisplayDate(parseCellDate("2026-07-04")!)).toBe("04/07/2026"); // ISO
  });
  it("returns null for junk", () => {
    expect(parseCellDate("not a date")).toBeNull();
    expect(parseCellDate(null)).toBeNull();
  });
  it("refuses a date that is not on the calendar instead of rolling it to another day", () => {
    expect(parseCellDate("25/09/2026")).toBeNull(); // a d/m cell in the m/d sheet: month 25
    expect(parseCellDate("9/31/2026")).toBeNull();
    expect(parseCellDate("2026-02-30")).toBeNull();
    expect(toDisplayDate(parseCellDate("2/29/2028")!)).toBe("29/02/2028"); // a real leap day
  });
});

describe("parseHandoverGrid", () => {
  const grid: unknown[][] = [
    ["Date", "DEPT", "BOM", "Item", "QTY", "Week"],
    [46207, "Cut", "12011E14M12", "TN", 10, 27],
    [46207, "Welding", "12011E14M12", "CF", 26, 27],
    [], // blank row skipped
    ["7/4/2026", "Cut", "78019E11M11", "cb", 2, 27], // string date + lowercase item
  ];
  const { rows } = parseHandoverGrid(grid);

  it("parses data rows from row 2 and skips blanks", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ dept: "Cut", bom: "12011E14M12", item: "TN", qty: 10, planNo: 27 });
  });
  it("uppercases the item", () => {
    expect(rows[2].item).toBe("CB");
  });
  it("all parsed rows validate", () => {
    expect(rows.every((r) => validateHandoverRow(r) === null)).toBe(true);
  });
});

describe("parseHandoverGrid — MO column (mapped by header name)", () => {
  it("reads MO when the header has an MO column, in any position", () => {
    const grid: unknown[][] = [
      ["Date", "DEPT", "BOM", "MO", "Item", "QTY", "Week"],
      [46212, "Cut", "14002E11M11", "PF01/MO/31429", "CB", 3, 28],
      [46212, "Welding", "14002E11M11", null, "CB", 1, 28], // blank MO -> null
    ];
    const { rows, hasMoColumn } = parseHandoverGrid(grid);
    expect(hasMoColumn).toBe(true);
    expect(rows[0].mo).toBe("PF01/MO/31429");
    expect(rows[1].mo).toBeNull();
    expect(rows.every((r) => validateHandoverRow(r) === null)).toBe(true);
  });

  it("legacy 6-column files (no MO header) still import with mo = null", () => {
    const grid: unknown[][] = [
      ["Date", "DEPT", "BOM", "Item", "QTY", "Week"],
      [46207, "Cut", "12011E14M12", "TN", 10, 27],
    ];
    const { rows, hasMoColumn } = parseHandoverGrid(grid);
    expect(hasMoColumn).toBe(false);
    expect(rows[0]).toMatchObject({ bom: "12011E14M12", item: "TN", qty: 10, mo: null });
  });

  it("column order doesn't matter when headers are named", () => {
    const grid: unknown[][] = [
      ["Week", "QTY", "Item", "MO#", "BOM", "DEPT", "Date"],
      [28, 5, "CF", "PF01/MO/99999", "60022E11M11", "Welding", 46213],
    ];
    const { rows } = parseHandoverGrid(grid);
    expect(rows[0]).toMatchObject({
      dept: "Welding", bom: "60022E11M11", mo: "PF01/MO/99999", item: "CF", qty: 5, planNo: 28,
    });
  });
});

describe("validateHandoverRow", () => {
  const base = { rowNum: 2, date: excelSerialToDate(46207), dept: "Cut", bom: "A", mo: null, item: "CF", qty: 5, planNo: 27 };
  it("rejects bad dept / item / qty / date / plan", () => {
    expect(validateHandoverRow({ ...base, dept: "Paint" })).toMatch(/department/i);
    expect(validateHandoverRow({ ...base, item: "XX" })).toMatch(/component/i);
    expect(validateHandoverRow({ ...base, qty: 0 })).toMatch(/quantity/i);
    expect(validateHandoverRow({ ...base, date: null })).toMatch(/date/i);
    expect(validateHandoverRow({ ...base, planNo: null })).toMatch(/week\/plan/i);
    expect(validateHandoverRow(base)).toBeNull();
  });
});
