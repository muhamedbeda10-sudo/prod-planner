"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, requireAdmin, requirePerm } from "@/lib/server/auth";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, parseISODate, toISODate } from "@/lib/domain/dates";
import { canEditIssue } from "@/lib/domain/consumables";
import { SCRAP_LIMITS, readScrapForm, sameScrap, type ScrapSnapshot } from "@/lib/domain/powderScrap";

// POWDER SCRAP — the writes. Recording a weighing needs consumables.edit
// (the store's permission). A weighing is corrected by the person who
// recorded it or by an admin; deleting it is the admin's, and soft. Every
// change keeps the weighing before and after (PowderScrapRevision), and is
// refused if someone else changed it since the page was drawn.

export interface PowderActionResult {
  ok: boolean;
  error?: string;
}

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const NOT_YOURS = "You can only correct the weighings you recorded yourself — ask the admin.";
const STALE = "Someone changed this weighing since the page was loaded — refresh and try again.";
const GONE = "That weighing no longer exists — refresh the page.";

const json = (s: ScrapSnapshot) => s as unknown as Prisma.InputJsonObject;

function readForm(formData: FormData) {
  const today = factoryDayISO(new Date());
  return readScrapForm((n) => formData.get(n), today, addDaysISO(today, -SCRAP_LIMITS.daysBack));
}

function idAndVersion(formData: FormData): { id: number; version: Date } | null {
  const id = Number(formData.get("id"));
  const raw = String(formData.get("version") ?? "");
  const version = new Date(raw);
  if (!Number.isInteger(id) || id <= 0 || !raw || Number.isNaN(version.getTime())) return null;
  return { id, version };
}

function snapshotOf(row: { day: Date; department: string; kg: Prisma.Decimal; notes: string | null }): ScrapSnapshot {
  return { dayISO: toISODate(row.day), department: row.department, kg: row.kg.toNumber(), notes: row.notes };
}

export async function createPowderScrap(formData: FormData): Promise<PowderActionResult> {
  const guard = await requirePerm("consumables.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;
  const read = readForm(formData);
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;
  await prisma.powderScrap.create({
    data: {
      day: parseISODate(f.dayISO)!, department: f.department, kg: new Prisma.Decimal(f.kg), notes: f.notes,
      recordedById: user.id, recordedBy: user.name,
    },
  });
  revalidatePath("/consumables");
  return { ok: true };
}

/** Correct a weighing — its recorder (consumables.edit) or an admin. */
export async function updatePowderScrap(formData: FormData): Promise<PowderActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const ref = idAndVersion(formData);
  if (!ref) return { ok: false, error: "Invalid weighing — refresh the page." };

  const prev = await prisma.powderScrap.findUnique({ where: { id: ref.id } });
  if (!prev || prev.deletedAt) return { ok: false, error: GONE };
  if (!canEditIssue({ id: user.id, isAdmin: user.isAdmin, canRecord: hasPerm(user, "consumables.edit") }, prev)) return { ok: false, error: NOT_YOURS };
  if (prev.updatedAt.getTime() !== ref.version.getTime()) return { ok: false, error: STALE };

  const read = readForm(formData);
  if (read.error) return { ok: false, error: read.error };
  const f = read.fields!;
  const before = snapshotOf(prev);
  const after: ScrapSnapshot = { dayISO: f.dayISO, department: f.department, kg: new Prisma.Decimal(f.kg).toNumber(), notes: f.notes };
  if (sameScrap(before, after)) return { ok: false, error: "Nothing changed." };

  const done = await prisma.$transaction(async (tx) => {
    const res = await tx.powderScrap.updateMany({
      where: { id: ref.id, updatedAt: prev.updatedAt, deletedAt: null },
      data: { day: parseISODate(f.dayISO)!, department: f.department, kg: new Prisma.Decimal(f.kg), notes: f.notes, editedAt: new Date(), editedBy: user.name },
    });
    if (res.count !== 1) return false;
    await tx.powderScrapRevision.create({ data: { scrapId: ref.id, action: "edit", before: json(before), after: json(after), byId: user.id, by: user.name } });
    return true;
  });
  if (!done) return { ok: false, error: STALE };
  revalidatePath("/consumables");
  return { ok: true };
}

/** Take a weighing off — the admin's. Soft: it stays, with its history. */
export async function deletePowderScrap(formData: FormData): Promise<PowderActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;
  const ref = idAndVersion(formData);
  if (!ref) return { ok: false, error: "Invalid weighing — refresh the page." };

  const prev = await prisma.powderScrap.findUnique({ where: { id: ref.id } });
  if (!prev || prev.deletedAt) return { ok: false, error: GONE };
  if (prev.updatedAt.getTime() !== ref.version.getTime()) return { ok: false, error: STALE };

  const done = await prisma.$transaction(async (tx) => {
    const res = await tx.powderScrap.updateMany({ where: { id: ref.id, updatedAt: prev.updatedAt, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.name } });
    if (res.count !== 1) return false;
    await tx.powderScrapRevision.create({ data: { scrapId: ref.id, action: "delete", before: json(snapshotOf(prev)), after: Prisma.DbNull, byId: user.id, by: user.name } });
    return true;
  });
  if (!done) return { ok: false, error: STALE };
  revalidatePath("/consumables");
  return { ok: true };
}
