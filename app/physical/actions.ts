"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { importPhysicalStock, type PhysicalImportResult } from "@/lib/server/physicalStock";
import { stockNumber } from "@/lib/domain/physicalStock";

// PHYSICAL MATERIAL's writes — all behind "stock.edit". The figures are the
// store's count and Odoo's stock as the sheet carries them; nothing here
// touches Odoo itself.

export interface PhysicalActionResult {
  ok: boolean;
  error?: string;
}

const PERM = "stock.edit";
const done = () => revalidatePath("/physical");
const text = (v: FormDataEntryValue | null) => String(v ?? "").replace(/\s+/g, " ").trim();

export async function importPhysicalAction(formData: FormData): Promise<PhysicalImportResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the stock sheet (Excel)." };
  try {
    const res = await importPhysicalStock(await file.arrayBuffer(), guard.user?.name ?? null, formData.get("prune") === "on");
    if (res.ok) done();
    return res;
  } catch (e) {
    return { ok: false, error: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** One cell typed on the table — any column, the way the sheet is edited:
 *  the code, the product's name, its UOM, the two counts, or the note. */
export async function updatePhysicalCell(formData: FormData): Promise<PhysicalActionResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  const field = String(formData.get("field") ?? "");
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid item." };
  const by = guard.user?.name ?? null;
  if (field === "code") {
    const code = text(formData.get("value"));
    if (!code) return { ok: false, error: "The product code cannot be empty." };
    const clash = await prisma.physicalStock.findFirst({ where: { code: { equals: code, mode: "insensitive" }, NOT: { id } } });
    if (clash) return { ok: false, error: `${clash.code} is already on the table.` };
    await prisma.physicalStock.update({ where: { id }, data: { code, updatedBy: by } });
  } else if (field === "name") {
    await prisma.physicalStock.update({ where: { id }, data: { name: text(formData.get("value")).slice(0, 300), updatedBy: by } });
  } else if (field === "uom") {
    await prisma.physicalStock.update({ where: { id }, data: { uom: text(formData.get("value")).toUpperCase().slice(0, 20), updatedBy: by } });
  } else if (field === "note") {
    const note = text(formData.get("value")).slice(0, 500);
    await prisma.physicalStock.update({ where: { id }, data: { note: note || null, updatedBy: by } });
  } else if (field === "physical" || field === "odoo") {
    const n = stockNumber(formData.get("value"));
    if (n === null || n < 0) return { ok: false, error: "Enter a number of 0 or more." };
    await prisma.physicalStock.update({ where: { id }, data: { [field]: n, updatedBy: by } });
  } else return { ok: false, error: "Unknown field." };
  done();
  return { ok: true };
}

export async function createPhysicalItem(formData: FormData): Promise<PhysicalActionResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const code = text(formData.get("code"));
  const name = text(formData.get("name"));
  const uom = text(formData.get("uom")).toUpperCase();
  const physical = stockNumber(formData.get("physical")) ?? 0;
  const odoo = stockNumber(formData.get("odoo")) ?? 0;
  if (!code) return { ok: false, error: "Enter the product code." };
  if (physical < 0 || odoo < 0) return { ok: false, error: "Stock cannot be negative." };
  const clash = await prisma.physicalStock.findFirst({ where: { code: { equals: code, mode: "insensitive" } } });
  if (clash) return { ok: false, error: `${clash.code} is already on the table — edit its row.` };
  const last = await prisma.physicalStock.aggregate({ _max: { sortOrder: true } });
  await prisma.physicalStock.create({ data: { code, name, uom, physical, odoo, sortOrder: (last._max.sortOrder ?? 0) + 1, updatedBy: guard.user?.name ?? null } });
  done();
  return { ok: true };
}

export async function deletePhysicalItem(formData: FormData): Promise<PhysicalActionResult> {
  const guard = await requirePerm(PERM);
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid item." };
  await prisma.physicalStock.delete({ where: { id } });
  done();
  return { ok: true };
}
