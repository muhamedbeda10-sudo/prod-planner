import "server-only";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin, requireOwner, requirePerm } from "@/lib/server/auth";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { deptPermKey, linePermKey, shiftPermKey } from "@/lib/domain/permissions";
import { MANUAL_BOM, MANUAL_ITEM, manualMo } from "@/lib/domain/manualJob";
import type { RosterDept } from "@/lib/domain/shifts";

// Rows of the ODOO log, the MATERIAL tab, the physical stock, the shift
// roster, the standard times and the accounts' access exactly as they stand
// — what the assistant's change card compares before a change runs, and what
// its undo writes back, every column and an ODOO row's notes included. The
// screens' own actions stamp things as they go (the moment a row was closed,
// a rate typed by hand, who recorded it), and some leave no way back at all
// (a stage's capacity cannot be unset, an account's assistant not taken
// away), so the opposite action would not put a row back as it was; this does.
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

// ------------------------------------------------------------------ SHIFTS

/** One worker's recorded day, as the roster keeps it. */
export interface ShiftRowSnapshot {
  dept: string;
  workerId: number;
  present: boolean;
  shift: string;
  overtimeH: number;
  machineId: number | null;
  /** The work centre (absent in snapshots taken before centres were recorded). */
  center?: string | null;
  note: string | null;
  recordedBy: string | null;
}

/** A department's man-hours for the day, as the calibration reads them. */
export interface DayHoursSnapshot {
  dept: string;
  hours: number;
  people: number | null;
  hoursEach: number | null;
  source: string;
  recordedBy: string | null;
}

/** Some departments' day on the roster: every worker's row and the summed
 *  man-hours — the row the calibration and the capacity check read. */
export interface ShiftState {
  rows: ShiftRowSnapshot[];
  dayHours: DayHoursSnapshot[];
}

const shiftDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function readShiftState(dateISO: string, depts: readonly string[]): Promise<ShiftState> {
  const date = shiftDay(dateISO);
  const [rows, hours] = await Promise.all([
    prisma.shiftEntry.findMany({ where: { date, dept: { in: [...depts] } }, orderBy: [{ dept: "asc" }, { workerId: "asc" }] }),
    prisma.deptDayHours.findMany({ where: { date, dept: { in: [...depts] } }, orderBy: { dept: "asc" } }),
  ]);
  return {
    rows: rows.map((r) => ({ dept: r.dept, workerId: r.workerId, present: r.present, shift: r.shift, overtimeH: r.overtimeH, machineId: r.machineId, center: r.center, note: r.note, recordedBy: r.recordedBy })),
    dayHours: hours.map((h) => ({ dept: h.dept, hours: h.hours, people: h.people, hoursEach: h.hoursEach, source: h.source, recordedBy: h.recordedBy })),
  };
}

/** Put these departments' day back exactly as snapshotted: the rows it had
 *  and nothing else, and its man-hours as they read — or no figure, when it
 *  had none. Each department needs its own shift-log permission. */
export async function restoreShiftState(dateISO: string, depts: readonly RosterDept[], state: ShiftState): Promise<RestoreResult> {
  for (const d of depts) {
    const guard = await requirePerm(shiftPermKey(d));
    if (guard.error) return { ok: false, error: guard.error };
  }
  const date = shiftDay(dateISO);
  try {
    await prisma.$transaction(async (tx) => {
      for (const dept of depts) {
        const rows = state.rows.filter((r) => r.dept === dept);
        await tx.shiftEntry.deleteMany({ where: { date, dept, workerId: { notIn: rows.map((r) => r.workerId) } } });
        for (const r of rows) {
          const data = { present: r.present, shift: r.shift, overtimeH: r.overtimeH, machineId: r.machineId, center: r.center ?? null, note: r.note, recordedBy: r.recordedBy };
          await tx.shiftEntry.upsert({ where: { date_dept_workerId: { date, dept, workerId: r.workerId } }, create: { date, dept, workerId: r.workerId, ...data }, update: data });
        }
        const h = state.dayHours.find((x) => x.dept === dept);
        if (!h) {
          await tx.deptDayHours.deleteMany({ where: { date, dept } });
          continue;
        }
        const data = { hours: h.hours, people: h.people, hoursEach: h.hoursEach, source: h.source, recordedBy: h.recordedBy };
        await tx.deptDayHours.upsert({ where: { date_dept: { date, dept } }, create: { date, dept, ...data }, update: data });
      }
    });
  } catch (e) {
    return { ok: false, error: `The day could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const p of ["/shifts", "/admin/standard-times", "/tracker", "/"]) revalidatePath(p);
  return { ok: true };
}

// --------------------------------------------------------- STANDARD TIMES

/** The rows of the standard-times tables a change touches, each as it
 *  stands — null where there is none. */
export interface StdState {
  tiers: { kva: number; row: { cutMh: number; weldMh: number; shbMh: number; paintMh: number } | null }[];
  capacity: { dept: string; mhPerDay: number | null }[];
  fgMap: { fg: string; kva: number | null }[];
  lv: { fg: string; row: { description: string | null; kind: string; cutH: number; bendH: number; weldH: number; shbH: number; paintH: number; totalH: number | null } | null }[];
}

export interface StdKeys {
  tiers?: readonly number[];
  capacity?: readonly string[];
  fgMap?: readonly string[];
  lv?: readonly string[];
}

export async function readStdState(k: StdKeys): Promise<StdState> {
  const [tiers, capacity, fgMap, lv] = await Promise.all([
    k.tiers?.length ? prisma.stdTime.findMany({ where: { kva: { in: [...k.tiers] } } }) : [],
    k.capacity?.length ? prisma.stageCapacity.findMany({ where: { dept: { in: [...k.capacity] } } }) : [],
    k.fgMap?.length ? prisma.stdFgMap.findMany({ where: { fg: { in: [...k.fgMap] } } }) : [],
    k.lv?.length ? prisma.lvStdTime.findMany({ where: { fg: { in: [...k.lv] } } }) : [],
  ]);
  return {
    tiers: [...new Set(k.tiers ?? [])].sort((a, b) => a - b).map((kva) => {
      const t = tiers.find((x) => x.kva === kva);
      return { kva, row: t ? { cutMh: t.cutMh, weldMh: t.weldMh, shbMh: t.shbMh, paintMh: t.paintMh } : null };
    }),
    capacity: [...new Set(k.capacity ?? [])].sort().map((dept) => ({ dept, mhPerDay: capacity.find((c) => c.dept === dept)?.mhPerDay ?? null })),
    fgMap: [...new Set(k.fgMap ?? [])].sort().map((fg) => ({ fg, kva: fgMap.find((f) => f.fg === fg)?.kva ?? null })),
    lv: [...new Set(k.lv ?? [])].sort().map((fg) => {
      const r = lv.find((x) => x.fg === fg);
      return { fg, row: r ? { description: r.description, kind: r.kind, cutH: r.cutH, bendH: r.bendH, weldH: r.weldH, shbH: r.shbH, paintH: r.paintH, totalH: r.totalH } : null };
    }),
  };
}

/** Put the standard-times rows back exactly as snapshotted — a row that was
 *  not there is removed, one that was comes back with every figure. The
 *  standard times are the admin's, as on their screen. */
export async function restoreStdState(s: StdState): Promise<RestoreResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  try {
    await prisma.$transaction(async (tx) => {
      for (const t of s.tiers) {
        if (t.row) await tx.stdTime.upsert({ where: { kva: t.kva }, create: { kva: t.kva, ...t.row }, update: t.row });
        else await tx.stdTime.deleteMany({ where: { kva: t.kva } });
      }
      for (const c of s.capacity) {
        if (c.mhPerDay !== null) await tx.stageCapacity.upsert({ where: { dept: c.dept }, create: { dept: c.dept, mhPerDay: c.mhPerDay }, update: { mhPerDay: c.mhPerDay } });
        else await tx.stageCapacity.deleteMany({ where: { dept: c.dept } });
      }
      for (const f of s.fgMap) {
        if (f.kva !== null) await tx.stdFgMap.upsert({ where: { fg: f.fg }, create: { fg: f.fg, kva: f.kva }, update: { kva: f.kva } });
        else await tx.stdFgMap.deleteMany({ where: { fg: f.fg } });
      }
      for (const l of s.lv) {
        if (l.row) await tx.lvStdTime.upsert({ where: { fg: l.fg }, create: { fg: l.fg, ...l.row }, update: l.row });
        else await tx.lvStdTime.deleteMany({ where: { fg: l.fg } });
      }
    });
  } catch (e) {
    return { ok: false, error: `The standard times could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const p of ["/admin/standard-times", "/tracker", "/shifts"]) revalidatePath(p);
  return { ok: true };
}

// --------------------------------------------------------- TIMES PER MACHINE

/** One machine's time for one item — null where it has none (the estimate). */
export interface MachineTimeSnapshot {
  machineId: number;
  item: string;
  hoursPerPc: number | null;
  setBy: string | null;
}

export async function readMachineTimes(machineId: number, items: readonly string[]): Promise<MachineTimeSnapshot[]> {
  const rows = await prisma.machineItemTime.findMany({ where: { machineId, item: { in: [...items] } } });
  return [...new Set(items)].sort().map((item) => {
    const r = rows.find((x) => x.item === item);
    return { machineId, item, hoursPerPc: r?.hoursPerPc ?? null, setBy: r?.setBy ?? null };
  });
}

/** Put a machine's times back exactly — a time that was not set is cleared
 *  again (the machine goes back on the estimate for it). */
export async function restoreMachineTimes(rows: readonly MachineTimeSnapshot[]): Promise<RestoreResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  try {
    await prisma.$transaction(async (tx) => {
      for (const r of rows) {
        if (r.hoursPerPc === null) {
          await tx.machineItemTime.deleteMany({ where: { machineId: r.machineId, item: r.item } });
          continue;
        }
        const data = { hoursPerPc: r.hoursPerPc, setBy: r.setBy };
        await tx.machineItemTime.upsert({ where: { machineId_item: { machineId: r.machineId, item: r.item } }, create: { machineId: r.machineId, item: r.item, ...data }, update: data });
      }
    });
  } catch (e) {
    return { ok: false, error: `The times could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const p of ["/admin/machine-times", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/simulate"]) revalidatePath(p);
  return { ok: true };
}

// ------------------------------------------------------------------ USERS

/** What an account may do and see, as Users & Permissions keeps it. */
export interface UserAccessSnapshot {
  id: number;
  isAdmin: boolean;
  perms: string;
  hiddenTabs: string;
  active: boolean;
  /** The assistant for them: null while they were never given it. The daily
   *  cap is absent from a snapshot taken before it existed (left as it is). */
  ai: { enabled: boolean; monthlyUsd: number; dailyUsd?: number } | null;
}

export async function readUserAccess(id: number): Promise<UserAccessSnapshot | null> {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, isAdmin: true, perms: true, hiddenTabs: true, active: true, aiAccess: { select: { enabled: true, monthlyUsd: true, dailyUsd: true } } } });
  if (!u) return null;
  return { id: u.id, isAdmin: u.isAdmin, perms: u.perms, hiddenTabs: u.hiddenTabs, active: u.active, ai: u.aiAccess ? { enabled: u.aiAccess.enabled, monthlyUsd: u.aiAccess.monthlyUsd, dailyUsd: u.aiAccess.dailyUsd } : null };
}

/** Put an account's access back exactly as snapshotted — the owner's alone,
 *  as Users & Permissions is. The owner's own standing never moves, and an
 *  account put back to inactive is signed out at once, as deactivating does. */
export async function restoreUserAccess(s: UserAccessSnapshot): Promise<RestoreResult> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };
  const target = await prisma.user.findUnique({ where: { id: s.id }, select: { isOwner: true, isAdmin: true } });
  if (!target) return { ok: false, error: "That account is not there any more." };
  if (target.isOwner && (!s.active || s.isAdmin !== target.isAdmin)) return { ok: false, error: "The owner's own standing cannot be changed." };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: s.id }, data: { isAdmin: s.isAdmin, perms: s.perms, hiddenTabs: s.hiddenTabs, active: s.active } });
      if (s.ai) await tx.aiAccess.upsert({ where: { userId: s.id }, create: { userId: s.id, ...s.ai }, update: s.ai });
      else await tx.aiAccess.deleteMany({ where: { userId: s.id } });
      if (!s.active) await tx.session.deleteMany({ where: { userId: s.id } });
    });
  } catch (e) {
    return { ok: false, error: `The account could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  revalidatePath("/admin/users");
  revalidatePath("/admin/ai");
  return { ok: true };
}

// ------------------------------------------------------- THE CUTTING FLOOR

/** A manual job's own rows in the machine queues — its line on each
 *  machine it sits on. */
export interface QueueRowOfJob {
  id: number;
  machineId: number;
  rank: number;
  running: boolean;
  qty: number | null;
  sheet: string;
  sheetDone: number;
  setBy: string | null;
}

const queueRowsOf = (dept: string, bom: string, mo: string, item: string) =>
  prisma.worklistMachine.findMany({ where: { dept, bom, mo, item }, orderBy: { id: "asc" } }).then((rows) =>
    rows.map((r) => ({ id: r.id, machineId: r.machineId, rank: r.rank, running: r.running, qty: r.qty, sheet: r.sheet, sheetDone: r.sheetDone, setBy: r.setBy })));

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** A job's queue rows put back as snapshotted — the rows it has now that the
 *  snapshot does not are taken off. */
async function putQueueRowsBack(tx: Tx, dept: string, key: { bom: string; mo: string; item: string }, rows: readonly QueueRowOfJob[]) {
  // a machine taken out of the plant since cannot take its row back
  const live = new Set((await tx.machine.findMany({ where: { id: { in: rows.map((r) => r.machineId) } }, select: { id: true } })).map((m) => m.id));
  const back = rows.filter((r) => live.has(r.machineId));
  await tx.worklistMachine.deleteMany({ where: { dept, ...key, id: { notIn: back.map((r) => r.id) } } });
  for (const r of back) {
    const data = { dept, ...key, machineId: r.machineId, rank: r.rank, running: r.running, qty: r.qty, sheet: r.sheet, sheetDone: r.sheetDone, setBy: r.setBy };
    await tx.worklistMachine.upsert({ where: { id: r.id }, create: { id: r.id, ...data }, update: data });
  }
}

export interface ManualJobSnapshot {
  id: number;
  dept: string;
  title: string;
  bom: string;
  item: string;
  qty: number;
  doneQty: number;
  bySheet: boolean;
  parts: { id: number; bom: string; item: string; part: string; pcs: number | null }[];
  material: string;
  thicknessMm: number | null;
  sheetSize: string;
  sheets: number | null;
  note: string | null;
  machineId: number | null;
  createdBy: string | null;
  createdAt: string;
  doneAt: string | null;
  queue: QueueRowOfJob[];
}

/** A manual job as it stands, with where it is queued — null once it is gone. */
export async function readManualJob(id: number): Promise<ManualJobSnapshot | null> {
  const j = await prisma.manualJob.findUnique({ where: { id }, include: { parts: { orderBy: { id: "asc" } } } });
  if (!j) return null;
  return {
    id: j.id, dept: j.dept, title: j.title, bom: j.bom, item: j.item, qty: j.qty, doneQty: j.doneQty,
    bySheet: j.bySheet, parts: j.parts.map((p) => ({ id: p.id, bom: p.bom, item: p.item, part: p.part, pcs: p.pcs })),
    material: j.material, thicknessMm: j.thicknessMm,
    sheetSize: j.sheetSize, sheets: j.sheets, note: j.note, machineId: j.machineId, createdBy: j.createdBy, createdAt: j.createdAt.toISOString(), doneAt: iso(j.doneAt),
    queue: await queueRowsOf(j.dept, MANUAL_BOM, manualMo(j.id), MANUAL_ITEM),
  };
}

/** Put a manual job back exactly as snapshotted — deleted since, it comes back
 *  under its own number, with its parts, on the machines it was queued on.
 *  The undo of a ✓ also takes that ✓'s row off the sheet cut log
 *  (`cutLogId`), so the log never shows sheets the job no longer counts. */
export async function restoreManualJob(s: ManualJobSnapshot, opts: { cutLogId?: number } = {}): Promise<RestoreResult> {
  const guard = await requirePerm(deptPermKey(s.dept));
  if (guard.error) return { ok: false, error: guard.error };
  try {
    await prisma.$transaction(async (tx) => {
      // a machine gone since is not one to put it back on
      const machineId = s.machineId !== null && (await tx.machine.count({ where: { id: s.machineId } })) > 0 ? s.machineId : null;
      const data = {
        dept: s.dept, title: s.title, bom: s.bom, item: s.item, qty: s.qty, doneQty: s.doneQty, bySheet: s.bySheet, material: s.material, thicknessMm: s.thicknessMm,
        sheetSize: s.sheetSize, sheets: s.sheets, note: s.note, machineId, createdBy: s.createdBy, doneAt: date(s.doneAt),
      };
      await tx.manualJob.upsert({ where: { id: s.id }, create: { id: s.id, ...data, createdAt: date(s.createdAt)! }, update: data });
      await tx.manualJobPart.deleteMany({ where: { jobId: s.id, id: { notIn: s.parts.map((p) => p.id) } } });
      for (const p of s.parts) {
        const part = { jobId: s.id, bom: p.bom, item: p.item, part: p.part, pcs: p.pcs };
        await tx.manualJobPart.upsert({ where: { id: p.id }, create: { id: p.id, ...part }, update: part });
      }
      const key = { bom: MANUAL_BOM, mo: manualMo(s.id), item: MANUAL_ITEM };
      await putQueueRowsBack(tx, s.dept, key, s.queue);
      // only this job's own row — never another job's under a wrong number;
      // a row gone already leaves the log and the job agreeing all the same
      if (opts.cutLogId !== undefined) await tx.sheetCutLog.deleteMany({ where: { id: opts.cutLogId, dept: s.dept, ...key } });
    });
  } catch (e) {
    return { ok: false, error: `The job could not be put back: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const path of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/machines", "/simulate", "/shifts"]) revalidatePath(path);
  return { ok: true };
}

// ---------------------------------------------------------- THE WORKLISTS

const QUEUE_PATHS = ["/worklist/cut", "/worklist/welding", "/worklist/painting"];

export interface QueueNoteSnapshot {
  id: number;
  bom: string;
  mo: string | null;
  item: string;
  dept: string;
  text: string;
  photos: string | null;
  status: string;
  createdAt: string;
}

/** A queue note as it stands — null once it is gone. */
export async function readQueueNote(id: number): Promise<QueueNoteSnapshot | null> {
  const n = await prisma.queueNote.findUnique({ where: { id } });
  return n ? snapshotOf(n) : null;
}

/** Put a queue note back as snapshotted. A note deleted since comes back
 *  under its own number without its photos — they were deleted with it. */
export async function restoreQueueNote(s: QueueNoteSnapshot): Promise<RestoreResult> {
  const guard = await requirePerm(deptPermKey(s.dept));
  if (guard.error) return { ok: false, error: guard.error };
  const there = await prisma.queueNote.findUnique({ where: { id: s.id }, select: { id: true } });
  const data = { bom: s.bom, mo: s.mo, item: s.item, dept: s.dept, text: s.text, photos: there ? s.photos : null, status: s.status };
  await prisma.queueNote.upsert({ where: { id: s.id }, create: { id: s.id, ...data, createdAt: new Date(s.createdAt) }, update: data });
  for (const p of QUEUE_PATHS) revalidatePath(p);
  return { ok: true };
}

const RETURN_PATHS = ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace"];

export interface ReturnSnapshot {
  id: number;
  date: string;
  fromDept: string;
  toDept: string;
  bom: string;
  mo: string | null;
  item: string;
  qty: number;
  reason: string;
  status: string;
  handoverId: number | null;
  createdAt: string;
}

/** A return to the upstream department as it stands — null once it is gone. */
export async function readReturn(id: number): Promise<ReturnSnapshot | null> {
  const r = await prisma.returnEntry.findUnique({ where: { id } });
  return r ? { ...snapshotOf(r), date: r.date.toISOString() } : null;
}

/** The undo of sending pieces back upstream: the return and the Daily log
 *  row that took them off the upstream department gone, as if never sent. */
export async function cancelReturn(id: number): Promise<RestoreResult> {
  const ret = await prisma.returnEntry.findUnique({ where: { id } });
  if (!ret) return { ok: false, error: "That return is gone." };
  if (ret.status !== "open") return { ok: false, error: "Those pieces were re-delivered since — the return stays." };
  const guard = await requirePerm(deptPermKey(ret.fromDept));
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.$transaction(async (tx) => {
    if (ret.handoverId !== null) await tx.handoverEntry.deleteMany({ where: { id: ret.handoverId, source: "return" } });
    await tx.returnEntry.delete({ where: { id } });
  });
  for (const p of RETURN_PATHS) revalidatePath(p);
  return { ok: true };
}

/** The undo of a re-delivery: the Daily log row that put the pieces back on
 *  the upstream department gone, and the return open again — refused when
 *  the department after it has used those pieces since. */
export async function reopenReturn(id: number, ledgerId: number): Promise<RestoreResult> {
  const ret = await prisma.returnEntry.findUnique({ where: { id } });
  if (!ret) return { ok: false, error: "That return is gone." };
  if (ret.status !== "resolved") return { ok: false, error: "That return is open already." };
  const guard = await requirePerm(deptPermKey(ret.toDept));
  if (guard.error) return { ok: false, error: guard.error };
  const row = await prisma.handoverEntry.findUnique({ where: { id: ledgerId } });
  if (!row || row.source !== "return" || row.dept !== ret.toDept || row.qty !== ret.qty || row.item !== ret.item || (row.mo ?? null) !== (ret.mo ?? null)) {
    return { ok: false, error: "The re-delivery's Daily log row is not as it was written." };
  }
  const chain = await checkOutputChain({ dept: row.dept, bom: row.bom, mo: row.mo, item: row.item, qty: 0, excludeId: row.id });
  if (chain) return { ok: false, error: chain };
  await prisma.$transaction(async (tx) => {
    await tx.handoverEntry.delete({ where: { id: row.id } });
    await tx.returnEntry.update({ where: { id }, data: { status: "open" } });
  });
  for (const p of RETURN_PATHS) revalidatePath(p);
  return { ok: true };
}

export interface WorklistDateSnapshot {
  id: number;
  origISO: string;
  newDate: string;
  qty: number | null;
  baseDone: number;
  createdBy: string | null;
  createdAt: string;
}

export interface WorklistLineKey {
  bom: string;
  mo: string;
  item: string;
}

/** A fabrication line's admin dates — every override of it, in id order. */
export async function readWorklistDates(line: WorklistLineKey): Promise<WorklistDateSnapshot[]> {
  const rows = await prisma.worklistDateOverride.findMany({ where: { bom: line.bom, mo: line.mo, item: line.item }, orderBy: { id: "asc" } });
  return rows.map((r) => ({ id: r.id, origISO: r.origISO, newDate: r.newDate.toISOString(), qty: r.qty, baseDone: r.baseDone, createdBy: r.createdBy, createdAt: r.createdAt.toISOString() }));
}

/** Put a line's admin dates back exactly: its overrides now replaced by the
 *  snapshotted ones, under their own numbers. */
export async function restoreWorklistDates(line: WorklistLineKey, rows: readonly WorklistDateSnapshot[]): Promise<RestoreResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const key = { bom: line.bom, mo: line.mo, item: line.item };
  await prisma.$transaction(async (tx) => {
    await tx.worklistDateOverride.deleteMany({ where: key });
    if (rows.length > 0) {
      await tx.worklistDateOverride.createMany({
        data: rows.map((r) => ({ id: r.id, ...key, origISO: r.origISO, newDate: new Date(r.newDate), qty: r.qty, baseDone: r.baseDone, createdBy: r.createdBy, createdAt: new Date(r.createdAt) })),
      });
    }
  });
  revalidatePath("/worklist/cut");
  return { ok: true };
}

// ------------------------------------------------------------------ TANKS

/** Who may put tanks back: the stage whose record is undone. */
export type TankStage = "Welding" | "LeakTest" | "Painting" | "Quality";

export interface TankSnapshot {
  id: number;
  serial: string;
  status: string;
  weldLedgerId: number | null;
  paintLedgerId: number | null;
  weldedAt: string;
  weldedById: number | null;
  weldedBy: string | null;
  weldedStamp: string | null;
  weldedLogBy: string | null;
  testedAt: string | null;
  testedById: number | null;
  testedBy: string | null;
  testResult: string | null;
  testNote: string | null;
  paintedAt: string | null;
  paintedById: number | null;
  paintedBy: string | null;
  qaAt: string | null;
  qaById: number | null;
  qaBy: string | null;
  qaResult: string | null;
  qaNote: string | null;
  /** Its history as it stood: the events' numbers. */
  events: number[];
}

/** These tanks as they stand, in serial order — the ones gone are not there. */
export async function readTanks(serials: readonly string[]): Promise<TankSnapshot[]> {
  if (serials.length === 0) return [];
  const rows = await prisma.tankUnit.findMany({ where: { serial: { in: [...serials] } }, orderBy: { serial: "asc" }, include: { events: { select: { id: true }, orderBy: { id: "asc" } } } });
  return rows.map((t) => ({
    id: t.id, serial: t.serial, status: t.status, weldLedgerId: t.weldLedgerId, paintLedgerId: t.paintLedgerId,
    weldedAt: t.weldedAt.toISOString(), weldedById: t.weldedById, weldedBy: t.weldedBy, weldedStamp: t.weldedStamp, weldedLogBy: t.weldedLogBy,
    testedAt: iso(t.testedAt), testedById: t.testedById, testedBy: t.testedBy, testResult: t.testResult, testNote: t.testNote,
    paintedAt: iso(t.paintedAt), paintedById: t.paintedById, paintedBy: t.paintedBy,
    qaAt: iso(t.qaAt), qaById: t.qaById, qaBy: t.qaBy, qaResult: t.qaResult, qaNote: t.qaNote,
    events: t.events.map((e) => e.id),
  }));
}

/** Put tanks back exactly as snapshotted — their record and their history
 *  without what the undone step wrote into it. A tank deleted since is not
 *  made again. */
export async function restoreTanks(stage: TankStage, snaps: readonly TankSnapshot[]): Promise<RestoreResult> {
  const guard = await requirePerm(stage === "Quality" ? "quality.qa" : deptPermKey(stage));
  if (guard.error) return { ok: false, error: guard.error };
  const there = await prisma.tankUnit.findMany({ where: { id: { in: snaps.map((s) => s.id) } }, select: { id: true } });
  if (there.length !== snaps.length) return { ok: false, error: "A tank was deleted since — it cannot be put back." };
  await prisma.$transaction(async (tx) => {
    for (const s of snaps) {
      await tx.tankUnit.update({
        where: { id: s.id },
        data: {
          status: s.status, weldLedgerId: s.weldLedgerId, paintLedgerId: s.paintLedgerId,
          weldedAt: new Date(s.weldedAt), weldedById: s.weldedById, weldedBy: s.weldedBy, weldedStamp: s.weldedStamp, weldedLogBy: s.weldedLogBy,
          testedAt: date(s.testedAt), testedById: s.testedById, testedBy: s.testedBy, testResult: s.testResult, testNote: s.testNote,
          paintedAt: date(s.paintedAt), paintedById: s.paintedById, paintedBy: s.paintedBy,
          qaAt: date(s.qaAt), qaById: s.qaById, qaBy: s.qaBy, qaResult: s.qaResult, qaNote: s.qaNote,
        },
      });
      await tx.tankEvent.deleteMany({ where: { tankId: s.id, id: { notIn: s.events } } });
    }
  });
  for (const p of ["/worklist/welding", "/worklist/leak-test", "/worklist/painting", "/barcode", "/trace", ...snaps.map((s) => `/tank/${s.serial}`)]) revalidatePath(p);
  return { ok: true };
}

// ----------------------------------------------------------------- ORDERS

/** Put an order's plan months back as they were (the undo of taking one off). */
export async function restoreOrderMonths(mo: string, months: string): Promise<RestoreResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const r = await prisma.masterOrder.updateMany({ where: { mo }, data: { months } });
  if (r.count === 0) return { ok: false, error: `${mo} is not in the registry any more.` };
  for (const p of ["/tracker", "/orders"]) revalidatePath(p);
  return { ok: true };
}

// ------------------------------------------------------------------ FLOOR

export interface FloorLayoutSnapshot {
  data: unknown;
  updatedBy: string | null;
}

/** A department's drawn floor as stored — null while nobody has drawn it. */
export async function readFloorLayout(dept: string): Promise<FloorLayoutSnapshot | null> {
  const row = await prisma.floorLayout.findUnique({ where: { dept } });
  return row ? { data: row.data, updatedBy: row.updatedBy } : null;
}

/** Put a department's floor back exactly — not drawn at all, if it was not. */
export async function restoreFloorLayout(dept: string, s: FloorLayoutSnapshot | null): Promise<RestoreResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  if (s === null) await prisma.floorLayout.deleteMany({ where: { dept } });
  else {
    const data = s.data as object;
    await prisma.floorLayout.upsert({ where: { dept }, create: { dept, data, updatedBy: s.updatedBy }, update: { data, updatedBy: s.updatedBy } });
  }
  for (const p of ["/simulate", "/shifts", "/worklist/welding", "/admin/machines"]) revalidatePath(p);
  return { ok: true };
}
