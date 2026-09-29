"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, requireAdmin, requirePerm } from "@/lib/server/auth";
import { getCustomDepartments } from "@/lib/server/consumables";
import { checkIssueLimits, limitHints, type LimitHint } from "@/lib/server/consumableLimits";
import { parseWorkerSections } from "@/lib/domain/workers";
import { factoryDayISO } from "@/lib/domain/dates";
import { describeBreach, type LimitBreach } from "@/lib/domain/consumableLimits";
import {
  canEditIssue,
  parseSnapshot,
  readConsumableForm,
  readItemPick,
  readOverLimitReason,
  resolveDepartment,
  sameSnapshot,
  workerProblem,
  type ConsumableSnapshot,
} from "@/lib/domain/consumables";

// The CONSUMABLES tab's writes. Recording a hand-out needs consumables.edit.
// A hand-out of a catalogue item is checked against the item's limits: one
// that would take a limit over is refused until the recorder gives a reason,
// then saved flagged over the limit with the reason and the breach as it read
// (a warning, not a wall — the store may have a good reason).
// A saved row is corrected by the person who recorded it or by an admin;
// deleting it, and restoring an earlier version of it, is the admin's. Every
// change writes a ConsumableIssueRevision with the row before and after, and
// is refused if someone else changed the row since the page was drawn.

export interface ConsumableActionResult {
  ok: boolean;
  error?: string;
  /** The department as stored (a section's code, or a typed department in
   *  its first spelling) — the form keeps it picked for the next hand-out. */
  department?: string;
  /** The hand-out would take a limit over: nothing was saved — the form shows
   *  these lines and asks for the reason, then sends again with it. */
  needsReason?: boolean;
  breaches?: string[];
}

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const NOT_YOURS = "You can only correct the hand-outs you recorded yourself — ask the admin.";
const STALE = "Someone changed this row since the page was loaded — refresh and try again.";
const GONE = "That row no longer exists — refresh the page.";

type Tx = Prisma.TransactionClient;

function revalidateConsumables() {
  revalidatePath("/consumables");
}

async function loadWorker(id: number) {
  const w = await prisma.worker.findUnique({ where: { id }, select: { id: true, empId: true, name: true, active: true, depts: true } });
  return w ? { ...w, sections: parseWorkerSections(w.depts) as string[] } : null;
}

function idOf(formData: FormData, name = "id"): number | null {
  const id = Number(formData.get(name));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The row's updatedAt the page was drawn with — the optimistic lock. */
function versionOf(formData: FormData): Date | null {
  const raw = String(formData.get("version") ?? "");
  const d = new Date(raw);
  return raw && !Number.isNaN(d.getTime()) ? d : null;
}

const json = (s: ConsumableSnapshot) => s as unknown as Prisma.InputJsonObject;

/** A saved row, with the worker's name as the snapshot needs it. */
async function loadIssue(id: number) {
  return prisma.consumableIssue.findUnique({
    where: { id },
    include: { worker: { select: { empId: true, name: true } } },
  });
}

function snapshotOf(row: NonNullable<Awaited<ReturnType<typeof loadIssue>>>): ConsumableSnapshot {
  return {
    item: row.item, qty: row.qty.toNumber(), department: row.department,
    workerId: row.workerId, workerEmpId: row.worker.empId, workerName: row.worker.name, notes: row.notes, itemId: row.itemId,
  };
}

/**
 * Write one change: the row, guarded by the version it was read at (so a
 * concurrent change loses cleanly instead of being overwritten), and its
 * revision. False when the row moved underneath.
 */
async function writeChange(
  id: number,
  readAt: Date,
  data: Prisma.ConsumableIssueUncheckedUpdateManyInput,
  revision: { action: "edit" | "delete" | "restore"; before: ConsumableSnapshot; after: ConsumableSnapshot | null },
  user: { id: number; name: string },
  where: { deletedAt?: null } = { deletedAt: null }
): Promise<boolean> {
  const at = new Date();
  return prisma.$transaction(async (tx: Tx) => {
    const res = await tx.consumableIssue.updateMany({ where: { id, updatedAt: readAt, ...where }, data });
    if (res.count !== 1) return false;
    await tx.consumableIssueRevision.create({
      data: {
        issueId: id, action: revision.action,
        before: json(revision.before), after: revision.after ? json(revision.after) : Prisma.DbNull,
        byId: user.id, by: user.name, at,
      },
    });
    return true;
  });
}

/** The item the form picked: a catalogue item (active, for a new hand-out)
 *  with its name, or the typed name (itemId null). */
async function pickItem(formData: FormData, opts: { allowInactiveId?: number | null } = {}): Promise<{ itemId?: number | null; name?: string; error?: string }> {
  const pick = readItemPick((n) => formData.get(n));
  if (pick.error) return { error: pick.error };
  if (pick.itemId === null || pick.itemId === undefined) return { itemId: null };
  const item = await prisma.consumableItem.findUnique({ where: { id: pick.itemId }, select: { id: true, name: true, active: true } });
  if (!item) return { error: "That item is not in the catalogue any more — refresh the page." };
  if (!item.active && item.id !== opts.allowInactiveId) return { error: `${item.name} is retired from the catalogue — pick another item.` };
  return { itemId: item.id, name: item.name };
}

/** The over-limit decision for a hand-out: refused (needs the reason), or the
 *  flag, reason and note to save. `keepReason` — an edited row already over
 *  keeps the reason it was given unless a new one comes. */
function overLimitVerdict(breaches: LimitBreach[], reason: string | null, keepReason: string | null = null):
  { refuse?: ConsumableActionResult; data?: { overLimit: boolean; overLimitReason: string | null; overLimitNote: string | null } } {
  if (breaches.length === 0) return { data: { overLimit: false, overLimitReason: null, overLimitNote: null } };
  const lines = breaches.map(describeBreach);
  const why = reason ?? keepReason;
  if (!why) {
    return { refuse: { ok: false, needsReason: true, breaches: lines, error: "This takes a limit over — give the reason to record it anyway." } };
  }
  return { data: { overLimit: true, overLimitReason: why, overLimitNote: lines.join(" | ") } };
}

export async function createConsumableIssue(formData: FormData): Promise<ConsumableActionResult> {
  const guard = await requirePerm("consumables.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;

  const picked = await pickItem(formData);
  if (picked.error) return { ok: false, error: picked.error };
  const read = readConsumableForm((n) => (n === "item" && picked.name ? picked.name : formData.get(n)));
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;
  const reason = readOverLimitReason((n) => formData.get(n));
  if (reason.error) return { ok: false, error: reason.error };

  const department = resolveDepartment(f.department, await getCustomDepartments());
  const worker = await loadWorker(f.workerId);
  const bad = workerProblem(worker, department);
  if (bad) return { ok: false, error: bad };

  const breaches = await checkIssueLimits({ itemId: picked.itemId ?? null, department, workerId: f.workerId, qty: f.qty, dayISO: factoryDayISO(new Date()) });
  const verdict = overLimitVerdict(breaches, reason.reason);
  if (verdict.refuse) return { ...verdict.refuse, department };

  // issuedAt is the database's clock (the column default) — never the form's
  await prisma.consumableIssue.create({
    data: {
      itemId: picked.itemId ?? null,
      ...verdict.data!,
      item: f.item,
      qty: new Prisma.Decimal(f.qty),
      department,
      workerId: f.workerId,
      notes: f.notes,
      recordedById: user.id,
      recordedBy: user.name,
    },
  });
  revalidateConsumables();
  return { ok: true, department };
}

/** Correct a saved row — its recorder (consumables.edit) or an admin. The
 *  moment it was handed out stays as recorded. */
export async function updateConsumableIssue(formData: FormData): Promise<ConsumableActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };

  const id = idOf(formData);
  const version = versionOf(formData);
  if (id === null || version === null) return { ok: false, error: "Invalid row — refresh the page." };

  const prev = await loadIssue(id);
  if (!prev || prev.deletedAt) return { ok: false, error: GONE };
  if (!canEditIssue({ id: user.id, isAdmin: user.isAdmin, canRecord: hasPerm(user, "consumables.edit") }, prev)) {
    return { ok: false, error: NOT_YOURS };
  }
  if (prev.updatedAt.getTime() !== version.getTime()) return { ok: false, error: STALE };

  // an old row may keep a catalogue item that has since been retired
  const picked = await pickItem(formData, { allowInactiveId: prev.itemId });
  if (picked.error) return { ok: false, error: picked.error };
  const read = readConsumableForm((n) => (n === "item" && picked.name ? picked.name : formData.get(n)));
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;
  const reason = readOverLimitReason((n) => formData.get(n));
  if (reason.error) return { ok: false, error: reason.error };

  const department = resolveDepartment(f.department, await getCustomDepartments());
  const unchanged = { worker: f.workerId === prev.workerId, department: department === prev.department };
  const worker = await loadWorker(f.workerId);
  const bad = workerProblem(worker, department, unchanged);
  if (bad) return { ok: false, error: bad };

  const before = snapshotOf(prev);
  const after: ConsumableSnapshot = {
    item: f.item, qty: new Prisma.Decimal(f.qty).toNumber(), department,
    workerId: f.workerId, workerEmpId: worker!.empId, workerName: worker!.name, notes: f.notes, itemId: picked.itemId ?? null,
  };
  if (sameSnapshot(before, after)) return { ok: false, error: "Nothing changed." };

  // checked on the day it was handed out, the row itself left out of the count
  const breaches = await checkIssueLimits({
    itemId: picked.itemId ?? null, department, workerId: f.workerId, qty: f.qty,
    dayISO: factoryDayISO(prev.issuedAt), excludeIssueId: id,
  });
  const verdict = overLimitVerdict(breaches, reason.reason, prev.overLimit ? prev.overLimitReason : null);
  if (verdict.refuse) return verdict.refuse;

  const done = await writeChange(
    id, prev.updatedAt,
    {
      item: f.item, itemId: picked.itemId ?? null, ...verdict.data!,
      qty: new Prisma.Decimal(f.qty), department, workerId: f.workerId, notes: f.notes, editedAt: new Date(), editedBy: user.name,
    },
    { action: "edit", before, after },
    user
  );
  if (!done) return { ok: false, error: STALE };

  revalidateConsumables();
  return { ok: true };
}

/** Take a row off the log — the admin's. Soft: it stays in the table, and an
 *  admin can bring it back from its history. */
export async function deleteConsumableIssue(formData: FormData): Promise<ConsumableActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;

  const id = idOf(formData);
  const version = versionOf(formData);
  if (id === null || version === null) return { ok: false, error: "Invalid row — refresh the page." };

  const prev = await loadIssue(id);
  if (!prev || prev.deletedAt) return { ok: false, error: GONE };
  if (prev.updatedAt.getTime() !== version.getTime()) return { ok: false, error: STALE };

  const done = await writeChange(
    id, prev.updatedAt,
    { deletedAt: new Date(), deletedBy: user.name },
    { action: "delete", before: snapshotOf(prev), after: null },
    user
  );
  if (!done) return { ok: false, error: STALE };

  revalidateConsumables();
  return { ok: true };
}

/**
 * Put a row back the way it was before one of its changes — the admin's. The
 * restore is itself a change: it writes its own revision, so it can be undone
 * the same way. A deleted row comes back onto the log. The worker is restored
 * as he was, even if he has since been deactivated: this is history, not a
 * new hand-out.
 */
export async function restoreConsumableRevision(formData: FormData): Promise<ConsumableActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;

  const revisionId = idOf(formData, "revisionId");
  const version = versionOf(formData);
  if (revisionId === null || version === null) return { ok: false, error: "Invalid version — refresh the page." };

  const rev = await prisma.consumableIssueRevision.findUnique({ where: { id: revisionId }, select: { issueId: true, before: true } });
  if (!rev) return { ok: false, error: "That version no longer exists — refresh the page." };
  const target = parseSnapshot(rev.before);
  if (!target) return { ok: false, error: "That version cannot be read back." };

  const prev = await loadIssue(rev.issueId);
  if (!prev) return { ok: false, error: GONE };
  if (prev.updatedAt.getTime() !== version.getTime()) return { ok: false, error: STALE };

  const current = snapshotOf(prev);
  if (!prev.deletedAt && sameSnapshot(current, target)) return { ok: false, error: "The row already reads like that version." };

  const worker = await prisma.worker.findUnique({ where: { id: target.workerId }, select: { empId: true, name: true } });
  if (!worker) return { ok: false, error: "The worker on that version is no longer on the list — it cannot be restored." };

  const now = new Date();
  const done = await writeChange(
    prev.id, prev.updatedAt,
    {
      item: target.item, qty: new Prisma.Decimal(target.qty), department: target.department, workerId: target.workerId, notes: target.notes,
      // a revision from before the catalogue carries no item link: the row keeps its own
      itemId: target.itemId === undefined ? prev.itemId : target.itemId,
      editedAt: now, editedBy: user.name, deletedAt: null, deletedBy: null,
    },
    { action: "restore", before: current, after: { ...target, workerEmpId: worker.empId, workerName: worker.name } },
    user,
    {}
  );
  if (!done) return { ok: false, error: STALE };

  revalidateConsumables();
  return { ok: true };
}

/** The record form's hint while it is filled in: where the limits of the
 *  picked item stand for that department (and worker) today. Read-only. */
export async function consumableLimitHints(formData: FormData): Promise<{ hints: LimitHint[] }> {
  const user = await getCurrentUser();
  if (!user) return { hints: [] };
  const itemId = Number(formData.get("itemId"));
  const department = String(formData.get("department") ?? "").trim();
  const workerRaw = Number(formData.get("workerId"));
  if (!Number.isInteger(itemId) || itemId <= 0 || !department) return { hints: [] };
  const resolved = resolveDepartment(department, await getCustomDepartments());
  return { hints: await limitHints(itemId, resolved, Number.isInteger(workerRaw) && workerRaw > 0 ? workerRaw : null, factoryDayISO(new Date())) };
}
