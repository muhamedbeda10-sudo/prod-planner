"use server";

import { emitEvent } from "@/lib/server/events";
import { revalidatePath } from "next/cache";
import { settleOrdersAfterOdoo } from "@/lib/server/odooAutoClose";
import { getActiveLine } from "@/lib/server/line";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { isProductLine, type ProductLine } from "@/lib/domain/lines";
import { factoryDayISO, parseISODate, toISODate } from "@/lib/domain/dates";
import { isDoneStatus } from "@/lib/domain/odoo";
import { importOdooSheet, type OdooImportResult } from "@/lib/server/odoo";
import { UserError, userMessage } from "@/lib/server/errors";

// The ODOO log's writes — a daily log of close attempts. Rows are plain
// entries: no identity key, because the same Odoo MO retried tomorrow is a
// second, separate attempt and the log must keep both.
//
// Two people work a row: the clerk enters it up to Status; the planner then
// moves the status and adds notes. Notes are their own rows (OdooNote), each
// with its time and author, added and deleted one at a time.

export interface OdooActionResult {
  ok: boolean;
  error?: string;
  /** createOdooEntry: the new row's id; addOdooNote: the new note's. */
  id?: number;
}

function revalidateOdoo() {
  revalidatePath("/odoo");
  revalidatePath("/tracker");
}

// The tab shows both product lines at once: a write is guarded by the Odoo
// permission of the line(s) it touches — the rows' own, or, for a new row
// or a sheet, the line picked with it (the nav's toggle when none is).

async function lineOf(formData: FormData): Promise<ProductLine> {
  const v = String(formData.get("line") ?? "");
  return isProductLine(v) ? v : await getActiveLine();
}

async function guardRows(ids: number[]) {
  const rows = ids.length ? await prisma.odooEntry.findMany({ where: { id: { in: ids } }, select: { line: true } }) : [];
  const lines = [...new Set(rows.map((r) => r.line))];
  if (lines.length === 0) lines.push(await getActiveLine());
  let guard: Awaited<ReturnType<typeof requirePerm>> = { error: "Nothing to change." };
  for (const l of lines) {
    guard = await requirePerm(linePermKey(l, "odoo"));
    if (guard.error) return guard;
  }
  return guard;
}

interface Fields {
  date: Date | null;
  soi: string | null;
  /** Null when the form does not carry it — the tab no longer asks for it;
   *  an imported or born row keeps the one it has. */
  fgCode: string | null;
  product: string;
  odooMo: string;
  qty: number | null;
  status: string;
}

const text = (v: FormDataEntryValue | null) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

const STALE = "Someone changed this row since the page was loaded — refresh and try again.";

/** A row of a merged line that moved between updateOdooGroup's check and its
 *  write: thrown inside the transaction so the whole line rolls back. */
class StaleRow extends UserError {}

/** The row's last change as the page drew it ("version") — the edit's
 *  optimistic lock; null when the caller sent none (the assistant, which
 *  re-reads the row before it writes). */
function versionOf(formData: FormData): Date | null {
  const raw = String(formData.get("version") ?? "");
  const d = new Date(raw);
  return raw && !Number.isNaN(d.getTime()) ? d : null;
}

function read(formData: FormData): Fields {
  const qtyRaw = text(formData.get("qty"));
  const qty = qtyRaw === "" ? null : Number(qtyRaw);
  return {
    date: parseISODate(text(formData.get("date"))),
    soi: text(formData.get("soi")).toUpperCase() || null,
    fgCode: formData.has("fgCode") ? text(formData.get("fgCode")).toUpperCase() : null,
    product: text(formData.get("product")),
    odooMo: text(formData.get("odooMo")).toUpperCase(),
    qty: Number.isFinite(qty as number) ? qty : NaN,
    status: text(formData.get("status")) || "MO to be close",
  };
}

/** `born`: a row that came from a painting / shot-blast record may keep an
 *  empty MO until the office fills it — it is the ledger's row, not a typed
 *  one. The FG-CODE is not asked for. */
function validate(f: Fields, born = false): string | null {
  if (!f.date) return "Enter the date.";
  if (!f.product) return "Enter the product (Tank, Top Cover, …).";
  if (!f.odooMo && !born) return "Enter the Odoo MO number.";
  if (f.qty === null || Number.isNaN(f.qty)) return "Enter the quantity.";
  if (f.qty < 0) return "Quantity cannot be negative.";
  return null;
}

/** A NEW row that is Done the moment it is created is closed now — unless it
 *  is logged for a PAST day: then it was closed that day (the clerk is typing
 *  up yesterday's sheet), not today. Not Done → no stamp. */
function doneAtOnCreate(nextStatus: string, rowDate: Date): Date | null {
  if (!isDoneStatus(nextStatus)) return null;
  const now = new Date();
  return toISODate(rowDate) < factoryDayISO(now) ? rowDate : now;
}

/** An EXISTING row moved to Done is closed now, whatever day it was logged —
 *  the status pill's rule (setOdooStatus), so the dashboard's closed day and
 *  lead time read the same whichever control the planner used; a row already
 *  Done keeps the moment it was closed on. */
function doneAtOnEdit(nextStatus: string, prev: { status: string; doneAt: Date | null }, now: Date): Date | null {
  if (!isDoneStatus(nextStatus)) return null;
  return isDoneStatus(prev.status) && prev.doneAt ? prev.doneAt : now;
}

export async function createOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const line = await lineOf(formData);
  const guard = await requirePerm(linePermKey(line, "odoo"));
  if (guard.error) return { ok: false, error: guard.error };
  const f = read(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };

  const created = await prisma.odooEntry.create({
    data: {
      line,
      date: f.date!, soi: f.soi, fgCode: f.fgCode ?? "", product: f.product, odooMo: f.odooMo,
      qty: f.qty!, status: f.status, doneAt: doneAtOnCreate(f.status, f.date!), recordedBy: guard.user?.name ?? null,
    },
    select: { id: true },
  });
  revalidateOdoo();
  await emitEvent({
    type: "odoo.logged",
    subject: f.odooMo,
    summary: `Logged ${f.qty} × ${f.product} on Odoo ${f.odooMo}${f.soi ? ` (${f.soi})` : ""}${line === "LV" ? " — LV" : ""}`,
    data: { line, odooMo: f.odooMo, product: f.product, qty: f.qty, soi: f.soi },
  });
  // after its own event, so the order's close reads after the log that caused it
  // only a transformer row closed can close an order — the panels' rows close none
  if (line === "TR" && isDoneStatus(f.status)) await settleOrdersAfterOdoo();
  return { ok: true, id: created.id };
}

export async function updateOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows([id]);
  if (guard.error) return { ok: false, error: guard.error };
  const f = read(formData);

  const prev = await prisma.odooEntry.findUnique({ where: { id }, select: { status: true, doneAt: true, ledgerId: true, fgCode: true, fgGuessed: true, updatedAt: true } });
  if (!prev) return { ok: false, error: "That row no longer exists." };
  // the modal sends the row's last change as it drew it: saving a modal opened
  // before someone marked the row Done must not put it back to "to be close"
  const version = versionOf(formData);
  if (version && version.getTime() !== prev.updatedAt.getTime()) return { ok: false, error: STALE };
  const bad = validate(f, prev.ledgerId !== null);
  if (bad) return { ok: false, error: bad };
  const res = await prisma.odooEntry.updateMany({
    where: { id, updatedAt: prev.updatedAt },
    data: {
      date: f.date!, soi: f.soi, fgCode: f.fgCode ?? prev.fgCode, product: f.product, odooMo: f.odooMo,
      qty: f.qty!, status: f.status, doneAt: doneAtOnEdit(f.status, prev, new Date()), recordedBy: guard.user?.name ?? null,
      // a corrected FG-CODE is a guess no more; an untouched one stays flagged
      // (this edit may have been about the qty)
      fgGuessed: prev.fgGuessed && (f.fgCode ?? prev.fgCode) === prev.fgCode,
    },
  });
  if (res.count === 0) return { ok: false, error: STALE };
  revalidateOdoo();
  if (isDoneStatus(f.status)) await settleOrdersAfterOdoo();
  return { ok: true };
}

/** Type Odoo's MO onto a row born from a closing — the clerk's one missing
 *  column, filled in place. */
/** The rows an action applies to: one id, or the `ids` of a merged line —
 *  the log folds the rows that are the same closing onto one line, and the MO
 *  and the status typed there belong to every row under it. */
function idsOf(formData: FormData): number[] {
  const many = String(formData.get("ids") ?? "").split(",").map((x) => Number(x.trim())).filter(Number.isInteger);
  if (many.length > 0) return [...new Set(many)];
  const one = Number(formData.get("id"));
  return Number.isInteger(one) ? [one] : [];
}

export async function setOdooMo(formData: FormData): Promise<OdooActionResult> {
  const ids = idsOf(formData);
  if (ids.length === 0) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows(ids);
  if (guard.error) return { ok: false, error: guard.error };
  const odooMo = text(formData.get("odooMo")).toUpperCase();
  const prev = await prisma.odooEntry.findMany({ where: { id: { in: ids } }, select: { ledgerId: true } });
  if (prev.length === 0) return { ok: false, error: "That row no longer exists." };
  // a typed row must keep an MO; a born one may be emptied back to "no MO yet"
  if (!odooMo && prev.some((p) => p.ledgerId === null)) return { ok: false, error: "Enter the Odoo MO number." };
  await prisma.odooEntry.updateMany({ where: { id: { in: ids } }, data: { odooMo, recordedBy: guard.user?.name ?? null } });
  revalidateOdoo();
  return { ok: true };
}

/** Confirm or correct a guessed FG-CODE in place. */
export async function setOdooFgCode(formData: FormData): Promise<OdooActionResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows([id]);
  if (guard.error) return { ok: false, error: guard.error };
  const fgCode = text(formData.get("fgCode")).toUpperCase();
  if (!fgCode) return { ok: false, error: "Enter the FG-CODE." };
  const prev = await prisma.odooEntry.findUnique({ where: { id }, select: { id: true } });
  if (!prev) return { ok: false, error: "That row no longer exists." };
  await prisma.odooEntry.update({ where: { id }, data: { fgCode, fgGuessed: false, recordedBy: guard.user?.name ?? null } });
  revalidateOdoo();
  await settleOrdersAfterOdoo();
  return { ok: true };
}

/** Move just the Status of one row — the planner's column. */
export async function setOdooStatus(formData: FormData): Promise<OdooActionResult> {
  const ids = idsOf(formData);
  if (ids.length === 0) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows(ids);
  if (guard.error) return { ok: false, error: guard.error };
  const status = text(formData.get("status"));
  if (!status) return { ok: false, error: "Pick a status." };
  const prev = await prisma.odooEntry.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, doneAt: true } });
  if (prev.length === 0) return { ok: false, error: "That row no longer exists." };
  // the planner closing a row is closing it NOW, whatever day it was logged —
  // but a row already Done keeps the moment it was closed on
  const now = new Date();
  const by = guard.user?.name ?? null;
  await prisma.$transaction(prev.map((p) => {
    const doneAt = !isDoneStatus(status) ? null : isDoneStatus(p.status) && p.doneAt ? p.doneAt : now;
    return prisma.odooEntry.update({ where: { id: p.id }, data: { status, doneAt, recordedBy: by } });
  }));
  revalidateOdoo();
  if (isDoneStatus(status)) await settleOrdersAfterOdoo();
  return { ok: true };
}

/** Add one note to a row. */
export async function addOdooNote(formData: FormData): Promise<OdooActionResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows([id]);
  if (guard.error) return { ok: false, error: guard.error };
  const body = String(formData.get("text") ?? "").trim();
  if (!body) return { ok: false, error: "Type the note first." };
  const entry = await prisma.odooEntry.findUnique({ where: { id }, select: { id: true } });
  if (!entry) return { ok: false, error: "That row no longer exists." };
  const note = await prisma.odooNote.create({ data: { entryId: id, text: body, recordedBy: guard.user?.name ?? null }, select: { id: true } });
  revalidateOdoo();
  return { ok: true, id: note.id };
}

/** Delete one note — the row and its other notes stay. */
export async function deleteOdooNote(formData: FormData): Promise<OdooActionResult> {
  const noteId = Number(formData.get("noteId"));
  if (!Number.isInteger(noteId)) return { ok: false, error: "Invalid note." };
  const note = await prisma.odooNote.findUnique({ where: { id: noteId }, select: { entryId: true } });
  const guard = await guardRows(note ? [note.entryId] : []);
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.odooNote.deleteMany({ where: { id: noteId } });
  revalidateOdoo();
  return { ok: true };
}

export async function deleteOdooEntry(formData: FormData): Promise<OdooActionResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows([id]);
  if (guard.error) return { ok: false, error: guard.error };
  const gone = await prisma.odooEntry.deleteMany({ where: { id } });
  revalidateOdoo();
  return gone.count === 0 ? { ok: false, error: "That row no longer exists." } : { ok: true };
}

/** A merged line's head, edited like a row: the SOI, product, MO and status
 *  typed there land on every row under it. Each row keeps its own date and
 *  quantity — those are what tell the closings apart. */
export async function updateOdooGroup(formData: FormData): Promise<OdooActionResult> {
  const ids = idsOf(formData);
  if (ids.length === 0) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows(ids);
  if (guard.error) return { ok: false, error: guard.error };
  const f = read(formData);
  if (!f.product) return { ok: false, error: "Enter the product (Tank, Top Cover, …)." };
  const prev = await prisma.odooEntry.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, doneAt: true, date: true, ledgerId: true, updatedAt: true } });
  if (prev.length === 0) return { ok: false, error: "That row no longer exists." };
  if (prev.length < ids.length) return { ok: false, error: STALE };
  // the modal sends each row's last change as it drew them: saving a modal
  // opened before someone closed one of the rows must not put it back
  const versions = String(formData.get("versions") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (versions.length > 0) {
    const posted = String(formData.get("ids") ?? "").split(",").map((x) => Number(x.trim()));
    const seen = new Map(posted.map((id, n) => [id, versions[n]]));
    if (prev.some((p) => seen.get(p.id) !== undefined && new Date(seen.get(p.id)!).getTime() !== p.updatedAt.getTime())) return { ok: false, error: STALE };
  }
  if (!f.odooMo && prev.some((p) => p.ledgerId === null)) return { ok: false, error: "Enter the Odoo MO number." };
  const by = guard.user?.name ?? null;
  const now = new Date();
  // all or nothing: a row that moved between the check and the write rolls
  // the whole line back, so "refresh and try again" is the truth
  try {
    await prisma.$transaction(async (tx) => {
      for (const p of prev) {
        const moved = await tx.odooEntry.updateMany({
          where: { id: p.id, updatedAt: p.updatedAt },
          data: { soi: f.soi, product: f.product, odooMo: f.odooMo, status: f.status, doneAt: doneAtOnEdit(f.status, p, now), recordedBy: by },
        });
        if (moved.count === 0) throw new StaleRow(STALE);
      }
    });
  } catch (e) {
    if (e instanceof StaleRow) {
      revalidateOdoo();
      return { ok: false, error: STALE };
    }
    throw e;
  }
  revalidateOdoo();
  if (isDoneStatus(f.status)) await settleOrdersAfterOdoo();
  return { ok: true };
}

/** Delete every row of a merged line at once. */
export async function deleteOdooEntries(formData: FormData): Promise<OdooActionResult> {
  const ids = idsOf(formData);
  if (ids.length === 0) return { ok: false, error: "Invalid entry." };
  const guard = await guardRows(ids);
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.odooEntry.deleteMany({ where: { id: { in: ids } } });
  revalidateOdoo();
  return { ok: true };
}

/** Import the clerk's sheet once — its first seven columns; notes are never read. */
export async function importOdooAction(formData: FormData): Promise<OdooImportResult> {
  const line = await lineOf(formData);
  const guard = await requirePerm(linePermKey(line, "odoo"));
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the Excel file." };
  const day = text(formData.get("day"));
  const fallbackDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  const preview = formData.get("preview") === "true";
  try {
    const res = await importOdooSheet(await file.arrayBuffer(), fallbackDay, guard.user?.name ?? null, preview, line);
    if (res.ok && !preview) {
      revalidateOdoo();
      if (line === "TR") await settleOrdersAfterOdoo();
    }
    return res;
  } catch (e) {
    return { ok: false, error: userMessage(e, "import the sheet") };
  }
}
