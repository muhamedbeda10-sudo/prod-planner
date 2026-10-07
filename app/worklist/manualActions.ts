"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireDeptEdit } from "@/lib/server/auth";
import { MANUAL_BOM, MANUAL_ITEM, manualMo } from "@/lib/domain/manualJob";
import { normalizeMaterialType, normalizeSheetSize } from "@/lib/domain/material";

// Jobs from outside the plan, put on a machine by hand. The dept's worklist
// permission covers them, the same as putting a plan line on a machine.

export interface ManualActionResult {
  ok: boolean;
  error?: string;
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

/** Type a job in and put it on a machine at the back of its queue (an idle
 *  machine starts on it). Without a machine it is only saved to the list. */
export async function createManualJob(fd: FormData): Promise<ManualActionResult> {
  const dept = text(fd, "dept");
  if (!(DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  const title = text(fd, "title", 120);
  if (!title) return { ok: false, error: "Say what the job is." };
  const qty = Number(text(fd, "qty"));
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Pieces must be a whole number above 0." };
  const thicknessMm = num(fd, "thicknessMm");
  const sheets = num(fd, "sheets");
  if (thicknessMm === "bad") return { ok: false, error: "Thickness must be a number of mm." };
  if (sheets === "bad") return { ok: false, error: "Sheets must be a number." };

  let machineId: number | null = null;
  const rawMachine = text(fd, "machineId");
  if (rawMachine) {
    machineId = Number(rawMachine);
    const machine = Number.isInteger(machineId) ? await prisma.machine.findUnique({ where: { id: machineId } }) : null;
    if (!machine || machine.dept !== dept) return { ok: false, error: "That machine is not in this department." };
    if (!machine.active) return { ok: false, error: `${machine.code} is retired.` };
  }

  const by = guard.user?.name ?? null;
  await prisma.$transaction(async (tx) => {
    const job = await tx.manualJob.create({
      data: {
        dept, title, qty, machineId, createdBy: by,
        bom: text(fd, "bom", 60), item: text(fd, "item", 60),
        material: normalizeMaterialType(text(fd, "material", 60)),
        thicknessMm, sheetSize: normalizeSheetSize(text(fd, "sheetSize", 40)), sheets,
        note: text(fd, "note", 500) || null,
      },
    });
    if (machineId === null) return;
    const [last, runningNow] = await Promise.all([
      tx.worklistMachine.aggregate({ where: { dept, machineId }, _max: { rank: true } }),
      tx.worklistMachine.count({ where: { dept, machineId, running: true } }),
    ]);
    await tx.worklistMachine.create({
      data: { dept, bom: MANUAL_BOM, mo: manualMo(job.id), item: MANUAL_ITEM, machineId, rank: (last._max.rank ?? 0) + 1, running: runningNow === 0, qty: null, setBy: by },
    });
  });
  revalidate();
  return { ok: true };
}

/** ✓ on a manual job's card: the pieces finished go on the job, never in the
 *  plan's ledger. When it is all done it leaves every machine and stays in
 *  the list as finished. */
export async function recordManualDone(fd: FormData): Promise<ManualActionResult> {
  const id = Number(text(fd, "id"));
  const job = Number.isInteger(id) ? await prisma.manualJob.findUnique({ where: { id } }) : null;
  if (!job) return { ok: false, error: "That job is gone — reload the page." };
  const guard = await requireDeptEdit(job.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const qty = Number(text(fd, "qty"));
  const left = job.qty - job.doneQty;
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Enter whole pieces above 0." };
  if (qty > left) return { ok: false, error: `Only ${left} left on this job.` };
  const machineId = Number(text(fd, "machineId")) || null;
  const doneQty = job.doneQty + qty;
  const finished = doneQty >= job.qty;
  const key = { dept: job.dept, bom: MANUAL_BOM, mo: manualMo(job.id), item: MANUAL_ITEM };
  await prisma.$transaction(async (tx) => {
    await tx.manualJob.update({ where: { id }, data: { doneQty, doneAt: finished ? new Date() : null, ...(machineId ? { machineId } : {}) } });
    if (finished) {
      await tx.worklistMachine.deleteMany({ where: key });
      return;
    }
    // a fixed share on this machine shrinks by what it finished
    if (machineId) {
      const row = await tx.worklistMachine.findFirst({ where: { ...key, machineId } });
      if (row && row.qty !== null) {
        if (row.qty - qty > 0) await tx.worklistMachine.update({ where: { id: row.id }, data: { qty: row.qty - qty } });
        else await tx.worklistMachine.delete({ where: { id: row.id } });
      }
    }
  });
  revalidate();
  return { ok: true };
}

/** Open a finished job again (more pieces are wanted, or it was ticked by
 *  mistake) — back in the list as open, off every machine until it is put on one. */
export async function reopenManualJob(fd: FormData): Promise<ManualActionResult> {
  const id = Number(text(fd, "id"));
  const job = Number.isInteger(id) ? await prisma.manualJob.findUnique({ where: { id } }) : null;
  if (!job) return { ok: false, error: "That job is gone — reload the page." };
  const guard = await requireDeptEdit(job.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const more = Number(text(fd, "more") || "0");
  if (!Number.isInteger(more) || more < 0) return { ok: false, error: "Extra pieces must be a whole number." };
  const qty = job.qty + more;
  if (qty - job.doneQty <= 0) return { ok: false, error: "Nothing would be left to make — add the extra pieces wanted." };
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
