import "server-only";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";

// Rows of the ODOO log, the MATERIAL tab and the physical stock exactly as
// they stand — what the assistant's change card compares before a change
// runs, and what its undo writes back, every column and an ODOO row's notes
// included. The screens' own actions stamp things as they go (the moment a
// row was closed, a rate typed by hand, who recorded it), so the opposite
// action would not put a row back as it was; this does.
//
// Not a server action: no page can call it. Only the assistant's undo
// reaches it — an internal tool whose rows the app itself read when the
// change ran, stored on the change's record, and run only while the rows
// still read as the change left them. It checks the permission each table's
// own screen checks, for the person the undo runs as.

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s === null ? null : new Date(s));

/** A row as a snapshot keeps it: every column (a column added later comes
 *  along by itself), the first-recorded time as text, and not the moment it
 *  was last touched — the database stamps that on every write. */
function snapshotOf<T extends { createdAt: Date; updatedAt: Date }>(r: T): Omit<T, "createdAt" | "updatedAt"> & { createdAt: string } {
  const { createdAt, updatedAt, ...rest } = r;
  void updatedAt;
  return { ...rest, createdAt: createdAt.toISOString() };
}

export type RestoreResult = { ok: true } | { ok: false; error: string };

// ------------------------------------------------------------------ ODOO

export interface OdooNoteSnapshot {
  id: number;
  text: string;
  recordedBy: string | null;
  at: string;
}

export interface OdooRowSnapshot {
  id: number;
  line: string;
  date: string;
  soi: string | null;
  fgCode: string;
  product: string;
  odooMo: string;
  qty: number;
  status: string;
  doneAt: string | null;
  recordedBy: string | null;
  source: string;
  ledgerId: number | null;
  fgGuessed: boolean;
  createdAt: string;
  notes: OdooNoteSnapshot[];
}

/** The rows of these ids, in id order, with their notes — the ones gone are
 *  simply not there. */
export async function readOdooRows(ids: readonly number[]): Promise<OdooRowSnapshot[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.odooEntry.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: "asc" }, include: { notes: { orderBy: { id: "asc" } } } });
  return rows.map((r) => ({
    id: r.id, line: r.line, date: r.date.toISOString(), soi: r.soi, fgCode: r.fgCode, product: r.product, odooMo: r.odooMo, qty: r.qty,
    status: r.status, doneAt: iso(r.doneAt), recordedBy: r.recordedBy, source: r.source, ledgerId: r.ledgerId, fgGuessed: r.fgGuessed,
    createdAt: r.createdAt.toISOString(),
    notes: r.notes.map((n) => ({ id: n.id, text: n.text, recordedBy: n.recordedBy, at: n.at.toISOString() })),
  }));
}

/** Put ODOO rows back exactly as snapshotted — a row deleted since comes back
 *  under its own id, with its notes; a row's notes become the snapshot's. */
export async function restoreOdooRows(rows: readonly OdooRowSnapshot[]): Promise<RestoreResult> {
  for (const line of new Set(rows.map((r) => r.line))) {
    const guard = await requirePerm(linePermKey(line, "odoo"));
    if (guard.error) return { ok: false, error: guard.error };
  }
  try {
    await prisma.$transaction(async (tx) => {
      for (const r of rows) {
        const data = {
          line: r.line, date: date(r.date)!, soi: r.soi, fgCode: r.fgCode, product: r.product, odooMo: r.odooMo, qty: r.qty, status: r.status,
          doneAt: date(r.doneAt), recordedBy: r.recordedBy, source: r.source, ledgerId: r.ledgerId, fgGuessed: r.fgGuessed,
        };
        await tx.odooEntry.upsert({ where: { id: r.id }, create: { id: r.id, ...data, createdAt: date(r.createdAt)! }, update: data });
        await tx.odooNote.deleteMany({ where: { entryId: r.id, id: { notIn: r.notes.map((n) => n.id) } } });
        for (const n of r.notes) {
          await tx.odooNote.upsert({
            where: { id: n.id },
            create: { id: n.id, entryId: r.id, text: n.text, recordedBy: n.recordedBy, at: date(n.at)! },
            update: { entryId: r.id, text: n.text, recordedBy: n.recordedBy, at: date(n.at)! },
          });
        }
      }
    });
  } catch (e) {
    return { ok: false, error: `The rows could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  revalidatePath("/odoo");
  return { ok: true };
}

// --------------------------------------------------------------- MATERIAL

export interface MaterialRowSnapshot {
  id: number;
  line: string;
  month: string;
  bom: string;
  mo: string;
  units: number;
  partCode: string;
  partName: string;
  materialCode: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheetsPerUnit: number;
  actualPerUnit: number | null;
  actualPerUnitManual: boolean;
  sheetsUsed: number | null;
  producedQty: number | null;
  sortOrder: number;
  soi: string;
  mtr: string;
  weightKg: number | null;
  utilization: number | null;
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
}

export async function readMaterialRows(ids: readonly number[]): Promise<MaterialRowSnapshot[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.materialUsage.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: "asc" } });
  return rows.map(snapshotOf);
}

/** Put MATERIAL lines back exactly as snapshotted — a line deleted since
 *  comes back under its own id. */
export async function restoreMaterialRows(rows: readonly MaterialRowSnapshot[]): Promise<RestoreResult> {
  for (const line of new Set(rows.map((r) => r.line))) {
    const guard = await requirePerm(linePermKey(line, "material"));
    if (guard.error) return { ok: false, error: guard.error };
  }
  try {
    await prisma.$transaction(async (tx) => {
      for (const { id, createdAt, ...data } of rows) {
        await tx.materialUsage.upsert({ where: { id }, create: { id, ...data, createdAt: date(createdAt)! }, update: data });
      }
    });
  } catch (e) {
    return { ok: false, error: `The lines could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  revalidatePath("/material");
  return { ok: true };
}

// --------------------------------------------------------------- PHYSICAL

export interface PhysicalRowSnapshot {
  id: number;
  code: string;
  name: string;
  uom: string;
  physical: number;
  odoo: number;
  sortOrder: number;
  note: string | null;
  updatedBy: string | null;
  createdAt: string;
}

export async function readPhysicalRows(ids: readonly number[]): Promise<PhysicalRowSnapshot[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.physicalStock.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: "asc" } });
  return rows.map(snapshotOf);
}

/** Put physical-stock items back exactly as snapshotted — an item deleted
 *  since comes back under its own id. */
export async function restorePhysicalRows(rows: readonly PhysicalRowSnapshot[]): Promise<RestoreResult> {
  const guard = await requirePerm("stock.edit");
  if (guard.error) return { ok: false, error: guard.error };
  try {
    await prisma.$transaction(async (tx) => {
      for (const { id, createdAt, ...data } of rows) {
        await tx.physicalStock.upsert({ where: { id }, create: { id, ...data, createdAt: date(createdAt)! }, update: data });
      }
    });
  } catch (e) {
    return { ok: false, error: `The items could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  revalidatePath("/physical");
  return { ok: true };
}
