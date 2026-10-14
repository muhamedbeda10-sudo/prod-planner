"use server";

import { emitEvent } from "@/lib/server/events";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, requireAdmin, requirePerm } from "@/lib/server/auth";
import { getCustomDepartments } from "@/lib/server/consumables";
import { checkIssueLimits, limitHints, lockItemLimits, type LimitHint } from "@/lib/server/consumableLimits";
import { snapshotHeadcount } from "@/lib/server/consumableHeadcount";
import { parseWorkerSections } from "@/lib/domain/workers";
import { factoryDayISO } from "@/lib/domain/dates";
import { describeBreach, type LimitBreach } from "@/lib/domain/consumableLimits";
import {
  canEditIssue,
  issueWho,
  keepsOverLimitReason,
  overLimitReasonProblem,
  parseSnapshot,
  readConsumableForm,
  matchCatalogueItem,
  NEW_ITEM,
  readItemPick,
  readOverLimitReason,
  resolveDepartment,
  sameSnapshot,
  workerProblem,
  type ConsumableSnapshot,
  type RecipientPick,
} from "@/lib/domain/consumables";

// The CONSUMABLES tab's writes. Recording a hand-out needs consumables.edit.
// A hand-out of a catalogue item is checked against every limit of the item
// that covers its department (all must hold): one that would take a limit
// over is NEVER recorded without a reason — refused until the recorder writes
// one, then saved flagged over the limit with the reason and the breach as it
// read. The check and the write run in one transaction holding the item's
// lock, so two hand-outs of the same item at once cannot both pass on the
// same room: the second waits, then counts the first.
// A hand-out is recorded to a department — the item, the quantity and the
// department, no worker (rows from before keep the worker they named). A
// per-person limit counts as the department's: the number times its workers.
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
  /** createConsumableIssue: the new row's id. */
  id?: number;
}

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const NOT_YOURS = "You can only correct the hand-outs you recorded yourself — ask the admin.";
const STALE = "Someone changed this row since the page was loaded — refresh and try again.";
const GONE = "That row no longer exists — refresh the page.";
const SAVE_FAILED = "The hand-out could not be saved — nothing was recorded. Try again, and tell the admin if it keeps happening.";

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

/** A saved row, with the worker's name — or the group's workers — as the
 *  snapshot needs them. */
async function loadIssue(id: number) {
  return prisma.consumableIssue.findUnique({
    where: { id },
    include: {
      worker: { select: { empId: true, name: true } },
      recipients: { select: { workerId: true, worker: { select: { name: true } } }, orderBy: { worker: { name: "asc" } } },
    },
  });
}
type IssueRow = NonNullable<Awaited<ReturnType<typeof loadIssue>>>;

function snapshotOf(row: IssueRow): ConsumableSnapshot {
  const who = issueWho(row);
  return {
    item: row.item, qty: row.qty.toNumber(), department: row.department,
    workerId: row.workerId ?? 0, workerEmpId: who.empId, workerName: who.name, notes: row.notes, itemId: row.itemId,
  };
}

interface ResolvedRecipients {
  scope: RecipientPick["scope"];
  /** The one worker; null for a group. */
  workerId: number | null;
  /** Every worker it is for — the one, or the group's. */
  workerIds: number[];
}

/** Check who a new hand-out is for, and fix a group's workers: the ticked
 *  ones (each active and in the section), or the section's crew at work today. */
async function resolveRecipients(pick: RecipientPick, department: string): Promise<{ r?: ResolvedRecipients; error?: string }> {
  if (pick.scope === "worker") {
    const bad = workerProblem(await loadWorker(pick.workerId), department);
    if (bad) return { error: bad };
    return { r: { scope: "worker", workerId: pick.workerId, workerIds: [pick.workerId] } };
  }
  if (pick.scope === "workers") {
    const rows = await prisma.worker.findMany({ where: { id: { in: pick.workerIds } }, select: { id: true, empId: true, name: true, active: true, depts: true } });
    if (rows.length !== pick.workerIds.length) return { error: "One of the ticked workers is no longer on the list — refresh the page." };
    for (const w of rows) {
      const bad = workerProblem({ ...w, sections: parseWorkerSections(w.depts) as string[] }, department);
      if (bad) return { error: bad };
    }
    return { r: { scope: "workers", workerId: null, workerIds: [...pick.workerIds] } };
  }
  void department;
  return { r: { scope: "department", workerId: null, workerIds: [] } };
}

/**
 * Write one change: the row, guarded by the version it was read at (so a
 * concurrent change loses cleanly instead of being overwritten), and its
 * revision. "stale" when the row moved underneath, "failed" when the
 * database refused it.
 */
type ChangeRevision = { action: "edit" | "delete" | "restore"; before: ConsumableSnapshot; after: ConsumableSnapshot | null };

async function writeChange(
  id: number,
  readAt: Date,
  data: Prisma.ConsumableIssueUncheckedUpdateManyInput,
  revision: ChangeRevision,
  user: { id: number; name: string },
  where: { deletedAt?: null } = { deletedAt: null }
): Promise<"ok" | "stale" | "failed"> {
  try {
    return await prisma.$transaction((tx: Tx) => writeChangeIn(tx, id, readAt, data, revision, user, where));
  } catch (e) {
    // a refusal from the database comes back as a message, not a crash
    console.error("consumables writeChange", e);
    return "failed";
  }
}

/** writeChange's body, inside a transaction the caller holds. */
async function writeChangeIn(
  tx: Tx,
  id: number,
  readAt: Date,
  data: Prisma.ConsumableIssueUncheckedUpdateManyInput,
  revision: ChangeRevision,
  user: { id: number; name: string },
  where: { deletedAt?: null } = { deletedAt: null }
): Promise<"ok" | "stale"> {
  const res = await tx.consumableIssue.updateMany({ where: { id, updatedAt: readAt, ...where }, data });
  if (res.count !== 1) return "stale";
  await tx.consumableIssueRevision.create({
    data: {
      issueId: id, action: revision.action,
      before: json(revision.before), after: revision.after ? json(revision.after) : Prisma.DbNull,
      byId: user.id, by: user.name, at: new Date(),
    },
  });
  return "ok";
}

/** The item the form names: a catalogue item — picked by id, or typed /
 *  pasted and matched by its name or code — with the catalogue's name, or
 *  the text as typed (itemId null) when it names none. A new hand-out only
 *  links an active item; a correction may keep the row's own retired one. */
async function pickItem(formData: FormData, opts: { allowInactiveId?: number | null } = {}): Promise<{ itemId?: number | null; name?: string; error?: string }> {
  const raw = String(formData.get("itemId") ?? "").trim();
  if (raw !== "" && raw !== NEW_ITEM) {
    const pick = readItemPick((n) => formData.get(n));
    if (pick.error) return { error: pick.error };
    const item = await prisma.consumableItem.findUnique({ where: { id: pick.itemId! }, select: { id: true, name: true, active: true } });
    if (!item) return { error: "That item is not in the catalogue any more — refresh the page." };
    if (!item.active && item.id !== opts.allowInactiveId) return { error: `${item.name} is retired from the catalogue — pick another item.` };
    return { itemId: item.id, name: item.name };
  }
  const text = String(formData.get("item") ?? "");
  if (raw === NEW_ITEM || !text.trim()) return { itemId: null };
  const offered = await prisma.consumableItem.findMany({
    where: { OR: [{ active: true }, ...(opts.allowInactiveId ? [{ id: opts.allowInactiveId }] : [])] },
    select: { id: true, name: true, code: true },
  });
  const hit = matchCatalogueItem(text, offered);
  return hit ? { itemId: hit.id, name: hit.name } : { itemId: null };
}

/** The over-limit decision for a hand-out: refused (no reason, or one that
 *  is not a reason), or the flag, reason and note to save. `keepReason` — a
 *  corrected row already over that asks no more of the limit keeps the
 *  reason it was given unless a new one comes. */
function overLimitVerdict(breaches: LimitBreach[], reason: string | null, keepReason: string | null = null):
  { refuse?: ConsumableActionResult; data?: { overLimit: boolean; overLimitReason: string | null; overLimitNote: string | null } } {
  if (breaches.length === 0) return { data: { overLimit: false, overLimitReason: null, overLimitNote: null } };
  const lines = breaches.map(describeBreach);
  const why = reason ?? keepReason;
  const problem = overLimitReasonProblem(why);
  if (problem) return { refuse: { ok: false, needsReason: true, breaches: lines, error: problem } };
  return { data: { overLimit: true, overLimitReason: why, overLimitNote: lines.join(" | ") } };
}

/** The refusal a locked write hands back instead of saving. */
class Refused {
  constructor(readonly result: ConsumableActionResult) {}
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
  const who = await resolveRecipients(f.recipients, department);
  if (who.error) return { ok: false, error: who.error };
  const r = who.r!;
  // who asked for it / collected it: on the list, active, and — for a worker
  // section — registered in it
  const receiver = await loadWorker(f.receivedById);
  const badReceiver = workerProblem(receiver, department);
  if (badReceiver) return { ok: false, error: badReceiver };

  // issuedAt is the database's clock (the column default) — never the form's.
  // The limits are checked and the row written under the item's lock. A
  // refusal from the database comes back as a message, never as a page that
  // will not load.
  const itemId = picked.itemId ?? null;
  let created: { id: number };
  let verdict: ReturnType<typeof overLimitVerdict>;
  try {
    const out = await prisma.$transaction(async (tx: Tx) => {
      await lockItemLimits(tx, itemId);
      const breaches = await checkIssueLimits({ itemId, department, workerIds: r.workerIds, qty: f.qty, dayISO: factoryDayISO(new Date()) }, tx);
      const v = overLimitVerdict(breaches, reason.reason);
      if (v.refuse) return new Refused({ ...v.refuse, department });
      const row = await tx.consumableIssue.create({
        select: { id: true },
        data: {
          itemId,
          ...v.data!,
          item: f.item,
          qty: new Prisma.Decimal(f.qty),
          department,
          // the department's hand-out, naming who asked for it / collected it
          workerId: r.workerId ?? receiver!.id,
          recipientScope: r.scope,
          recipientCount: r.workerIds.length || (r.scope === "worker" ? 1 : 0),
          ...(r.workerId === null && r.workerIds.length > 0 ? { recipients: { create: r.workerIds.map((workerId) => ({ workerId })) } } : {}),
          notes: f.notes,
          recordedById: user.id,
          recordedBy: user.name,
        },
      });
      return { row, v };
    }, { timeout: 15_000 });
    if (out instanceof Refused) return out.result;
    created = out.row;
    verdict = out.v;
  } catch (e) {
    console.error("createConsumableIssue", e);
    return { ok: false, error: SAVE_FAILED, department };
  }
  // the month's workers as they stood when it was handed out
  await snapshotHeadcount();
  revalidateConsumables();
  const over = verdict.data!.overLimit;
  await emitEvent({
    type: "consumables.issued",
    subject: f.item,
    summary: `Handed out ${f.qty} × ${f.item} to ${department}${over ? ` — OVER THE LIMIT: ${verdict.data!.overLimitReason ?? ""}` : ""}`,
    data: { item: f.item, qty: f.qty, department, overLimit: over },
  });
  return { ok: true, department, id: created.id };
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

  // an old row may keep a catalogue item that has since been retired; the
  // item, quantity, department, who asked for it and notes are corrected
  const picked = await pickItem(formData, { allowInactiveId: prev.itemId });
  if (picked.error) return { ok: false, error: picked.error };
  const read = readConsumableForm((n) => (n === "item" && picked.name ? picked.name : formData.get(n)));
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;
  const reason = readOverLimitReason((n) => formData.get(n));
  if (reason.error) return { ok: false, error: reason.error };

  const before = snapshotOf(prev);
  const department = resolveDepartment(f.department, await getCustomDepartments());
  // the person the row already names passes as he is (deactivated or moved
  // since — it is history) while the department stays
  const receiver = await loadWorker(f.receivedById);
  const badReceiver = workerProblem(receiver, department, { worker: f.receivedById === prev.workerId, department: department === prev.department });
  if (badReceiver) return { ok: false, error: badReceiver };
  const after: ConsumableSnapshot = {
    ...before, item: f.item, qty: new Prisma.Decimal(f.qty).toNumber(), department, notes: f.notes, itemId: picked.itemId ?? null,
    workerId: receiver!.id, workerEmpId: receiver!.empId, workerName: receiver!.name,
  };
  if (sameSnapshot(before, after)) return { ok: false, error: "Nothing changed." };

  // a row already over keeps its reason only while the correction asks no
  // more of the limit; anything else over needs a reason of its own
  const itemId = picked.itemId ?? null;
  const keep = prev.overLimit && keepsOverLimitReason(
    { itemId: prev.itemId, department: prev.department, qty: prev.qty.toNumber() },
    { itemId, department, qty: f.qty },
  ) ? prev.overLimitReason : null;

  // checked on the day it was handed out, the row itself left out of the
  // count — and written — under the item's lock
  let done: "ok" | "stale" | "failed";
  try {
    const out = await prisma.$transaction(async (tx: Tx) => {
      await lockItemLimits(tx, itemId);
      const breaches = await checkIssueLimits({
        itemId, department, workerIds: [], qty: f.qty,
        dayISO: factoryDayISO(prev.issuedAt), excludeIssueId: id,
      }, tx);
      const verdict = overLimitVerdict(breaches, reason.reason, keep);
      if (verdict.refuse) return new Refused(verdict.refuse);
      return writeChangeIn(
        tx, id, prev.updatedAt,
        {
          item: f.item, itemId, ...verdict.data!,
          qty: new Prisma.Decimal(f.qty), notes: f.notes, department, workerId: receiver!.id,
          editedAt: new Date(), editedBy: user.name,
        },
        { action: "edit", before, after },
        user
      );
    }, { timeout: 15_000 });
    if (out instanceof Refused) return out.result;
    done = out;
  } catch (e) {
    console.error("updateConsumableIssue", e);
    done = "failed";
  }
  if (done !== "ok") return { ok: false, error: done === "stale" ? STALE : SAVE_FAILED };

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
  if (done !== "ok") return { ok: false, error: done === "stale" ? STALE : SAVE_FAILED };

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

  // a version restores the item, the quantity, the department and the notes;
  // the worker an older row named is left as it is now
  const who = { workerId: current.workerId, workerEmpId: current.workerEmpId, workerName: current.workerName };

  const now = new Date();
  const done = await writeChange(
    prev.id, prev.updatedAt,
    {
      item: target.item, qty: new Prisma.Decimal(target.qty), notes: target.notes, department: target.department,
      // a revision from before the catalogue carries no item link: the row keeps its own
      itemId: target.itemId === undefined ? prev.itemId : target.itemId,
      editedAt: now, editedBy: user.name, deletedAt: null, deletedBy: null,
    },
    {
      action: "restore", before: current,
      after: { ...target, ...who },
    },
    user,
    {}
  );
  if (done !== "ok") return { ok: false, error: done === "stale" ? STALE : SAVE_FAILED };

  revalidateConsumables();
  return { ok: true };
}

/** The record form's hint while it is filled in: where the limits of the
 *  picked item stand for that department today (for a row being
 *  corrected, `id`, on its own day and with the row itself out of the count).
 *  Read-only. */
export async function consumableLimitHints(formData: FormData): Promise<{ hints: LimitHint[] }> {
  const user = await getCurrentUser();
  if (!user) return { hints: [] };
  const itemId = Number(formData.get("itemId"));
  const department = String(formData.get("department") ?? "").trim();
  if (!Number.isInteger(itemId) || itemId <= 0 || !department) return { hints: [] };
  const resolved = resolveDepartment(department, await getCustomDepartments());
  const id = idOf(formData);
  const row = id === null ? null : await prisma.consumableIssue.findUnique({ where: { id }, select: { id: true, issuedAt: true, deletedAt: true } });
  const live = row && !row.deletedAt ? row : null;
  return { hints: await limitHints(itemId, resolved, [], factoryDayISO(live?.issuedAt ?? new Date()), live?.id) };
}
