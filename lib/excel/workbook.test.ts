import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { argb, BAND_FILL, MARK_COLORS, SHEET_THEMES, type SheetStyleInput } from "@/lib/domain/sheetStyle";
import { workbookBytes, type WorkbookResult, type WorkbookSheet } from "./workbook";

vi.mock("server-only", () => ({}));
const { streamedWorkbookBytes } = await import("@/lib/server/excel");

const rows = [
  { MO: "A", Qty: 12000, Rate: 0.125, Note: "=1+1" },
  { MO: "B", Qty: 3, Rate: 0.5, Note: "" },
  { MO: "Total", Qty: 12003, Rate: "", Note: "" },
];

type Write = (sheets: readonly WorkbookSheet[], style?: SheetStyleInput) => Promise<WorkbookResult>;
type Rule = { type: string; formulae?: string[]; style?: { fill?: { fgColor?: { argb: string } } } };

async function written(write: Write, sheets: readonly WorkbookSheet[], style?: SheetStyleInput) {
  const r = await write(sheets, style);
  if (!r.ok) throw new Error(r.error);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(r.data) as unknown as ExcelJS.Buffer);
  return { ...r, wb };
}

const rulesOf = (ws: ExcelJS.Worksheet) => (ws as unknown as { conditionalFormattings: { ref: string; rules: Rule[] }[] }).conditionalFormattings;

// the browser's writer and the server's streamed one write the same file
describe.each([
  ["in memory", workbookBytes],
  ["streamed", streamedWorkbookBytes],
] as [string, Write][])("the workbook, written %s", (_, write) => {
  it("is in the house style: a coloured, frozen, filtered header, the values as they are, a bold Total row, banded rows, print a page wide", async () => {
    const { wb, names } = await written(write, [{ name: "Plan", rows }]);
    expect(names).toEqual(["Plan"]);
    const ws = wb.getWorksheet("Plan")!;
    expect(ws.getRow(1).values).toEqual([undefined, "MO", "Qty", "Rate", "Note"]);
    expect(ws.getCell("A1").fill).toMatchObject({ fgColor: { argb: argb(SHEET_THEMES.green.header) } });
    expect(ws.getCell("A1").font).toMatchObject({ bold: true });
    // a column of numbers is headed on the right, a text one on the left
    expect([ws.getCell("B1").alignment?.horizontal, ws.getCell("A1").alignment?.horizontal]).toEqual(["right", "left"]);
    // a text that looks like a formula stays a text
    expect(ws.getCell("D2").value).toBe("=1+1");
    expect(ws.getCell("D2").type).toBe(ExcelJS.ValueType.String);
    expect(ws.getCell("B2").value).toBe(12000);
    expect(ws.getCell("B2").numFmt).toBe("#,##0");
    expect(ws.getCell("C2").numFmt).toBe("0.000");
    expect(ws.getCell("A4").font).toMatchObject({ bold: true });
    expect(ws.getCell("B4").fill).toMatchObject({ fgColor: { argb: argb(SHEET_THEMES.green.light) } });
    // the filter and the bands stop above the Total row, which sorting must not move
    expect(ws.autoFilter).toBe("A1:D3");
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1, xSplit: 0 });
    const cf = rulesOf(ws);
    expect(cf).toEqual([{ ref: "A2:D3", rules: [expect.objectContaining({ type: "expression", formulae: ["MOD(ROW(),2)=1"] })] }]);
    expect(cf[0].rules[0].style?.fill?.fgColor?.argb).toBe(argb(BAND_FILL));
    expect(ws.pageSetup).toMatchObject({ fitToPage: true, fitToWidth: 1, fitToHeight: 0 });
  });

  it("puts a title and a subtitle over the table, and the asked-for rules on its rows alone", async () => {
    const { wb, data } = await written(write, [{ name: "3 mm", rows }], {
      title: "HR nested", subtitle: "October", theme: "blue", banded: false,
      highlight: [{ column: "Qty", when: "gt", value: 100, color: "red", row: true }],
      colorScale: [{ column: "Rate", better: "higher" }], dataBars: ["Qty"], bold: ["MO"], freezeColumns: 1,
    });
    const ws = wb.worksheets[0];
    expect([ws.getCell("A1").value, ws.getCell("A2").value, ws.getCell("A3").value]).toEqual(["HR nested", "October", null]);
    expect(ws.getCell("A1").isMerged && ws.getCell("D1").isMerged).toBe(true);
    expect(ws.getRow(4).values).toEqual([undefined, "MO", "Qty", "Rate", "Note"]);
    expect(ws.getCell("A4").fill).toMatchObject({ fgColor: { argb: argb(SHEET_THEMES.blue.header) } });
    expect(ws.views[0]).toMatchObject({ ySplit: 4, xSplit: 1 });
    expect(ws.autoFilter).toBe("A4:D6");
    expect(ws.getCell("A5").font).toMatchObject({ bold: true });
    const cf = rulesOf(ws);
    expect(cf.map((c) => [c.ref, c.rules[0].type])).toEqual([["A5:D6", "expression"], ["C5:C6", "colorScale"], ["B5:B6", "dataBar"]]);
    expect(cf[0].rules[0].formulae).toEqual(["AND(ISNUMBER($B5),$B5>100)"]);
    expect(cf[0].rules[0].style?.fill?.fgColor?.argb).toBe(argb(MARK_COLORS.red.fill));
    // the reader the app prints with sees the title, the table's own row repeated on each page
    const book = XLSX.read(data, { type: "array" });
    expect(XLSX.utils.sheet_to_json(book.Sheets["3 mm"], { header: 1 }).slice(0, 4)).toEqual([["HR nested"], ["October"], [], ["MO", "Qty", "Rate", "Note"]]);
    expect(book.Workbook?.Names?.find((d) => d.Name === "_xlnm.Print_Titles")?.Ref).toMatch(/\$4:\$4$/);
  });

  it("names the sheets as Excel takes them, and writes an empty file a sheet", async () => {
    const { wb, names } = await written(write, [{ name: "a/b", rows: [] }, { name: "a b", rows: [{ x: 1 }] }]);
    expect(names).toEqual(["a b", "a b 2"]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["a b", "a b 2"]);
  });

  it("colours the Total row across every column, its empty cells too", async () => {
    const { wb } = await written(write, [{ name: "S", rows: [{ MO: "A", Qty: 1, Note: "x" }, { MO: "Total", Qty: 1, Note: "" }] }]);
    expect(wb.worksheets[0].getCell("C3").fill).toMatchObject({ fgColor: { argb: argb(SHEET_THEMES.green.light) } });
  });

  it("checks the style against every sheet before anything is written", async () => {
    expect(await write([{ name: "a", rows }, { name: "b", rows: [{ Other: 1 }] }], { bold: ["MO"] })).toEqual({ ok: false, error: expect.stringContaining('no column "MO" — its columns are: Other') });
  });
});

describe("an Export button's rows", () => {
  it("are written whatever they hold — empty, yes/no, a date — and a last row of them is no Total row", async () => {
    const r = await workbookBytes([{ name: "a", rows: [{ A: 1, B: "x" }, { A: 2, B: null, C: true, D: new Date(Date.UTC(2026, 9, 27)) }] }]);
    expect(r.ok).toBe(true);
  });
});
