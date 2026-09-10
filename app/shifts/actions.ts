"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { parseISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, isShiftCode, isShiftDept, MACHINE_DEPTS, type ShiftDept } from "@/lib/domain/shifts";
import { syncDeptDayHours } from "@/lib/server/shifts";

// The shift log's writes. A day is saved whole: every worker of the
// department gets a row (present or not), so the day's man-hours are a
// plain sum and a worker added to the list later does not silently change
// a day already recorded. Downtime rows are added and removed one at a time.

export interface ShiftActionResult {
  ok: boolean;
  error?: string;
}

const PATHS = ["/shifts", "/admin/standard-times", "/report", "/tracker", "/"];

function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

function readDay(fd: FormData): { date: Date; dept: ShiftDept } | { error: string } {
  const date = parseISODate(String(fd.get("date") ?? ""));
  if (!date) return { error: "Pick a day." };
  if (date.getTime() > Date.now()) return { error: "That day has not come yet." };
  const dept = String(fd.get("dept") ?? "");
  if (!isShiftDept(dept)) return { error: "Pick a department." };
  return { date, dept };
}

/** Save one department's day: `lines` is the JSON the page built — one entry
 *  per worker with present / shift / overtime / machine / note. */
export async function saveShiftDay(fd: FormData): Promise<ShiftActionResult> {
  const day = readDay(fd);
  if ("error" in day) return { ok: false, error: day.error };
  const { date, dept } = day;
  const guard = await requirePerm(shiftPermKey(dept));
  if (guard.error) return { ok: false, error: guard.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(fd.get("lines") ?? "[]"));
  } catch {
    return { ok: false, error: "The day could not be read — reload the page and try again." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, error: "There is nobody on this department's list yet — add workers first." };

  const lines: { workerId: number; present: boolean; shift: string; overtimeH: number; machineId: number | null; note: string | null }[] = [];
  for (const raw of parsed as Record<string, unknown>[]) {
    const workerId = Number(raw.workerId);
    if (!Number.isInteger(workerId)) return { ok: false, error: "A row names no worker — reload the page." };
    const shift = String(raw.shift ?? DEFAULT_SHIFT);
    if (!isShiftCode(shift)) return { ok: false, error: `Unknown shift "${shift}".` };
    const overtimeH = Number(raw.overtimeH ?? 0);
    if (!Number.isFinite(overtimeH) || overtimeH < 0 || overtimeH > 12) return { ok: false, error: "Overtime must be between 0 and 12 hours." };
    const machineRaw = raw.machineId;
    const machineId = machineRaw === null || machineRaw === undefined || machineRaw === "" ? null : Number(machineRaw);
    if (machineId !== null && !Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
    lines.push({
      workerId, present: raw.present !== false, shift, overtimeH: Math.round(overtimeH * 2) / 2,
      machineId: MACHINE_DEPTS.includes(dept) ? machineId : null,
      note: String(raw.note ?? "").trim() || null,
    });
  }

  // every worker must be on the list; a machine must be this department's
  const [workers, machines] = await Promise.all([
    prisma.worker.findMany({ where: { id: { in: lines.map((l) => l.workerId) } }, select: { id: true } }),
    prisma.machine.findMany({ where: { dept }, select: { id: true } }),
  ]);
  const workerIds = new Set(workers.map((w) => w.id));
  const machineIds = new Set(machines.map((m) => m.id));
  for (const l of lines) {
    if (!workerIds.has(l.workerId)) return { ok: false, error: "A worker on the page is no longer on the list — reload the page." };
    if (l.machineId !== null && !machineIds.has(l.machineId)) return { ok: false, error: "That machine is not in this department — reload the page." };
  }

  const by = guard.user?.name ?? null;
  await prisma.$transaction(async (tx) => {
    for (const l of lines) {
      await tx.shiftEntry.upsert({
        where: { date_dept_workerId: { date, dept, workerId: l.workerId } },
        create: { date, dept, ...l, recordedBy: by },
        update: { present: l.present, shift: l.shift, overtimeH: l.overtimeH, machineId: l.machineId, note: l.note, recordedBy: by },
      });
    }
    await syncDeptDayHours(tx, date, dept);
  });
  revalidate();
  return { ok: true };
}

/** Forget a department's day entirely — its rows and its man-hours figure. */
export async function clearShiftDay(fd: FormData): Promise<ShiftActionResult> {
  const day = readDay(fd);
  if ("error" in day) return { ok: false, error: day.error };
  const { date, dept } = day;
  const guard = await requirePerm(shiftPermKey(dept));
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.$transaction(async (tx) => {
    await tx.shiftEntry.deleteMany({ where: { date, dept } });
    await syncDeptDayHours(tx, date, dept);
  });
  revalidate();
  return { ok: true };
}

/** Hours a machine stood still on the day, and why. */
export async function addDowntime(fd: FormData): Promise<ShiftActionResult> {
  const day = readDay(fd);
  if ("error" in day) return { ok: false, error: day.error };
  const { date, dept } = day;
  const guard = await requirePerm(shiftPermKey(dept));
  if (guard.error) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  const hours = Number(fd.get("hours"));
  const reason = String(fd.get("reason") ?? "").trim();
  if (!Number.isInteger(machineId)) return { ok: false, error: "Pick the machine." };
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return { ok: false, error: "Enter the hours it stood still (0–24)." };
  const machine = await prisma.machine.findUnique({ where: { id: machineId }, select: { dept: true } });
  if (!machine || machine.dept !== dept) return { ok: false, error: "That machine is not in this department." };
  await prisma.machineDowntime.create({ data: { date, machineId, hours: Math.round(hours * 2) / 2, reason: reason || null, recordedBy: guard.user?.name ?? null } });
  revalidate();
  return { ok: true };
}

export async function deleteDowntime(fd: FormData): Promise<ShiftActionResult> {
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid row." };
  const row = await prisma.machineDowntime.findUnique({ where: { id }, include: { machine: { select: { dept: true } } } });
  if (!row) return { ok: true };
  const guard = await requirePerm(shiftPermKey(row.machine.dept));
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.machineDowntime.delete({ where: { id } });
  revalidate();
  return { ok: true };
}
