"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { isDoneStatus } from "@/lib/domain/odoo";
import { importOdooSheet, type OdooImportResult } from "@/lib/server/odoo";

// The ODOO tab's writes — a daily log of close attempts. Rows are plain
// entries: no identity key, because the same Odoo MO retried tomorrow is a
// second, separate attempt and the log must keep both.
//
// Two people work a row: the clerk enters it up to Status; the planner then
// moves the status and adds notes. Notes are their own rows (OdooNote), each
// with its time and author, added and deleted one at a time.

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

/**
 * The moment a row counts as closed. Moving to Done stamps now; moving away
 * clears it; staying Done keeps the first stamp. A row that is Done the moment
 * it is created for a PAST day was closed that day (the clerk is typing up
 * yesterday's sheet), not today.
 */
function doneAtFor(nextStatus: string, prev: { status: string; doneAt: Date | null } | null, rowDate: Date): Date | null {
  if (!isDoneStatus(nextStatus)) return null;
  if (prev && isDoneStatus(prev.status) && prev.doneAt) return prev.doneAt;
  const now = new Date();
  return toISODate(rowDate) < toISODate(now) ? rowDate : now;
}

export async function createOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const f = read(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };

  await prisma.odooEntry.create({
    data: {
      date: f.date!, soi: f.soi, fgCode: f.fgCode, product: f.product, odooMo: f.odooMo,
      qty: f.qty!, status: f.status, doneAt: doneAtFor(f.status, null, f.date!), recordedBy: guard.user?.name ?? null,
    },
  });
  revalidateOdoo();
  return { ok: true };
}

export async function updateOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const f = read(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };

  const prev = await prisma.odooEntry.findUnique({ where: { id }, select: { status: true, doneAt: true } });
  if (!prev) return { ok: false, error: "That row no longer exists." };
  await prisma.odooEntry.update({
    where: { id },
    data: {
      date: f.date!, soi: f.soi, fgCode: f.fgCode, product: f.product, odooMo: f.odooMo,
      qty: f.qty!, status: f.status, doneAt: doneAtFor(f.status, prev, f.date!), recordedBy: guard.user?.name ?? null,
    },
  });
  revalidateOdoo();
  return { ok: true };
}

/** Move just the Status of one row — the planner's column. */
export async function setOdooStatus(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const status = text(formData.get("status"));
  if (!status) return { ok: false, error: "Pick a status." };
  const prev = await prisma.odooEntry.findUnique({ where: { id }, select: { status: true, doneAt: true, date: true } });
  if (!prev) return { ok: false, error: "That row no longer exists." };
  // the planner closing a row is closing it NOW, whatever day it was logged
  const doneAt = !isDoneStatus(status) ? null : isDoneStatus(prev.status) && prev.doneAt ? prev.doneAt : new Date();
  await prisma.odooEntry.update({ where: { id }, data: { status, doneAt, recordedBy: guard.user?.name ?? null } });
  revalidateOdoo();
  return { ok: true };
}

/** Add one note to a row. */
export async function addOdooNote(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const body = String(formData.get("text") ?? "").trim();
  if (!body) return { ok: false, error: "Type the note first." };
  const entry = await prisma.odooEntry.findUnique({ where: { id }, select: { id: true } });
  if (!entry) return { ok: false, error: "That row no longer exists." };
  await prisma.odooNote.create({ data: { entryId: id, text: body, recordedBy: guard.user?.name ?? null } });
  revalidateOdoo();
  return { ok: true };
}

/** Delete one note — the row and its other notes stay. */
export async function deleteOdooNote(formData: FormData): Promise<OdooActionResult> {
  const guard = await requirePerm("odoo.edit");
  if (guard.error) return { ok: false, error: guard.error };
  const noteId = Number(formData.get("noteId"));
  if (!Number.isInteger(noteId)) return { ok: false, error: "Invalid note." };
  await prisma.odooNote.deleteMany({ where: { id: noteId } });
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

/** Import the clerk's sheet once — its first seven columns; notes are never read. */
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
