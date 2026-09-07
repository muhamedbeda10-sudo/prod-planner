"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { parseISODate } from "@/lib/domain/dates";
import { reasonChanged } from "@/lib/domain/odoo";
import { importOdooSheet, type OdooImportResult } from "@/lib/server/odoo";

// The ODOO tab's writes — a daily log of close attempts. Rows are plain
// entries: no identity key, because the same Odoo MO retried tomorrow is a
// second, separate attempt and the log must keep both.
//
// Reason keeps its history: every time the column is given a new value, a
// line is appended to OdooReasonHistory, so the row shows what it said before.

export interface OdooActionResult {
  ok: boolean;
  error?: string;
}

function revalidateOdoo() {
  revalidatePath("/odoo");
}

interface Fields {
  date: Date | null;
  soi: string | null;
  fgCode: string;
  product: string;
  odooMo: string;
  qty: number | null;
  status: string;
  reason: string | null;
}

const text = (v: FormDataEntryValue | null) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

function read(formData: FormData): Fields {
  const qtyRaw = text(formData.get("qty"));
  const qty = qtyRaw === "" ? null : Number(qtyRaw);
  return {
    date: parseISODate(text(formData.get("date"))),
    soi: text(formData.get("soi")).toUpperCase() || null,
    fgCode: text(formData.get("fgCode")).toUpperCase(),
    product: text(formData.get("product")),
    odooMo: text(formData.get("odooMo")).toUpperCase(),
    qty: Number.isFinite(qty as number) ? qty : NaN,
    status: text(formData.get("status")) || "MO to be close",
    reason: text(formData.get("reason")) || null,
  };
}

function validate(f: Fields): string | null {
  if (!f.date) return "Enter the date.";
  if (!f.fgCode) return "Enter the FG-CODE.";
  if (!f.product) return "Enter the product (Tank, Top Cover, …).";
  if (!f.odooMo) return "Enter the Odoo MO number.";
  if (f.qty === null || Number.isNaN(f.qty)) return "Enter the quantity.";
  if (f.qty < 0) return "Quantity cannot be negative.";
  return null;
}

export async function createOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const f = read(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };

  const by = guard.user?.name ?? null;
  await prisma.odooEntry.create({
    data: {
      date: f.date!, soi: f.soi, fgCode: f.fgCode, product: f.product, odooMo: f.odooMo,
      qty: f.qty!, status: f.status, reason: f.reason, recordedBy: by,
      ...(f.reason ? { reasonHistory: { create: { reason: f.reason, recordedBy: by } } } : {}),
    },
  });
  revalidateOdoo();
  return { ok: true };
}

/** The history line for a reason change — only when the value really changed. */
function reasonHistoryWrite(current: string | null, next: string | null, by: string | null) {
  return reasonChanged(current, next) ? { reasonHistory: { create: { reason: next!, recordedBy: by } } } : {};
}

export async function updateOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const f = read(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };

  const cur = await prisma.odooEntry.findUnique({ where: { id }, select: { reason: true } });
  if (!cur) return { ok: false, error: "That row no longer exists." };
  const by = guard.user?.name ?? null;
  await prisma.odooEntry.update({
    where: { id },
    data: {
      date: f.date!, soi: f.soi, fgCode: f.fgCode, product: f.product, odooMo: f.odooMo,
      qty: f.qty!, status: f.status, reason: f.reason, recordedBy: by,
      ...reasonHistoryWrite(cur.reason, f.reason, by),
    },
  });
  revalidateOdoo();
  return { ok: true };
}

/** Rewrite just the Reason of one row — the cell the office changes most. */
export async function setOdooReason(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const reason = text(formData.get("reason")) || null;
  const cur = await prisma.odooEntry.findUnique({ where: { id }, select: { reason: true } });
  if (!cur) return { ok: false, error: "That row no longer exists." };
  const by = guard.user?.name ?? null;
  await prisma.odooEntry.update({
    where: { id },
    data: { reason, recordedBy: by, ...reasonHistoryWrite(cur.reason, reason, by) },
  });
  revalidateOdoo();
  return { ok: true };
}

export async function deleteOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  await prisma.odooEntry.delete({ where: { id } });
  revalidateOdoo();
  return { ok: true };
}

/** Import the office's sheet once — its first seven columns; Reason is left alone. */
export async function importOdooAction(formData: FormData): Promise<OdooImportResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the Excel file." };
  const day = text(formData.get("day"));
  const fallbackDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  const preview = formData.get("preview") === "true";
  try {
    const res = await importOdooSheet(await file.arrayBuffer(), fallbackDay, guard.user?.name ?? null, preview);
    if (res.ok && !preview) revalidateOdoo();
    return res;
  } catch (e) {
    return { ok: false, error: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
