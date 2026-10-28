import { describe, expect, it } from "vitest";
import { AI_MAX_QUESTION } from "./ai";
import { parseCsv, tableCsv, tableExportQuestion, tableFileName, tableSheetRows, tidyTable } from "./tableExport";

describe("tidyTable", () => {
  it("names every column, tells twins apart and leaves out an unnamed empty one", () => {
    const t = tidyTable({
      columns: ["MO", "", "Done", "done", ""],
      rows: [
        ["101", "", "3", "4", "x"],
        ["102", "", "1", "2", ""],
      ],
    });
    expect(t.columns).toEqual(["MO", "Done", "done (2)", "Column 4"]);
    expect(tidyTable({ columns: ["Done", "Done", "Done (2)"], rows: [["1", "2", "3"]] }).columns).toEqual(["Done", "Done (2)", "Done (2) (2)"]);
    expect(t.rows).toEqual([["101", "3", "4", "x"], ["102", "1", "2", ""]]);
  });

  it("keeps a named column with nothing in it, drops empty rows and folds white space", () => {
    const t = tidyTable({ columns: ["MO", "Note"], rows: [["  101 \n A ", ""], ["", ""], ["102"]] });
    expect(t).toEqual({ columns: ["MO", "Note"], rows: [["101 A", ""], ["102", ""]] });
  });
});

describe("tableCsv / parseCsv", () => {
  it("round-trips commas, quotes, line breaks and Arabic", () => {
    const t = { columns: ["MO", "Note, long", "عميل"], rows: [["007", 'He said "go"', "شركة\nالنور"], ["1,234", " padded ", ""]] };
    const csv = tableCsv(t);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv)).toEqual([t.columns, ...t.rows]);
  });

  it("reads a file with no final line break, and LF-only lines", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("tableFileName", () => {
  it("is a short slug of the table's name", () => {
    expect(tableFileName("Late orders — October!")).toBe("late-orders-october.csv");
    expect(tableFileName("الطلبات المتأخرة")).toBe("الطلبات-المتأخرة.csv");
    expect(tableFileName("—")).toBe("table.csv");
    expect(tableFileName("x".repeat(100))).toBe(`${"x".repeat(60)}.csv`);
  });
});

describe("tableExportQuestion", () => {
  const table = { columns: ["MO", "BOM", "Qty"], rows: [["1", "B", "2"], ["2", "C", "3"]] };

  it("names the table, the file and every column, and asks for the columns first", () => {
    const q = tableExportQuestion({ title: "Open orders", page: "Plan Tracker", fileId: 12, fileName: "open-orders.csv", table });
    expect(q).toContain(`"Open orders" on the Plan Tracker screen — 2 rows × 3 columns`);
    expect(q).toContain(`file #12 "open-orders.csv"`);
    expect(q).toContain("ask me which columns");
    expect(q).toContain("make_excel");
    expect(q).toMatch(/1\. MO\n2\. BOM\n3\. Qty$/);
  });

  it("counts one row and one column as such", () => {
    const q = tableExportQuestion({ title: "T", fileId: 1, fileName: "t.csv", table: { columns: ["MO"], rows: [["1"]] } });
    expect(q).toContain("1 row × 1 column,");
  });

  it("stays under the chat's limit with a very wide table", () => {
    const wide = { columns: Array.from({ length: 400 }, (_, i) => `A long column name number ${i}`), rows: [] };
    const q = tableExportQuestion({ title: "T", fileId: 1, fileName: "t.csv", table: wide });
    expect(q.length).toBeLessThanOrEqual(AI_MAX_QUESTION);
    expect(q).toMatch(/… and \d+ more \(in the file\)$/);
  });
});

describe("tableSheetRows", () => {
  it("makes plain figures numbers, but never a code or a figure with a leading zero", () => {
    const r = tableSheetRows([
      ["MO", "BOM", "Qty", "Weight kg", "Ref", "Status", "Item"],
      ["12345", "00123", "1,234", "12.5", "007", "Late", "100234567890123456"],
    ]);
    expect(r).toEqual({
      columns: ["MO", "BOM", "Qty", "Weight kg", "Ref", "Status", "Item"],
      rows: [{ MO: "12345", BOM: "00123", Qty: 1234, "Weight kg": 12.5, Ref: "007", Status: "Late", Item: "100234567890123456" }],
    });
  });

  it("refuses a file with no header", () => {
    expect(tableSheetRows([])).toEqual({ error: expect.stringContaining("header") });
    expect(tableSheetRows([["", ""], ["1", "2"]])).toEqual({ error: expect.stringContaining("header") });
  });
});
