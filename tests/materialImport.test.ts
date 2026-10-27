import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The transformers' material sheet import against a stubbed database. The
// sheet is the MATERIAL tab's only source — nothing is typed in the tab — so
// what the sheet says replaces what a line held, a rate typed by hand before
// included (a blank note aside), and mirroring the file drops the sheet's rows
// it no longer carries.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      materialUsage: { findMany: fn(), createMany: fn(), update: fn(), deleteMany: fn() },
      $transaction: fn(),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "TR" }));

import { importNestingTracker } from "@/lib/server/material";

function sheet(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Nesting Tracker");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

const HEADER = ["MO", "BOM Ref", "Quantity of Units", "Part Code", "Part Name", "Material Type", "Thickness", "Sheet Size", "No. of Sheets in BOM for one Unit", "No. of Sheets in Actual Nesting for one Unit", "No. of Sheets in Actual Nesting for Job", "Notes"];
const MO = "SF01/MO/20941";
const file = sheet([HEADER, [MO, "B1", 4, "FB-022", "TANK", "Steel", 3, "1220*2440", 0.5, 0.25, 1, null]]);

// the line as the tab holds it: a rate someone typed by hand, and a note
const held = (over: Record<string, unknown> = {}) => ({
  id: 7, month: "", line: "TR", bom: "B1", mo: MO, partCode: "FB-022", partName: "TANK", materialCode: "", material: "Steel", thicknessMm: 3, sheetSize: "1220*2440",
  units: 4, sheetsPerUnit: 0.5, actualPerUnit: 0.4, actualPerUnitManual: true, sheetsUsed: 1, producedQty: null, sortOrder: 2,
  soi: "", mtr: "", weightKg: null, utilization: null, note: "typed note", recordedBy: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.materialUsage.createMany.mockResolvedValue({ count: 0 });
  h.prisma.materialUsage.update.mockImplementation((a: unknown) => a);
  h.prisma.materialUsage.deleteMany.mockResolvedValue({ count: 1 });
  h.prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe("the material sheet import", () => {
  it("replaces a rate typed in the tab with the sheet's, and keeps a note the sheet leaves blank", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([held()]);
    const r = await importNestingTracker(file, "Sara");
    expect(r).toMatchObject({ ok: true, added: 0, updated: 1, unchanged: 0 });
    expect(h.prisma.materialUsage.update).toHaveBeenCalledWith({ where: { id: 7 }, data: expect.objectContaining({ actualPerUnit: 0.25, actualPerUnitManual: false }) });
    expect(h.prisma.materialUsage.update.mock.calls[0][0].data).not.toHaveProperty("note");
  });

  it("leaves a line alone once it holds exactly what the sheet says", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([held({ actualPerUnit: 0.25, actualPerUnitManual: false })]);
    const r = await importNestingTracker(file, "Sara");
    expect(r).toMatchObject({ ok: true, updated: 0, unchanged: 1 });
    expect(h.prisma.materialUsage.update).not.toHaveBeenCalled();
  });

  it("mirroring the file asks only for the sheet's rows — a line typed in by hand before stays", async () => {
    h.prisma.materialUsage.findMany.mockResolvedValue([held({ actualPerUnit: 0.25, actualPerUnitManual: false })]);
    await importNestingTracker(file, "Sara", false, true);
    expect(h.prisma.materialUsage.findMany).toHaveBeenLastCalledWith({ where: { line: "TR", month: "", sortOrder: { gt: 0, lt: 1_000_000 } }, select: { id: true } });
  });
});
