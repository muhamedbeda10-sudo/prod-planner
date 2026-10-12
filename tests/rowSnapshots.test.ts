import { beforeEach, describe, expect, it, vi } from "vitest";

// Putting rows back exactly as a snapshot of them (lib/server/rowSnapshots.ts)
// — the undo of the assistant's changes to the ODOO log, MATERIAL and the
// physical stock: every column, the stamps included, a deleted row under its
// own id, and the permission of the table's own screen checked first.

const h = vi.hoisted(() => {
  const tx = {
    odooEntry: { upsert: vi.fn() },
    odooNote: { deleteMany: vi.fn(), upsert: vi.fn() },
    materialUsage: { upsert: vi.fn() },
    physicalStock: { upsert: vi.fn() },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)), odooEntry: { findMany: vi.fn() } },
    requirePerm: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm }));

import { readOdooRows, restoreOdooRows, restorePhysicalRows, type OdooRowSnapshot } from "@/lib/server/rowSnapshots";

const row: OdooRowSnapshot = {
  id: 12, line: "LV", date: "2026-10-11T00:00:00.000Z", soi: "SOI1", fgCode: "FG", product: "Panel", odooMo: "SF01/MO/1", qty: 2, status: "Done",
  doneAt: "2026-10-11T09:30:00.000Z", recordedBy: "Clerk", source: "painting", ledgerId: 40, fgGuessed: true, createdAt: "2026-10-11T08:00:00.000Z",
  notes: [{ id: 3, text: "waiting on QC", recordedBy: "Omar", at: "2026-10-11T08:10:00.000Z" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: { name: "Sara (AI)" } });
});

describe("ODOO rows", () => {
  it("are read with every column and their notes, as plain JSON", async () => {
    h.prisma.odooEntry.findMany.mockResolvedValue([{
      ...row, date: new Date(row.date), doneAt: new Date(row.doneAt!), createdAt: new Date(row.createdAt), updatedAt: new Date(),
      notes: [{ ...row.notes[0], entryId: 12, at: new Date(row.notes[0].at) }],
    }]);
    expect(await readOdooRows([12])).toEqual([row]);
    expect(await readOdooRows([])).toEqual([]);
  });

  it("go back exactly — the close stamp, the ledger link, the notes — under the line's own permission", async () => {
    expect(await restoreOdooRows([row])).toEqual({ ok: true });
    expect(h.requirePerm).toHaveBeenCalledWith("lv.odoo");
    const up = h.tx.odooEntry.upsert.mock.calls[0][0];
    expect(up.where).toEqual({ id: 12 });
    expect(up.update).toMatchObject({ status: "Done", doneAt: new Date(row.doneAt!), ledgerId: 40, fgGuessed: true, recordedBy: "Clerk", source: "painting" });
    expect(up.create).toMatchObject({ id: 12, createdAt: new Date(row.createdAt) });
    expect(h.tx.odooNote.deleteMany).toHaveBeenCalledWith({ where: { entryId: 12, id: { notIn: [3] } } });
    expect(h.tx.odooNote.upsert.mock.calls[0][0]).toMatchObject({ where: { id: 3 }, create: { id: 3, entryId: 12, at: new Date(row.notes[0].at) } });
  });

  it("are not touched without the permission, and a refusal of the database comes back as a message", async () => {
    h.requirePerm.mockResolvedValueOnce({ error: "No permission." });
    expect(await restoreOdooRows([row])).toEqual({ ok: false, error: "No permission." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    h.prisma.$transaction.mockRejectedValueOnce(new Error("Unique constraint failed on ledgerId"));
    expect(await restoreOdooRows([row])).toEqual({ ok: false, error: "The rows could not be put back: Unique constraint failed on ledgerId" });
  });
});

describe("physical stock items", () => {
  it("go back under stock.edit, with their own id and first-recorded time", async () => {
    const item = { id: 4, code: "P-1", name: "Bolt", uom: "PC", physical: 10, odoo: 12, sortOrder: 3, note: null, updatedBy: "Store", createdAt: "2026-09-01T00:00:00.000Z" };
    expect(await restorePhysicalRows([item])).toEqual({ ok: true });
    expect(h.requirePerm).toHaveBeenCalledWith("stock.edit");
    expect(h.tx.physicalStock.upsert).toHaveBeenCalledWith({
      where: { id: 4 },
      create: { id: 4, code: "P-1", name: "Bolt", uom: "PC", physical: 10, odoo: 12, sortOrder: 3, note: null, updatedBy: "Store", createdAt: new Date(item.createdAt) },
      update: { code: "P-1", name: "Bolt", uom: "PC", physical: 10, odoo: 12, sortOrder: 3, note: null, updatedBy: "Store" },
    });
  });
});
