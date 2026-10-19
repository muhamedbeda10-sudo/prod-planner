"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireDeptEdit } from "@/lib/server/auth";
import { MANUAL_BOM, MANUAL_ITEM, SHEET_COUNT_RULE, editedJobQty, isSheetCount, jobSheetKey, jobsBySheet, manualMo, readJobParts, roundSheets, typedCount, type ManualJobPartView } from "@/lib/domain/manualJob";
import { normalizeMaterialType, normalizeSheetSize } from "@/lib/domain/material";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { partsWithPlanBoms } from "@/lib/server/manualJobs";

// Jobs from outside the plan, put on a machine by hand. The dept's worklist
// permission covers them, the same as putting a plan line on a machine.
// Fabrication's are SHEET JOBS: typed, queued, split and closed in sheets —
// part of a sheet too, to the hundredth (2.5) — with the parts of the
// projects the sheets carry.

export interface ManualActionResult {
  ok: boolean;
  error?: string;
  /** The job made (createManualJob). */
  id?: number;
}

const DEPTS = ["Cut", "Welding", "Painting", "ShotBlast"] as const;

function revalidate() {
  for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/machines", "/simulate", "/shifts"]) revalidatePath(p);
}

const text = (fd: FormData, k: string, max = 200) => String(fd.get(k) ?? "").trim().slice(0, max);
const num = (fd: FormData, k: string): number | null | "bad" => {
  const raw = text(fd, k);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : "bad";
};

type SheetJobForm = {
  title: string;
  sheets: number;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  parts: Omit<ManualJobPartView, "id">[];
  note: string | null;
};

/** A sheet job as the form sends it — the sheet, how many, and every
 *  project's part on them — checked, a BOM the plan carries written as the
 *  plan writes it (any other kept as typed); or what is wrong with it. */
async function readSheetJob(fd: FormData): Promise<SheetJobForm | { error: string }> {
  const sheets = typedCount(text(fd, "qty"));
  if (!isSheetCount(sheets)) return { error: `Sheets must be ${SHEET_COUNT_RULE}.` };
  const thicknessMm = Number(text(fd, "thicknessMm"));
  if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) return { error: "Thickness must be a number of mm above 0." };
  const material = normalizeMaterialType(text(fd, "material", 60));
  if (!material) return { error: "Say the sheet's material." };
  let raw: unknown;
  try { raw = JSON.parse(String(fd.get("parts") ?? "[]")); } catch { return { error: "The parts list could not be read — reload the page." }; }
  const read = readJobParts(raw);
  if (!read.ok) return { error: read.error };
  // any project may be typed; one the plan carries is kept in the plan's spelling
  const { parts } = await partsWithPlanBoms(read.parts);
  return {
    title: text(fd, "title", 120), sheets, material, thicknessMm,
    sheetSize: normalizeSheetSize(text(fd, "sheetSize", 40)), parts, note: text(fd, "note", 500) || null,
  };
}

/** A machine of the department a job may be put on, or what is wrong with it. */
async function jobMachine(fd: FormData, dept: string): Promise<{ machineId: number | null } | { error: string }> {
  const raw = text(fd, "machineId");
  if (!raw) return { machineId: null };
  const machineId = Number(raw);
  const machine = Number.isInteger(machineId) ? await prisma.machine.findUnique({ where: { id: machineId } }) : null;
  if (!machine || machine.dept !== dept) return { error: "That machine is not in this department." };
  if (!machine.active) return { error: `${machine.code} is retired.` };
  return { machineId };
}

/** A job typed in pieces on the fabrication board, before it counted sheets —
 *  kept as it was, not changed in pieces again. */
const PIECES_JOB = "This job was typed in pieces, before the fabrication board counted sheets — ⧉ Duplicate it into a sheet job instead.";

/** Type a job in and put it on a machine at the back of its queue (an idle
 *  machine starts on it). Without a machine it is only saved to the list. */
export async function createManualJob(fd: FormData): Promise<ManualActionResult> {
  const dept = text(fd, "dept");
  if (!(DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  const by = guard.user?.name ?? null;
  const where = await jobMachine(fd, dept);
  if ("error" in where) return { ok: false, error: where.error };
  const { machineId } = where;

  let data: Parameters<typeof prisma.manualJob.create>[0]["data"];
  let parts: SheetJobForm["parts"] = [];
  if (jobsBySheet(dept)) {
    const form = await readSheetJob(fd);
    if ("error" in form) return { ok: false, error: form.error };
    parts = form.parts;
    data = {
      dept, bySheet: true, title: form.title, qty: form.sheets, machineId, createdBy: by,
      material: form.material, thicknessMm: form.thicknessMm, sheetSize: form.sheetSize, note: form.note,
    };
  } else {
    const title = text(fd, "title", 120);
    if (!title) return { ok: false, error: "Say what the job is." };
    const qty = Number(text(fd, "qty"));
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Pieces must be a whole number above 0." };
    const thicknessMm = num(fd, "thicknessMm");
    const sheets = num(fd, "sheets");
    if (thicknessMm === "bad") return { ok: false, error: "Thickness must be a number of mm." };
    if (sheets === "bad") return { ok: false, error: "Sheets must be a number." };
    data = {
      dept, title, qty, machineId, createdBy: by,
      bom: text(fd, "bom", 60), item: text(fd, "item", 60),
      material: normalizeMaterialType(text(fd, "material", 60)),
      thicknessMm, sheetSize: normalizeSheetSize(text(fd, "sheetSize", 40)), sheets,
      note: text(fd, "note", 500) || null,
    };
  }

  const id = await prisma.$transaction(async (tx) => {
    const job = await tx.manualJob.create({ data: { ...data, ...(parts.length > 0 ? { parts: { create: parts } } : {}) } });
    if (machineId === null) return job.id;
    const [last, runningNow] = await Promise.all([
      tx.worklistMachine.aggregate({ where: { dept, machineId }, _max: { rank: true } }),
      tx.worklistMachine.count({ where: { dept, machineId, running: true } }),
    ]);
    await tx.worklistMachine.create({
      data: { dept, bom: MANUAL_BOM, mo: manualMo(job.id), item: MANUAL_ITEM, machineId, rank: (last._max.rank ?? 0) + 1, running: runningNow === 0, qty: null, setBy: by },
    });
    return job.id;
  });
  revalidate();
  return { ok: true, id };
}

/** ✎ Change a job as it was typed — what it is, the count wanted, its BOM
 *  and part (a sheet job: its parts), the sheet and the note. Where it is
 *  queued stays as it is (Move to… moves it). Fewer than are done is
 *  refused; exactly the count done finishes it; more opens a finished one
 *  again, on no machine until it is put on one. A fixed share on a machine
 *  never asks for more than is left. */
export async function updateManualJob(fd: FormData): Promise<ManualActionResult> {
  const id = Number(text(fd, "id"));
  const job = Number.isInteger(id) ? await prisma.manualJob.findUnique({ where: { id } }) : null;
  if (!job) return { ok: false, error: "That job is gone — reload the page." };
  const guard = await requireDeptEdit(job.dept);
  if (guard.error) return { ok: false, error: guard.error };
  if (jobsBySheet(job.dept) && !job.bySheet) return { ok: false, error: PIECES_JOB };

  let data: Parameters<typeof prisma.manualJob.update>[0]["data"];
  let parts: SheetJobForm["parts"] | null = null;
  let qty: number;
  if (job.bySheet) {
    const form = await readSheetJob(fd);
    if ("error" in form) return { ok: false, error: form.error };
    qty = form.sheets;
    parts = form.parts;
    data = { title: form.title, qty, material: form.material, thicknessMm: form.thicknessMm, sheetSize: form.sheetSize, note: form.note };
  } else {
    const title = text(fd, "title", 120);
    if (!title) return { ok: false, error: "Say what the job is." };
    qty = Number(text(fd, "qty"));
    const thicknessMm = num(fd, "thicknessMm");
    const sheets = num(fd, "sheets");
    if (thicknessMm === "bad") return { ok: false, error: "Thickness must be a number of mm." };
    if (sheets === "bad") return { ok: false, error: "Sheets must be a number." };
    data = {
      title, qty,
      bom: text(fd, "bom", 60), item: text(fd, "item", 60),
      material: normalizeMaterialType(text(fd, "material", 60)),
      thicknessMm, sheetSize: normalizeSheetSize(text(fd, "sheetSize", 40)), sheets,
      note: text(fd, "note", 500) || null,
    };
  }
  const edit = editedJobQty(job.doneQty, qty, job.bySheet);
  if (!edit.ok) return { ok: false, error: edit.error };

  const key = { dept: job.dept, bom: MANUAL_BOM, mo: manualMo(job.id), item: MANUAL_ITEM };
  const wasDone = job.doneAt !== null;
  const left = roundSheets(qty - job.doneQty);
  await prisma.$transaction(async (tx) => {
    await tx.manualJob.update({ where: { id }, data: { ...data, doneAt: edit.finished ? job.doneAt ?? new Date() : null } });
    if (parts !== null) {
      await tx.manualJobPart.deleteMany({ where: { jobId: id } });
      if (parts.length > 0) await tx.manualJobPart.createMany({ data: parts.map((p) => ({ ...p, jobId: id })) });
    }
    // finished now — or opened again from finished — it is on no machine
    if (edit.finished || wasDone) {
      await tx.worklistMachine.deleteMany({ where: key });
      return;
    }
    await tx.worklistMachine.updateMany({ where: { ...key, qty: { gt: left } }, data: { qty: left } });
  });
  revalidate();
  return { ok: true };
}

/** ✓ on a manual job's card: the pieces finished — on a sheet job, the
 *  SHEETS cut on that machine — go on the job, never in the plan's ledger.
 *  A sheet job's sheets also go on the sheet cut log with the machine and
 *  the day. When it is all done it leaves every machine and stays in the
 *  list as finished. */
export async function recordManualDone(fd: FormData): Promise<ManualActionResult> {
  const id = Number(text(fd, "id"));
  const job = Number.isInteger(id) ? await prisma.manualJob.findUnique({ where: { id } }) : null;
  if (!job) return { ok: false, error: "That job is gone — reload the page." };
  const guard = await requireDeptEdit(job.dept);
  if (guard.error) return { ok: false, error: guard.error };
  if (jobsBySheet(job.dept) && !job.bySheet) return { ok: false, error: PIECES_JOB };
  const qty = job.bySheet ? typedCount(text(fd, "qty")) : Number(text(fd, "qty"));
  const left = roundSheets(job.qty - job.doneQty);
  if (job.bySheet ? !isSheetCount(qty) : !Number.isInteger(qty) || qty <= 0) return { ok: false, error: job.bySheet ? `Enter the sheets cut — ${SHEET_COUNT_RULE}.` : "Enter whole pieces above 0." };
  if (qty > left) return { ok: false, error: job.bySheet ? `Only ${left} sheet(s) left on this job.` : `Only ${left} left on this job.` };
  const machineId = Number(text(fd, "machineId")) || null;
  const date = parseISODate(text(fd, "date")) ?? parseISODate(factoryDayISO(new Date()))!;
  const doneQty = roundSheets(job.doneQty + qty);
  const finished = doneQty >= roundSheets(job.qty);
  const key = { dept: job.dept, bom: MANUAL_BOM, mo: manualMo(job.id), item: MANUAL_ITEM };
  const by = guard.user?.name ?? null;
  const stale = await prisma.$transaction(async (tx) => {
    // only on the count this ✓ was checked against: two ticks at once on the
    // same job must not both land on what was left before either
    const moved = await tx.manualJob.updateMany({ where: { id, doneQty: job.doneQty }, data: { doneQty, doneAt: finished ? new Date() : null, ...(machineId ? { machineId } : {}) } });
    if (moved.count === 0) return true;
    // kept for good: the sheets each machine cut, at what thickness
    if (job.bySheet) {
      await tx.sheetCutLog.create({
        data: { date, ...key, sheet: jobSheetKey(job), thicknessMm: job.thicknessMm, machineId, qty, createdBy: by },
      });
    }
    if (finished) {
      await tx.worklistMachine.deleteMany({ where: key });
      return false;
    }
    // a fixed share on this machine shrinks by what it finished
    if (machineId) {
      const row = await tx.worklistMachine.findFirst({ where: { ...key, machineId } });
      if (row && row.qty !== null) {
        const keep = roundSheets(row.qty - qty);
        if (keep > 0) await tx.worklistMachine.update({ where: { id: row.id }, data: { qty: keep } });
        else await tx.worklistMachine.delete({ where: { id: row.id } });
      }
    }
    return false;
  });
  if (stale) return { ok: false, error: "Someone recorded on this job a moment ago — reload the page and check what is left." };
  revalidate();
  return { ok: true };
}

/** Open a finished job again (more pieces — a sheet job's sheets — are
 *  wanted, or it was ticked by mistake) — back in the list as open, off
 *  every machine until it is put on one. */
export async function reopenManualJob(fd: FormData): Promise<ManualActionResult> {
  const id = Number(text(fd, "id"));
  const job = Number.isInteger(id) ? await prisma.manualJob.findUnique({ where: { id } }) : null;
  if (!job) return { ok: false, error: "That job is gone — reload the page." };
  const guard = await requireDeptEdit(job.dept);
  if (guard.error) return { ok: false, error: guard.error };
  if (jobsBySheet(job.dept) && !job.bySheet) return { ok: false, error: PIECES_JOB };
  const unit = job.bySheet ? "sheets" : "pieces";
  const more = job.bySheet ? typedCount(text(fd, "more")) : Number(text(fd, "more") || "0");
  if (job.bySheet ? more !== 0 && !isSheetCount(more) : !Number.isInteger(more) || more < 0) {
    return { ok: false, error: job.bySheet ? `Extra sheets must be ${SHEET_COUNT_RULE} — or 0.` : "Extra pieces must be a whole number." };
  }
  const qty = roundSheets(job.qty + more);
  if (roundSheets(qty - job.doneQty) <= 0) return { ok: false, error: `Nothing would be left to make — add the extra ${unit} wanted.` };
  await prisma.manualJob.update({ where: { id }, data: { qty, doneAt: null } });
  revalidate();
  return { ok: true };
}

/** Delete a job typed by mistake — off every machine and out of the list. */
export async function deleteManualJob(fd: FormData): Promise<ManualActionResult> {
  const id = Number(text(fd, "id"));
  const job = Number.isInteger(id) ? await prisma.manualJob.findUnique({ where: { id } }) : null;
  if (!job) return { ok: true };
  const guard = await requireDeptEdit(job.dept);
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.$transaction([
    prisma.worklistMachine.deleteMany({ where: { dept: job.dept, bom: MANUAL_BOM, mo: manualMo(job.id), item: MANUAL_ITEM } }),
    prisma.manualJob.delete({ where: { id } }),
  ]);
  revalidate();
  return { ok: true };
}
