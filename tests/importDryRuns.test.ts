import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The importers' dry runs — what the assistant's import card shows: the same
// reading of the file and the same counts as the import itself, and nothing
// written. Against a stubbed database.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = { physicalStock: { create: fn(), update: fn() } };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)),
      physicalStock: { findMany: fn(), deleteMany: fn() },
      planOrder: { count: fn(), deleteMany: fn(), createMany: fn() },
      planSchedule: { deleteMany: fn(), createMany: fn() },
      plan: { upsert: fn(), findMany: fn() },
      handoverEntry: { findMany: fn(), createMany: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/handover", () => ({ getKnownBoms: async () => ["T-1000"] }));

import { importPhysicalStock } from "@/lib/server/physicalStock";
import { importHandoverFile } from "@/lib/server/importHandover";

function sheet(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the stock sheet's dry run", () => {
  const file = sheet([["Product Code", "Name", "UOM", "Physical", "Odoo"], ["A1", "Sheet 2mm", "PC", 10, 12], ["B2", "Bolt", "PC", 5, 5], ["C3", "Paint", "L", 1, 1]]);

  beforeEach(() => {
    h.prisma.physicalStock.findMany.mockResolvedValue([
      { id: 1, code: "A1", name: "Sheet 2mm", uom: "PC", physical: 9, odoo: 12, sortOrder: 1 },
      { id: 2, code: "B2", name: "Bolt", uom: "PC", physical: 5, odoo: 5, sortOrder: 2 },
      { id: 4, code: "Z9", name: "Old", uom: "PC", physical: 0, odoo: 0, sortOrder: 4 },
    ]);
  });

  it("counts what the import would do and writes nothing", async () => {
    expect(await importPhysicalStock(file, "Sara", true, true)).toEqual({ ok: true, preview: true, added: 1, updated: 1, unchanged: 1, missing: 1, removed: 0, issues: [] });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.physicalStock.deleteMany).not.toHaveBeenCalled();
  });

  it("the import itself counts the same, and writes it", async () => {
    h.prisma.physicalStock.deleteMany.mockResolvedValue({ count: 1 });
    expect(await importPhysicalStock(file, "Sara", true)).toEqual({ ok: true, added: 1, updated: 1, unchanged: 1, missing: 1, removed: 1, issues: [] });
    expect(h.tx.physicalStock.create).toHaveBeenCalledWith({ data: { code: "C3", name: "Paint", uom: "L", physical: 1, odoo: 1, sortOrder: 3, updatedBy: "Sara" } });
    expect(h.tx.physicalStock.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { name: "Sheet 2mm", uom: "PC", physical: 10, odoo: 12, sortOrder: 1, updatedBy: "Sara" } });
    expect(h.prisma.physicalStock.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [4] } } });
  });
});

describe("the Daily-log sheet's dry run", () => {
  it("counts the new rows and the ones already there, and writes nothing", async () => {
    h.prisma.plan.findMany.mockResolvedValue([{ planNo: 41 }]);
    h.prisma.handoverEntry.findMany.mockResolvedValue([{ date: new Date("2026-10-11T00:00:00Z"), dept: "Welding", bom: "T-1000", mo: null, item: "TN", qty: 4, planNo: 41 }]);
    const file = sheet([
      ["DATE", "DEPT", "BOM", "ITEM", "QTY", "WEEK"],
      ["2026-10-11", "Welding", "T-1000", "TN", 4, 41],
      ["2026-10-12", "Welding", "T-1000", "TN", 3, 41],
    ]);
    const r = await importHandoverFile(file, true);
    expect(r).toMatchObject({ ok: true, preview: true, added: 1, skippedExisting: 1, invalid: 0 });
    expect(h.prisma.handoverEntry.createMany).not.toHaveBeenCalled();
  });
});
