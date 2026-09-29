"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { cleanText, parseQty } from "@/lib/domain/consumables";
import { ALL_DEPARTMENTS, isLimitBasis, isLimitPeriod, serializeDepartments } from "@/lib/domain/consumableLimits";

// The CONSUMABLES catalogue and its limits — the Limits view's writes. Open
// to whoever records hand-outs (consumables.edit). Every change writes a
// ConsumableCatalogueChange with the thing before and after, so a limit that
// moved can always be traced to who moved it and when.

export interface CatalogueActionResult {
  ok: boolean;
  error?: string;
}

const PERM = "consumables.edit";
const LIMITS = { name: 120, code: 60, uom: 12, remark: 200 } as const;

type Tx = Prisma.TransactionClient;
type Who = { id: number; name: string };

function revalidate() {
  revalidatePath("/consumables");
}

const idOf = (v: FormDataEntryValue | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const asJson = (v: unknown) => v as Prisma.InputJsonObject;

async function audit(tx: Tx, who: Who, e: { itemId: number; entity: "item" | "limit"; entityId: number; action: "create" | "update" | "delete"; before?: unknown; after?: unknown }) {
  await tx.consumableCatalogueChange.create({
    data: {
      itemId: e.itemId, entity: e.entity, entityId: e.entityId, action: e.action,
      before: e.before === undefined ? Prisma.DbNull : asJson(e.before),
      after: e.after === undefined ? Prisma.DbNull : asJson(e.after),
      byId: who.id, by: who.name,
    },
  });
}

const itemSnapshot = (i: { code: string | null; name: string; uom: string; remark: string | null; active: boolean }) =>
  ({ code: i.code, name: i.name, uom: i.uom, remark: i.remark, active: i.active });
const limitSnapshot = (l: { departments: string; basis: string; period: string; qty: Prisma.Decimal | number }) =>
  ({ departments: l.departments, basis: l.basis, period: l.period, qty: typeof l.qty === "number" ? l.qty : l.qty.toNumber() });

/** Add a catalogue item, or change one (code, name, unit, remark, active). */
export async function saveCatalogueItem(formData: FormData): Promise<CatalogueActionResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const who = { id: guard.user!.id, name: guard.user!.name };

  const id = idOf(formData.get("id"));
  const name = cleanText(formData.get("name"));
  const code = cleanText(formData.get("code")).toUpperCase() || null;
  const uom = cleanText(formData.get("uom")).toUpperCase() || "PC";
  const remark = cleanText(formData.get("remark")) || null;
  const active = formData.get("active") === null ? true : String(formData.get("active")) !== "false";
  if (!name) return { ok: false, error: "Enter the item's name." };
  if (name.length > LIMITS.name) return { ok: false, error: `The name is too long (at most ${LIMITS.name} characters).` };
  if (code && code.length > LIMITS.code) return { ok: false, error: `The code is too long (at most ${LIMITS.code} characters).` };
  if (uom.length > LIMITS.uom) return { ok: false, error: `The unit is too long (at most ${LIMITS.uom} characters).` };
  if (remark && remark.length > LIMITS.remark) return { ok: false, error: `The remark is too long (at most ${LIMITS.remark} characters).` };

  // the same name or code in another case is the same item
  const clash = await prisma.consumableItem.findFirst({
    where: {
      ...(id ? { id: { not: id } } : {}),
      OR: [{ name: { equals: name, mode: "insensitive" } }, ...(code ? [{ code: { equals: code, mode: "insensitive" as const } }] : [])],
    },
    select: { name: true, code: true },
  });
  if (clash) return { ok: false, error: clash.name.toLowerCase() === name.toLowerCase() ? `${clash.name} is already in the catalogue.` : `The code ${code} is already ${clash.name}'s.` };

  const data = { name, code, uom, remark, active };
  const result = await prisma.$transaction(async (tx) => {
    if (id) {
      const prev = await tx.consumableItem.findUnique({ where: { id } });
      if (!prev) return "gone" as const;
      const next = await tx.consumableItem.update({ where: { id }, data });
      if (JSON.stringify(itemSnapshot(prev)) === JSON.stringify(itemSnapshot(next))) return "same" as const;
      await audit(tx, who, { itemId: id, entity: "item", entityId: id, action: "update", before: itemSnapshot(prev), after: itemSnapshot(next) });
    } else {
      const next = await tx.consumableItem.create({ data });
      await audit(tx, who, { itemId: next.id, entity: "item", entityId: next.id, action: "create", after: itemSnapshot(next) });
    }
    return "ok" as const;
  });
  if (result === "gone") return { ok: false, error: "That item no longer exists — refresh the page." };
  if (result === "same") return { ok: false, error: "Nothing changed." };
  revalidate();
  return { ok: true };
}

/** Read a limit's fields from the form. */
function readLimit(formData: FormData): { error?: string; data?: { departments: string; basis: string; period: string; qty: number } } {
  const all = formData.get("allDepartments") === "true";
  const picked = formData.getAll("departments").map((v) => String(v).trim()).filter(Boolean);
  if (!all && picked.length === 0) return { error: "Pick at least one department (or All departments)." };
  const departments = serializeDepartments(all ? ALL_DEPARTMENTS : picked);
  if (departments.length > 500) return { error: "Too many departments on one limit." };
  const basis = String(formData.get("basis") ?? "pool");
  const period = String(formData.get("period") ?? "week");
  if (!isLimitBasis(basis)) return { error: "Pick how the limit counts: shared, or per person." };
  if (!isLimitPeriod(period)) return { error: "Pick the period: day, week, month or 3 months." };
  const q = parseQty(formData.get("qty"));
  if (q.error) return { error: q.error };
  return { data: { departments, basis, period, qty: q.qty! } };
}

/** Add a limit to an item, or change one. */
export async function saveConsumableLimit(formData: FormData): Promise<CatalogueActionResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const who = { id: guard.user!.id, name: guard.user!.name };

  const id = idOf(formData.get("id"));
  const itemId = idOf(formData.get("itemId"));
  if (!itemId) return { ok: false, error: "Invalid item — refresh the page." };
  const read = readLimit(formData);
  if (read.error) return { ok: false, error: read.error };
  const d = read.data!;

  const item = await prisma.consumableItem.findUnique({ where: { id: itemId }, select: { id: true } });
  if (!item) return { ok: false, error: "That item is not in the catalogue any more — refresh the page." };

  const result = await prisma.$transaction(async (tx) => {
    const data = { departments: d.departments, basis: d.basis, period: d.period, qty: new Prisma.Decimal(d.qty) };
    if (id) {
      const prev = await tx.consumableLimit.findUnique({ where: { id } });
      if (!prev || prev.itemId !== itemId) return "gone" as const;
      const next = await tx.consumableLimit.update({ where: { id }, data });
      if (JSON.stringify(limitSnapshot(prev)) === JSON.stringify(limitSnapshot(next))) return "same" as const;
      await audit(tx, who, { itemId, entity: "limit", entityId: id, action: "update", before: limitSnapshot(prev), after: limitSnapshot(next) });
    } else {
      const next = await tx.consumableLimit.create({ data: { ...data, itemId } });
      await audit(tx, who, { itemId, entity: "limit", entityId: next.id, action: "create", after: limitSnapshot(next) });
    }
    return "ok" as const;
  });
  if (result === "gone") return { ok: false, error: "That limit no longer exists — refresh the page." };
  if (result === "same") return { ok: false, error: "Nothing changed." };
  revalidate();
  return { ok: true };
}

/** Remove a limit from an item (the item then has no limit there). */
export async function deleteConsumableLimit(formData: FormData): Promise<CatalogueActionResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const who = { id: guard.user!.id, name: guard.user!.name };
  const id = idOf(formData.get("id"));
  if (!id) return { ok: false, error: "Invalid limit — refresh the page." };

  const result = await prisma.$transaction(async (tx) => {
    const prev = await tx.consumableLimit.findUnique({ where: { id } });
    if (!prev) return false;
    await tx.consumableLimit.delete({ where: { id } });
    await audit(tx, who, { itemId: prev.itemId, entity: "limit", entityId: id, action: "delete", before: limitSnapshot(prev) });
    return true;
  });
  if (!result) return { ok: false, error: "That limit no longer exists — refresh the page." };
  revalidate();
  return { ok: true };
}
