import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// ---- mock harness for the CONSUMABLES tab's server actions -----------------
// The I/O boundary (Prisma, the Next cache, the auth guards) is stubbed; the
// assertions are about who may write, what gets written, and that a saved row
// changes only through an admin, with the old row kept.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      consumableIssue: { create: fn(), findUnique: fn(), findMany: fn(), updateMany: fn() },
      consumableIssueRevision: { create: fn() },
      worker: { findUnique: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    requirePerm: vi.fn(),
    requireAdmin: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm, requireAdmin: h.requireAdmin }));

import { createConsumableIssue, updateConsumableIssue, deleteConsumableIssue } from "@/app/consumables/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const storekeeper = { id: 5, name: "Store Keeper", isAdmin: false };
const admin = { id: 1, name: "Admin", isAdmin: true };
const NO_PERM = { error: "You do not have permission for this action — ask the admin." };

const sayed = { id: 7, empId: "1203", name: "Sayed", active: true, depts: "WeldingTX" };
const valid = { item: "Welding wire 1.2mm", qty: "2", department: "WeldingTX", workerId: "7", notes: "" };

const version = new Date("2026-09-28T08:00:00.000Z");
const saved = (over: Record<string, unknown> = {}) => ({
  id: 42,
  item: "Welding wire 1.2mm",
  qty: new Prisma.Decimal(2),
  department: "WeldingTX",
  workerId: 7,
  notes: null,
  deletedAt: null,
  updatedAt: version,
  worker: { empId: "1203", name: "Sayed" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: storekeeper });
  h.requireAdmin.mockResolvedValue({ user: admin });
  h.prisma.worker.findUnique.mockResolvedValue(sayed);
  // the departments typed on earlier rows
  h.prisma.consumableIssue.findMany.mockResolvedValue([{ department: "Maintenance" }]);
  h.prisma.consumableIssue.findUnique.mockResolvedValue(saved());
  h.prisma.consumableIssue.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.$transaction.mockImplementation(async (cb: (tx: typeof h.prisma) => unknown) => cb(h.prisma));
});

describe("createConsumableIssue", () => {
  it("needs the consumables permission", async () => {
    h.requirePerm.mockResolvedValue(NO_PERM);
    const res = await createConsumableIssue(form(valid));
    expect(h.requirePerm).toHaveBeenCalledWith("consumables.edit");
    expect(res).toEqual({ ok: false, error: NO_PERM.error });
    expect(h.prisma.consumableIssue.create).not.toHaveBeenCalled();
  });

  it("records the hand-out with the recorder, and never a typed time", async () => {
    const res = await createConsumableIssue(form({ ...valid, issuedAt: "2020-01-01T00:00:00Z" }));
    expect(res).toEqual({ ok: true, department: "WeldingTX" });
    const data = h.prisma.consumableIssue.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ item: "Welding wire 1.2mm", department: "WeldingTX", workerId: 7, notes: null, recordedById: 5, recordedBy: "Store Keeper" });
    expect(data.qty.toString()).toBe("2");
    expect(data).not.toHaveProperty("issuedAt");
    expect(h.revalidatePath).toHaveBeenCalledWith("/consumables");
  });

  it("files a typed department under its first spelling", async () => {
    const res = await createConsumableIssue(form({ ...valid, department: "__new__", departmentNew: "maintenance" }));
    expect(res).toEqual({ ok: true, department: "Maintenance" });
    expect(h.prisma.consumableIssue.create.mock.calls[0][0].data.department).toBe("Maintenance");
  });

  it("refuses an invalid form before touching the database", async () => {
    const res = await createConsumableIssue(form({ ...valid, qty: "0" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/more than zero/);
    expect(h.prisma.consumableIssue.create).not.toHaveBeenCalled();
  });

  it("refuses a deactivated worker, an unknown one, and one outside the section", async () => {
    h.prisma.worker.findUnique.mockResolvedValueOnce({ ...sayed, active: false });
    expect((await createConsumableIssue(form(valid))).error).toMatch(/deactivated/);
    h.prisma.worker.findUnique.mockResolvedValueOnce(null);
    expect((await createConsumableIssue(form(valid))).error).toMatch(/not on the list/);
    expect((await createConsumableIssue(form({ ...valid, department: "PaintingTX" }))).error).toMatch(/not registered/);
    expect(h.prisma.consumableIssue.create).not.toHaveBeenCalled();
  });

  it("takes any active worker for a typed department", async () => {
    const res = await createConsumableIssue(form({ ...valid, department: "Maintenance" }));
    expect(res.ok).toBe(true);
  });
});

describe("updateConsumableIssue", () => {
  const edit = (over: Record<string, string> = {}) => form({ ...valid, qty: "3", id: "42", version: version.toISOString(), ...over });

  it("is the admin's alone — a recorder cannot change a saved row", async () => {
    h.requireAdmin.mockResolvedValue(NO_PERM);
    const res = await updateConsumableIssue(edit());
    expect(res).toEqual({ ok: false, error: NO_PERM.error });
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.consumableIssueRevision.create).not.toHaveBeenCalled();
  });

  it("saves the change and keeps the row as it was", async () => {
    const res = await updateConsumableIssue(edit({ notes: "two spools" }));
    expect(res).toEqual({ ok: true });
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 42, deletedAt: null, updatedAt: version });
    expect(upd.data).toMatchObject({ item: "Welding wire 1.2mm", notes: "two spools", editedBy: "Admin" });
    expect(upd.data.qty.toString()).toBe("3");
    expect(upd.data).not.toHaveProperty("issuedAt");
    const rev = h.prisma.consumableIssueRevision.create.mock.calls[0][0].data;
    expect(rev).toMatchObject({
      issueId: 42, action: "edit", byId: 1, by: "Admin",
      before: { item: "Welding wire 1.2mm", qty: 2, department: "WeldingTX", workerId: 7, workerEmpId: "1203", workerName: "Sayed", notes: null },
    });
  });

  it("refuses when the row changed since the page was drawn", async () => {
    const res = await updateConsumableIssue(edit({ version: "2026-09-28T07:00:00.000Z" }));
    expect(res.error).toMatch(/Someone changed this row/);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });

  it("loses cleanly to a concurrent edit, writing no revision", async () => {
    h.prisma.consumableIssue.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateConsumableIssue(edit());
    expect(res.error).toMatch(/Someone changed this row/);
    expect(h.prisma.consumableIssueRevision.create).not.toHaveBeenCalled();
  });

  it("refuses a deleted or missing row", async () => {
    h.prisma.consumableIssue.findUnique.mockResolvedValueOnce(saved({ deletedAt: new Date() }));
    expect((await updateConsumableIssue(edit())).error).toMatch(/no longer exists/);
    h.prisma.consumableIssue.findUnique.mockResolvedValueOnce(null);
    expect((await updateConsumableIssue(edit())).error).toMatch(/no longer exists/);
  });

  it("says so when nothing changed, and writes nothing", async () => {
    const res = await updateConsumableIssue(edit({ qty: "2.000" }));
    expect(res.error).toMatch(/Nothing changed/);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });

  it("keeps an old row's since-deactivated worker when only the qty is corrected", async () => {
    h.prisma.worker.findUnique.mockResolvedValue({ ...sayed, active: false, depts: "" });
    expect((await updateConsumableIssue(edit())).ok).toBe(true);
    // …but will not hand the row to a different deactivated worker
    h.prisma.worker.findUnique.mockResolvedValue({ ...sayed, id: 8, active: false });
    expect((await updateConsumableIssue(edit({ workerId: "8" }))).error).toMatch(/deactivated/);
  });
});

describe("deleteConsumableIssue", () => {
  const del = (over: Record<string, string> = {}) => form({ id: "42", version: version.toISOString(), ...over });

  it("is the admin's alone", async () => {
    h.requireAdmin.mockResolvedValue(NO_PERM);
    expect((await deleteConsumableIssue(del())).ok).toBe(false);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });

  it("deletes softly and keeps the row in its history", async () => {
    const res = await deleteConsumableIssue(del());
    expect(res).toEqual({ ok: true });
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 42, deletedAt: null, updatedAt: version });
    expect(upd.data).toMatchObject({ deletedBy: "Admin" });
    expect(upd.data.deletedAt).toBeInstanceOf(Date);
    expect(h.prisma.consumableIssueRevision.create.mock.calls[0][0].data).toMatchObject({ issueId: 42, action: "delete", by: "Admin" });
  });

  it("refuses a stale page or a bad id", async () => {
    expect((await deleteConsumableIssue(del({ version: "2026-01-01T00:00:00.000Z" }))).error).toMatch(/Someone changed/);
    expect((await deleteConsumableIssue(del({ id: "abc" }))).error).toMatch(/Invalid row/);
    expect((await deleteConsumableIssue(del({ version: "" }))).error).toMatch(/Invalid row/);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });
});
