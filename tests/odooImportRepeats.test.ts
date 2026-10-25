import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The ODOO close-out sheet's import (lib/server/odoo.ts importOdooSheet) when
// the file carries the same MO and day twice: the second line is judged
// against what the import has just written (or, in a dry run, would have),
// never against the row as it was read — so the last line of the file is what
// is kept, and the preview's counts are the import's. Against a stubbed
// database.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { odooEntry: { findMany: fn(), update: fn(), create: fn() } },
    getActiveLine: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: h.getActiveLine }));

import { importOdooSheet } from "@/lib/server/odoo";

const HEADER = ["Date", "SOI#", "FG-CODE", "Product", "MO#", "QTY", "Status"];
const DAY = new Date("2026-10-11T00:00:00.000Z");

function sheet(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), "Close-out");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
const line = (qty: number) => ["2026-10-11", "", "FG-1", "Tank", "SF01/MO/1", qty, "MO to be close"];

beforeEach(() => {
  vi.clearAllMocks();
  h.getActiveLine.mockResolvedValue("TR");
  h.prisma.odooEntry.update.mockImplementation(async ({ where, data }: { where: { id: number }; data: object }) => ({ id: where.id, ...data }));
  h.prisma.odooEntry.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 99, ...data }));
});

describe("a stored row and two lines for its MO and day — qty 7, then 5", () => {
  const file = sheet([line(7), line(5)]);
  beforeEach(() => {
    h.prisma.odooEntry.findMany.mockResolvedValue([
      { id: 7, line: "TR", date: DAY, soi: null, fgCode: "FG-1", product: "Tank", odooMo: "SF01/MO/1", qty: 5, status: "MO to be close" },
    ]);
  });

  it("the import writes 7, then puts it back to 5 — the file's last line is what is kept", async () => {
    expect(await importOdooSheet(file, null, "Clerk")).toEqual({ ok: true, added: 0, updated: 2, unchanged: 0, issues: [], preview: false, sheet: "Close-out" });
    expect(h.prisma.odooEntry.findMany).toHaveBeenCalledWith({ where: { date: { in: [DAY] }, line: "TR" }, orderBy: { id: "asc" } });
    expect(h.prisma.odooEntry.update).toHaveBeenCalledTimes(2);
    expect(h.prisma.odooEntry.update).toHaveBeenNthCalledWith(1, { where: { id: 7 }, data: { soi: null, fgCode: "FG-1", product: "Tank", qty: 7, recordedBy: "Clerk" } });
    expect(h.prisma.odooEntry.update).toHaveBeenNthCalledWith(2, { where: { id: 7 }, data: { soi: null, fgCode: "FG-1", product: "Tank", qty: 5, recordedBy: "Clerk" } });
    expect(h.prisma.odooEntry.create).not.toHaveBeenCalled();
  });

  it("the preview reports the import's own counts and writes nothing", async () => {
    expect(await importOdooSheet(file, null, "Clerk", true)).toEqual({ ok: true, added: 0, updated: 2, unchanged: 0, issues: [], preview: true, sheet: "Close-out" });
    expect(h.prisma.odooEntry.update).not.toHaveBeenCalled();
    expect(h.prisma.odooEntry.create).not.toHaveBeenCalled();
  });
});

describe("two identical new lines for one MO and day", () => {
  const file = sheet([line(4), line(4)]);
  beforeEach(() => {
    h.prisma.odooEntry.findMany.mockResolvedValue([]);
  });

  it("the import adds one row and counts the second line as unchanged", async () => {
    expect(await importOdooSheet(file, null, "Clerk")).toEqual({ ok: true, added: 1, updated: 0, unchanged: 1, issues: [], preview: false, sheet: "Close-out" });
    expect(h.prisma.odooEntry.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.odooEntry.create).toHaveBeenCalledWith({
      data: { line: "TR", date: DAY, odooMo: "SF01/MO/1", status: "MO to be close", doneAt: null, source: "import", soi: null, fgCode: "FG-1", product: "Tank", qty: 4, recordedBy: "Clerk" },
    });
    expect(h.prisma.odooEntry.update).not.toHaveBeenCalled();
  });

  it("the preview says the same — one added, one unchanged — never two added", async () => {
    expect(await importOdooSheet(file, null, "Clerk", true)).toEqual({ ok: true, added: 1, updated: 0, unchanged: 1, issues: [], preview: true, sheet: "Close-out" });
    expect(h.prisma.odooEntry.create).not.toHaveBeenCalled();
  });
});
