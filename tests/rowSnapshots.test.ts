import { beforeEach, describe, expect, it, vi } from "vitest";

// Putting rows back exactly as a snapshot of them (lib/server/rowSnapshots.ts)
// — the undo of the assistant's changes to the ODOO log, MATERIAL, the
// physical stock, the shift roster, the standard times and an account's
// access: every column, the stamps included, a deleted row under its own id,
// a row that was not there removed again, and the permission of the table's
// own screen checked first.

const h = vi.hoisted(() => {
  const tx = {
    odooEntry: { upsert: vi.fn() },
    odooNote: { deleteMany: vi.fn(), upsert: vi.fn() },
    materialUsage: { upsert: vi.fn() },
    physicalStock: { upsert: vi.fn() },
    shiftEntry: { deleteMany: vi.fn(), upsert: vi.fn() },
    deptDayHours: { deleteMany: vi.fn(), upsert: vi.fn() },
    stdTime: { deleteMany: vi.fn(), upsert: vi.fn() },
    stageCapacity: { deleteMany: vi.fn(), upsert: vi.fn() },
    stdFgMap: { deleteMany: vi.fn(), upsert: vi.fn() },
    lvStdTime: { deleteMany: vi.fn(), upsert: vi.fn() },
    machineItemTime: { deleteMany: vi.fn(), upsert: vi.fn() },
    user: { update: vi.fn() },
    aiAccess: { deleteMany: vi.fn(), upsert: vi.fn() },
    session: { deleteMany: vi.fn() },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)), odooEntry: { findMany: vi.fn() }, user: { findUnique: vi.fn() } },
    requirePerm: vi.fn(),
    requireAdmin: vi.fn(),
    requireOwner: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm, requireAdmin: h.requireAdmin, requireOwner: h.requireOwner }));

import {
  readOdooRows, restoreMachineTimes, restoreOdooRows, restorePhysicalRows, restoreShiftState, restoreStdState, restoreUserAccess, type OdooRowSnapshot,
} from "@/lib/server/rowSnapshots";

const row: OdooRowSnapshot = {
  id: 12, line: "LV", date: "2026-10-11T00:00:00.000Z", soi: "SOI1", fgCode: "FG", product: "Panel", odooMo: "SF01/MO/1", qty: 2, status: "Done",
  doneAt: "2026-10-11T09:30:00.000Z", recordedBy: "Clerk", source: "painting", ledgerId: 40, fgGuessed: true, createdAt: "2026-10-11T08:00:00.000Z",
  notes: [{ id: 3, text: "waiting on QC", recordedBy: "Omar", at: "2026-10-11T08:10:00.000Z" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: { name: "Sara (AI)" } });
  h.requireAdmin.mockResolvedValue({ user: { name: "Sara (AI)" } });
  h.requireOwner.mockResolvedValue({ user: { name: "Mohamed (AI)" } });
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

describe("a day on the shift roster", () => {
  const state = {
    rows: [{ dept: "Welding", workerId: 1, present: false, shift: "S9", overtimeH: 0, machineId: null, note: "sick", recordedBy: "Omar" }],
    dayHours: [{ dept: "Welding", hours: 0, people: 0, hoursEach: null, source: "roster", recordedBy: null }],
  };

  it("goes back exactly: the rows it had and no others, its man-hours as they read", async () => {
    expect(await restoreShiftState("2026-10-11", ["Welding", "Cut"], state)).toEqual({ ok: true });
    expect(h.requirePerm.mock.calls.map((c) => c[0])).toEqual(["shifts.welding", "shifts.cut"]);
    const day = new Date("2026-10-11T00:00:00.000Z");
    expect(h.tx.shiftEntry.deleteMany).toHaveBeenCalledWith({ where: { date: day, dept: "Welding", workerId: { notIn: [1] } } });
    expect(h.tx.shiftEntry.deleteMany).toHaveBeenCalledWith({ where: { date: day, dept: "Cut", workerId: { notIn: [] } } });
    expect(h.tx.shiftEntry.upsert.mock.calls[0][0]).toMatchObject({ where: { date_dept_workerId: { date: day, dept: "Welding", workerId: 1 } }, update: { present: false, note: "sick", recordedBy: "Omar" } });
    expect(h.tx.deptDayHours.upsert.mock.calls[0][0]).toMatchObject({ where: { date_dept: { date: day, dept: "Welding" } }, update: { hours: 0, people: 0, source: "roster" } });
    // the department that had no day gets none
    expect(h.tx.deptDayHours.deleteMany).toHaveBeenCalledWith({ where: { date: day, dept: "Cut" } });
  });

  it("needs every department's own shift-log permission", async () => {
    h.requirePerm.mockResolvedValueOnce({ user: {} }).mockResolvedValueOnce({ error: "no" });
    expect(await restoreShiftState("2026-10-11", ["Welding", "Cut"], state)).toEqual({ ok: false, error: "no" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("the standard times and a machine's times", () => {
  it("go back exactly — a row that was not there is removed — and are an admin's", async () => {
    h.requireAdmin.mockResolvedValueOnce({ error: "admin only" });
    const s = {
      tiers: [{ kva: 100, row: { cutMh: 5, weldMh: 10, shbMh: 1, paintMh: 2 } }, { kva: 1250, row: null }],
      capacity: [{ dept: "Welding", mhPerDay: null }],
      fgMap: [{ fg: "FG1", kva: 100 }],
      lv: [{ fg: "FG-SUSA-1", row: { description: null, kind: "USS", cutH: 1, bendH: 1, weldH: 1, shbH: 0, paintH: 1, totalH: 9 } }],
    };
    expect(await restoreStdState(s)).toEqual({ ok: false, error: "admin only" });
    expect(await restoreStdState(s)).toEqual({ ok: true });
    expect(h.tx.stdTime.upsert.mock.calls[0][0]).toEqual({ where: { kva: 100 }, create: { kva: 100, cutMh: 5, weldMh: 10, shbMh: 1, paintMh: 2 }, update: { cutMh: 5, weldMh: 10, shbMh: 1, paintMh: 2 } });
    expect(h.tx.stdTime.deleteMany).toHaveBeenCalledWith({ where: { kva: 1250 } });
    expect(h.tx.stageCapacity.deleteMany).toHaveBeenCalledWith({ where: { dept: "Welding" } });
    expect(h.tx.lvStdTime.upsert.mock.calls[0][0].update).toMatchObject({ totalH: 9 });
  });

  it("a machine's times come back with who set them, an unset one cleared", async () => {
    expect(await restoreMachineTimes([{ machineId: 4, item: "CF", hoursPerPc: 0.5, setBy: "Ali" }, { machineId: 4, item: "TN", hoursPerPc: null, setBy: null }])).toEqual({ ok: true });
    expect(h.requirePerm).toHaveBeenCalledWith("machines.manage");
    expect(h.tx.machineItemTime.upsert.mock.calls[0][0]).toMatchObject({ where: { machineId_item: { machineId: 4, item: "CF" } }, update: { hoursPerPc: 0.5, setBy: "Ali" } });
    expect(h.tx.machineItemTime.deleteMany).toHaveBeenCalledWith({ where: { machineId: 4, item: "TN" } });
  });
});

describe("an account's access", () => {
  const snap = { id: 7, isAdmin: false, perms: "welding.edit", hiddenTabs: "", active: false, ai: null };

  it("goes back exactly — the assistant taken away again, signed out when put back to inactive — and is the owner's alone", async () => {
    h.requireOwner.mockResolvedValueOnce({ error: "Only the owner manages users and permissions." });
    expect(await restoreUserAccess(snap)).toMatchObject({ ok: false });
    h.prisma.user.findUnique.mockResolvedValue({ isOwner: false, isAdmin: true });
    expect(await restoreUserAccess(snap)).toEqual({ ok: true });
    expect(h.tx.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { isAdmin: false, perms: "welding.edit", hiddenTabs: "", active: false } });
    expect(h.tx.aiAccess.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(h.tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
  });

  it("never moves the owner's own standing", async () => {
    h.prisma.user.findUnique.mockResolvedValue({ isOwner: true, isAdmin: true });
    expect(await restoreUserAccess({ ...snap, isAdmin: true })).toEqual({ ok: false, error: "The owner's own standing cannot be changed." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
