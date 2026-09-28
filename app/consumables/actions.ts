"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin, requirePerm } from "@/lib/server/auth";
import { getCustomDepartments, type ConsumableSnapshot } from "@/lib/server/consumables";
import { parseWorkerSections } from "@/lib/domain/workers";
import { readConsumableForm, resolveDepartment, workerProblem } from "@/lib/domain/consumables";

// The CONSUMABLES tab's writes. Recording a hand-out needs consumables.edit;
// once saved, a row is the admin's alone — every edit and delete is an admin
// action, keeps the row as it was (ConsumableIssueRevision), and is refused
// if someone else changed the row since the page was drawn.

export interface ConsumableActionResult {
  ok: boolean;
  error?: string;
  /** The department as stored (a section's code, or a typed department in
   *  its first spelling) — the form keeps it picked for the next hand-out. */
  department?: string;
}

const STALE = "Someone changed this row since the page was loaded — refresh and try again.";
const GONE = "That row no longer exists — refresh the page.";

function revalidateConsumables() {
  revalidatePath("/consumables");
}

async function loadWorker(id: number) {
  const w = await prisma.worker.findUnique({ where: { id }, select: { id: true, empId: true, name: true, active: true, depts: true } });
  return w ? { ...w, sections: parseWorkerSections(w.depts) as string[] } : null;
}

function idOf(formData: FormData): number | null {
  const id = Number(formData.get("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The row's updatedAt the page was drawn with — the optimistic lock. */
function versionOf(formData: FormData): Date | null {
  const raw = String(formData.get("version") ?? "");
  const d = new Date(raw);
  return raw && !Number.isNaN(d.getTime()) ? d : null;
}

export async function createConsumableIssue(formData: FormData): Promise<ConsumableActionResult> {
  const guard = await requirePerm("consumables.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;

  const read = readConsumableForm((n) => formData.get(n));
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;

  const department = resolveDepartment(f.department, await getCustomDepartments());
  const worker = await loadWorker(f.workerId);
  const bad = workerProblem(worker, department);
  if (bad) return { ok: false, error: bad };

  // issuedAt is the database's clock (the column default) — never the form's
  await prisma.consumableIssue.create({
    data: {
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

export async function updateConsumableIssue(formData: FormData): Promise<ConsumableActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;

  const id = idOf(formData);
  const version = versionOf(formData);
  if (id === null || version === null) return { ok: false, error: "Invalid row — refresh the page." };

  const read = readConsumableForm((n) => formData.get(n));
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;

  const prev = await prisma.consumableIssue.findUnique({
    where: { id },
    include: { worker: { select: { empId: true, name: true } } },
  });
  if (!prev || prev.deletedAt) return { ok: false, error: GONE };
  if (prev.updatedAt.getTime() !== version.getTime()) return { ok: false, error: STALE };

  const department = resolveDepartment(f.department, await getCustomDepartments());
  const unchanged = { worker: f.workerId === prev.workerId, department: department === prev.department };
  const worker = await loadWorker(f.workerId);
  const bad = workerProblem(worker, department, unchanged);
  if (bad) return { ok: false, error: bad };

  const qty = new Prisma.Decimal(f.qty);
  if (
    unchanged.worker && unchanged.department &&
    f.item === prev.item && qty.equals(prev.qty) && f.notes === prev.notes
  ) {
    return { ok: false, error: "Nothing changed." };
  }

  const before: ConsumableSnapshot = {
    item: prev.item, qty: prev.qty.toNumber(), department: prev.department,
    workerId: prev.workerId, workerEmpId: prev.worker.empId, workerName: prev.worker.name, notes: prev.notes,
  };
  const now = new Date();
  const done = await prisma.$transaction(async (tx) => {
    // the version in the WHERE is what makes a concurrent edit lose cleanly
    const res = await tx.consumableIssue.updateMany({
      where: { id, deletedAt: null, updatedAt: prev.updatedAt },
      data: { item: f.item, qty, department, workerId: f.workerId, notes: f.notes, editedAt: now, editedBy: user.name },
    });
    if (res.count !== 1) return false;
    await tx.consumableIssueRevision.create({
      data: { issueId: id, action: "edit", before: before as unknown as Prisma.InputJsonObject, byId: user.id, by: user.name, at: now },
    });
    return true;
  });
  if (!done) return { ok: false, error: STALE };

  revalidateConsumables();
  return { ok: true };
}

export async function deleteConsumableIssue(formData: FormData): Promise<ConsumableActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;

  const id = idOf(formData);
  const version = versionOf(formData);
  if (id === null || version === null) return { ok: false, error: "Invalid row — refresh the page." };

  const prev = await prisma.consumableIssue.findUnique({
    where: { id },
    include: { worker: { select: { empId: true, name: true } } },
  });
  if (!prev || prev.deletedAt) return { ok: false, error: GONE };
  if (prev.updatedAt.getTime() !== version.getTime()) return { ok: false, error: STALE };

  const before: ConsumableSnapshot = {
    item: prev.item, qty: prev.qty.toNumber(), department: prev.department,
    workerId: prev.workerId, workerEmpId: prev.worker.empId, workerName: prev.worker.name, notes: prev.notes,
  };
  const now = new Date();
  const done = await prisma.$transaction(async (tx) => {
    const res = await tx.consumableIssue.updateMany({
      where: { id, deletedAt: null, updatedAt: prev.updatedAt },
      data: { deletedAt: now, deletedBy: user.name },
    });
    if (res.count !== 1) return false;
    await tx.consumableIssueRevision.create({
      data: { issueId: id, action: "delete", before: before as unknown as Prisma.InputJsonObject, byId: user.id, by: user.name, at: now },
    });
    return true;
  });
  if (!done) return { ok: false, error: STALE };

  revalidateConsumables();
  return { ok: true };
}
