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
      consumableIssueRevision: { create: fn(), findUnique: fn() },
      consumableItem: { findUnique: fn() },
      worker: { findUnique: fn(), findMany: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    requirePerm: vi.fn(),
    requireAdmin: vi.fn(),
    getCurrentUser: vi.fn(),
    checkIssueLimits: vi.fn(),
    limitHints: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/consumableLimits", () => ({ checkIssueLimits: h.checkIssueLimits, limitHints: h.limitHints }));
vi.mock("@/lib/server/auth", () => ({
  requirePerm: h.requirePerm,
  requireAdmin: h.requireAdmin,
  getCurrentUser: h.getCurrentUser,
  hasPerm: (u: { isAdmin: boolean; perms: string }, p: string) => u.isAdmin || u.perms.split(",").includes(p),
}));

import { createConsumableIssue, updateConsumableIssue, deleteConsumableIssue, restoreConsumableRevision } from "@/app/consumables/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const storekeeper = { id: 5, name: "Store Keeper", isAdmin: false, perms: "consumables.edit" };
const colleague = { id: 6, name: "Other Keeper", isAdmin: false, perms: "consumables.edit" };
const viewer = { id: 9, name: "Viewer", isAdmin: false, perms: "" };
const admin = { id: 1, name: "Admin", isAdmin: true, perms: "" };
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
  recordedById: 5,
  updatedAt: version,
  worker: { empId: "1203", name: "Sayed" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: storekeeper });
  h.requireAdmin.mockResolvedValue({ user: admin });
  h.getCurrentUser.mockResolvedValue(storekeeper);
  h.checkIssueLimits.mockResolvedValue([]);
  h.prisma.consumableItem.findUnique.mockResolvedValue({ id: 3, name: "Grinding Disk 115x6x22.23mm", active: true });
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
    // the department's hand-out — no worker is named, whatever an older form sends
    expect(data).toMatchObject({ item: "Welding wire 1.2mm", department: "WeldingTX", workerId: null, recipientScope: "department", notes: null, recordedById: 5, recordedBy: "Store Keeper" });
    expect(data).not.toHaveProperty("recipients");
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

  it("never looks a worker up — the hand-out is the department's", async () => {
    h.prisma.worker.findUnique.mockResolvedValue(null);
    expect((await createConsumableIssue(form({ ...valid, department: "PaintingTX" }))).ok).toBe(true);
    expect(h.prisma.worker.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.worker.findMany).not.toHaveBeenCalled();
  });

  it("takes any active worker for a typed department", async () => {
    const res = await createConsumableIssue(form({ ...valid, department: "Maintenance" }));
    expect(res.ok).toBe(true);
  });
});

describe("updateConsumableIssue", () => {
  const edit = (over: Record<string, string> = {}) => form({ ...valid, qty: "3", id: "42", version: version.toISOString(), ...over });

  it("lets the recorder correct his own row, keeping it before and after", async () => {
    const res = await updateConsumableIssue(edit({ notes: "two spools" }));
    expect(res).toEqual({ ok: true });
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 42, updatedAt: version, deletedAt: null });
    expect(upd.data).toMatchObject({ item: "Welding wire 1.2mm", notes: "two spools", editedBy: "Store Keeper" });
    expect(upd.data.qty.toString()).toBe("3");
    expect(upd.data).not.toHaveProperty("issuedAt");
    const rev = h.prisma.consumableIssueRevision.create.mock.calls[0][0].data;
    expect(rev).toMatchObject({
      issueId: 42, action: "edit", byId: 5, by: "Store Keeper",
      before: { item: "Welding wire 1.2mm", qty: 2, department: "WeldingTX", workerId: 7, workerEmpId: "1203", workerName: "Sayed", notes: null },
      after: { item: "Welding wire 1.2mm", qty: 3, department: "WeldingTX", workerId: 7, workerEmpId: "1203", workerName: "Sayed", notes: "two spools" },
    });
  });

  it("refuses a colleague's row, a viewer, and a logged-out visitor", async () => {
    h.getCurrentUser.mockResolvedValueOnce(colleague);
    expect((await updateConsumableIssue(edit())).error).toMatch(/only correct the hand-outs you recorded/);
    h.getCurrentUser.mockResolvedValueOnce({ ...viewer, id: 5 });
    expect((await updateConsumableIssue(edit())).error).toMatch(/only correct the hand-outs you recorded/);
    h.getCurrentUser.mockResolvedValueOnce(null);
    expect((await updateConsumableIssue(edit())).error).toMatch(/not logged in/);
    // a row whose recorder's account is gone is the admin's
    h.prisma.consumableIssue.findUnique.mockResolvedValueOnce(saved({ recordedById: null }));
    expect((await updateConsumableIssue(edit())).error).toMatch(/only correct/);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });

  it("lets an admin correct anyone's row", async () => {
    h.getCurrentUser.mockResolvedValue(admin);
    expect((await updateConsumableIssue(edit())).ok).toBe(true);
    expect(h.prisma.consumableIssueRevision.create.mock.calls[0][0].data).toMatchObject({ byId: 1, by: "Admin" });
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

  it("corrects an older row's department, leaving the worker it named as it was", async () => {
    expect((await updateConsumableIssue(edit({ department: "PaintingTX" }))).ok).toBe(true);
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    expect(upd.data).toMatchObject({ department: "PaintingTX" });
    expect(upd.data).not.toHaveProperty("workerId");
    const rev = h.prisma.consumableIssueRevision.create.mock.calls[0][0].data;
    expect(rev.after).toMatchObject({ department: "PaintingTX", workerId: 7, workerName: "Sayed" });
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
    expect(upd.where).toEqual({ id: 42, updatedAt: version, deletedAt: null });
    expect(upd.data).toMatchObject({ deletedBy: "Admin" });
    expect(upd.data.deletedAt).toBeInstanceOf(Date);
    const rev = h.prisma.consumableIssueRevision.create.mock.calls[0][0].data;
    expect(rev).toMatchObject({ issueId: 42, action: "delete", by: "Admin", before: { qty: 2, item: "Welding wire 1.2mm" } });
    expect(rev.after).toBe(Prisma.DbNull);
  });

  it("refuses a stale page or a bad id", async () => {
    expect((await deleteConsumableIssue(del({ version: "2026-01-01T00:00:00.000Z" }))).error).toMatch(/Someone changed/);
    expect((await deleteConsumableIssue(del({ id: "abc" }))).error).toMatch(/Invalid row/);
    expect((await deleteConsumableIssue(del({ version: "" }))).error).toMatch(/Invalid row/);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });
});

describe("restoreConsumableRevision", () => {
  const before = { item: "Welding wire 1.2mm", qty: 5, department: "WeldingTX", workerId: 7, workerEmpId: "1203", workerName: "Sayed", notes: "first" };
  const restore = (over: Record<string, string> = {}) => form({ revisionId: "11", version: version.toISOString(), ...over });

  beforeEach(() => {
    h.prisma.consumableIssueRevision.findUnique.mockResolvedValue({ issueId: 42, before });
  });

  it("is the admin's alone — the recorder cannot restore", async () => {
    h.requireAdmin.mockResolvedValue(NO_PERM);
    expect((await restoreConsumableRevision(restore())).ok).toBe(false);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });

  it("puts the row back as it read, and keeps the restore as a change of its own", async () => {
    const res = await restoreConsumableRevision(restore());
    expect(res).toEqual({ ok: true });
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    // no deletedAt in the guard: a deleted row can be brought back too
    expect(upd.where).toEqual({ id: 42, updatedAt: version });
    expect(upd.data).toMatchObject({ item: "Welding wire 1.2mm", department: "WeldingTX", notes: "first", deletedAt: null, deletedBy: null, editedBy: "Admin" });
    expect(upd.data).not.toHaveProperty("workerId");
    expect(upd.data.qty.toString()).toBe("5");
    const rev = h.prisma.consumableIssueRevision.create.mock.calls[0][0].data;
    expect(rev).toMatchObject({
      issueId: 42, action: "restore", by: "Admin",
      before: { qty: 2, notes: null },
      after: { qty: 5, notes: "first" },
    });
  });

  it("brings a deleted row back onto the log", async () => {
    h.prisma.consumableIssue.findUnique.mockResolvedValue(saved({ deletedAt: new Date(), ...{ qty: new Prisma.Decimal(5), notes: "first" } }));
    const res = await restoreConsumableRevision(restore());
    expect(res.ok).toBe(true);
    expect(h.prisma.consumableIssue.updateMany.mock.calls[0][0].data).toMatchObject({ deletedAt: null });
  });

  it("refuses a restore that would change nothing, a stale page, or an unknown version", async () => {
    h.prisma.consumableIssue.findUnique.mockResolvedValueOnce(saved({ qty: new Prisma.Decimal(5), notes: "first" }));
    expect((await restoreConsumableRevision(restore())).error).toMatch(/already reads like that/);
    expect((await restoreConsumableRevision(restore({ version: "2026-01-01T00:00:00.000Z" }))).error).toMatch(/Someone changed/);
    h.prisma.consumableIssueRevision.findUnique.mockResolvedValueOnce(null);
    expect((await restoreConsumableRevision(restore())).error).toMatch(/no longer exists/);
    h.prisma.consumableIssueRevision.findUnique.mockResolvedValueOnce({ issueId: 42, before: { junk: true } });
    expect((await restoreConsumableRevision(restore())).error).toMatch(/cannot be read back/);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });

  it("restores without looking the worker up — the row keeps whoever it named", async () => {
    h.prisma.worker.findUnique.mockResolvedValue(null);
    expect((await restoreConsumableRevision(restore())).ok).toBe(true);
    expect(h.prisma.worker.findUnique).not.toHaveBeenCalled();
  });
});

describe("limits at recording", () => {
  const breach = {
    ruleId: 9, period: "week", basis: "pool", departmentsLabel: "Welding TX", window: { from: "2026-09-26", to: "2026-10-02" },
    windowLabel: "week of 26 Sep", used: 14, adding: 2, limit: 15,
  };

  it("records a catalogue item under the catalogue's own name, linked to it", async () => {
    const res = await createConsumableIssue(form({ ...valid, itemId: "3", item: "whatever was typed" }));
    expect(res.ok).toBe(true);
    const data = h.prisma.consumableIssue.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ itemId: 3, item: "Grinding Disk 115x6x22.23mm", overLimit: false, overLimitReason: null });
    expect(h.checkIssueLimits).toHaveBeenCalledWith(expect.objectContaining({ itemId: 3, department: "WeldingTX", workerIds: [], qty: 2 }));
  });

  it("records a typed item with no catalogue link, and no limit check to speak of", async () => {
    const res = await createConsumableIssue(form({ ...valid, itemId: "__new__", item: "Spare fuse" }));
    expect(res.ok).toBe(true);
    expect(h.prisma.consumableIssue.create.mock.calls[0][0].data).toMatchObject({ itemId: null, item: "Spare fuse" });
    expect(h.checkIssueLimits).toHaveBeenCalledWith(expect.objectContaining({ itemId: null }));
  });

  it("refuses a retired catalogue item for a new hand-out", async () => {
    h.prisma.consumableItem.findUnique.mockResolvedValueOnce({ id: 3, name: "Old disk", active: false });
    const res = await createConsumableIssue(form({ ...valid, itemId: "3" }));
    expect(res.error).toMatch(/retired/);
    expect(h.prisma.consumableIssue.create).not.toHaveBeenCalled();
  });

  it("stops at a breach and asks for the reason, saving nothing", async () => {
    h.checkIssueLimits.mockResolvedValue([breach]);
    const res = await createConsumableIssue(form({ ...valid, itemId: "3" }));
    expect(res).toMatchObject({ ok: false, needsReason: true, breaches: ["Welding TX · a week (week of 26 Sep): 14 already + 2 now = 16 of 15"] });
    expect(h.prisma.consumableIssue.create).not.toHaveBeenCalled();
  });

  it("records over the limit once the reason is given, flagged with the breach", async () => {
    h.checkIssueLimits.mockResolvedValue([breach]);
    const res = await createConsumableIssue(form({ ...valid, itemId: "3", overLimitReason: "  second shift ran out  " }));
    expect(res.ok).toBe(true);
    expect(h.prisma.consumableIssue.create.mock.calls[0][0].data).toMatchObject({
      overLimit: true, overLimitReason: "second shift ran out", overLimitNote: expect.stringContaining("16 of 15"),
    });
  });

  it("refuses an over-long reason", async () => {
    h.checkIssueLimits.mockResolvedValue([breach]);
    expect((await createConsumableIssue(form({ ...valid, itemId: "3", overLimitReason: "x".repeat(301) }))).error).toMatch(/too long/);
  });

  it("checks an edit on the day it was handed out, leaving the row itself out", async () => {
    h.prisma.consumableIssue.findUnique.mockResolvedValue(saved({ issuedAt: new Date("2026-09-20T08:00:00Z"), itemId: 3 }));
    await updateConsumableIssue(form({ ...valid, itemId: "3", qty: "3", id: "42", version: version.toISOString() }));
    expect(h.checkIssueLimits).toHaveBeenCalledWith(expect.objectContaining({ itemId: 3, dayISO: "2026-09-20", excludeIssueId: 42, qty: 3 }));
  });

  it("keeps an edited row's earlier reason while it is still over, and clears the flag once it is not", async () => {
    h.checkIssueLimits.mockResolvedValue([breach]);
    h.prisma.consumableIssue.findUnique.mockResolvedValue(saved({ issuedAt: new Date("2026-09-28T08:00:00Z"), itemId: 3, overLimit: true, overLimitReason: "urgent job" }));
    const edit = form({ ...valid, itemId: "3", qty: "3", id: "42", version: version.toISOString() });
    expect((await updateConsumableIssue(edit)).ok).toBe(true);
    expect(h.prisma.consumableIssue.updateMany.mock.calls[0][0].data).toMatchObject({ overLimit: true, overLimitReason: "urgent job" });

    h.checkIssueLimits.mockResolvedValue([]);
    h.prisma.consumableIssue.updateMany.mockClear();
    expect((await updateConsumableIssue(edit)).ok).toBe(true);
    expect(h.prisma.consumableIssue.updateMany.mock.calls[0][0].data).toMatchObject({ overLimit: false, overLimitReason: null, overLimitNote: null });
  });

  it("asks for a reason when an edit newly takes a row over", async () => {
    h.checkIssueLimits.mockResolvedValue([breach]);
    h.prisma.consumableIssue.findUnique.mockResolvedValue(saved({ issuedAt: new Date("2026-09-28T08:00:00Z"), itemId: 3 }));
    const res = await updateConsumableIssue(form({ ...valid, itemId: "3", qty: "9", id: "42", version: version.toISOString() }));
    expect(res.needsReason).toBe(true);
    expect(h.prisma.consumableIssue.updateMany).not.toHaveBeenCalled();
  });
});

describe("older group rows", () => {
  // rows from before hand-outs were the department's: a whole department or
  // several workers, with the workers kept
  const group = (over: Record<string, unknown> = {}) => saved({
    workerId: null, worker: null, recipientScope: "department", recipientCount: 3, qty: new Prisma.Decimal(20),
    recipients: [1, 2, 3].map((id) => ({ workerId: id, worker: { name: `W${id}` } })),
    ...over,
  });

  it("corrects a group row's quantity and department, keeping its workers as history", async () => {
    h.prisma.consumableIssue.findUnique.mockResolvedValue(group());
    const res = await updateConsumableIssue(form({ id: "42", version: version.toISOString(), item: "Welding wire 1.2mm", qty: "24", notes: "", department: "PaintingTX" }));
    expect(res).toEqual({ ok: true });
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    expect(upd.data.qty.toString()).toBe("24");
    expect(upd.data.department).toBe("PaintingTX");
    expect(upd.data).not.toHaveProperty("workerId");
    expect(h.checkIssueLimits).toHaveBeenCalledWith(expect.objectContaining({ department: "PaintingTX", workerIds: [], excludeIssueId: 42 }));
    const rev = h.prisma.consumableIssueRevision.create.mock.calls[0][0].data;
    expect(rev.before).toMatchObject({ workerId: 0, workerName: "Whole Welding TX (3)", qty: 20 });
    expect(rev.after).toMatchObject({ workerId: 0, department: "PaintingTX", qty: 24 });
  });

  it("restores a group row's quantity and department", async () => {
    h.prisma.consumableIssue.findUnique.mockResolvedValue(group());
    h.prisma.consumableIssueRevision.findUnique.mockResolvedValue({
      issueId: 42, before: { item: "Welding wire 1.2mm", qty: 12, department: "WeldingTX", workerId: 0, workerEmpId: "", workerName: "Whole Welding TX (3)", notes: null },
    });
    const res = await restoreConsumableRevision(form({ revisionId: "11", version: version.toISOString() }));
    expect(res).toEqual({ ok: true });
    const upd = h.prisma.consumableIssue.updateMany.mock.calls[0][0];
    expect(upd.data.qty.toString()).toBe("12");
    expect(upd.data.department).toBe("WeldingTX");
    expect(upd.data).not.toHaveProperty("workerId");
  });
});
