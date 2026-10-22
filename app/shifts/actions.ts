"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { parseISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, isRosterDept, isShiftCode, type RosterDept } from "@/lib/domain/shifts";
import { syncDeptDayHours } from "@/lib/server/shifts";
import { getShiftHours } from "@/lib/server/data";

// The shift roster's writes. A day is saved whole per department: every
// worker of the department gets a row (present or not), so the day's
// man-hours are a plain sum and a worker added to the list later does not
// silently change a day already recorded.

export interface ShiftActionResult {
  ok: boolean;
  error?: string;
}

const PATHS = ["/shifts", "/admin/standard-times", "/report", "/tracker", "/"];

function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

function readDate(fd: FormData): Date | { error: string } {
  const date = parseISODate(String(fd.get("date") ?? ""));
  if (!date) return { error: "Pick a day." };
  if (date.getTime() > Date.now()) return { error: "That day has not come yet." };
  return date;
}

type Line = { dept: RosterDept; workerId: number; present: boolean; shift: string; overtimeH: number; note: string | null };

/** Save the day: `lines` is the JSON the page built — one entry per worker
 *  and department with present / shift / overtime / note. Every department
 *  in it needs its own permission; each is rewritten whole. */
export async function saveShiftRoster(fd: FormData): Promise<ShiftActionResult> {
  const date = readDate(fd);
  if (!(date instanceof Date)) return { ok: false, error: date.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(fd.get("lines") ?? "[]"));
  } catch {
    return { ok: false, error: "The day could not be read — reload the page and try again." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, error: "There is nobody on the list yet — add workers first." };

  const shiftHours = await getShiftHours();
  const lines: Line[] = [];
  for (const raw of parsed as Record<string, unknown>[]) {
    const workerId = Number(raw.workerId);
    const dept = String(raw.dept ?? "");
    if (!Number.isInteger(workerId) || !isRosterDept(dept)) return { ok: false, error: "A row names no worker or department — reload the page." };
    const shift = String(raw.shift ?? DEFAULT_SHIFT);
    if (!isShiftCode(shift)) return { ok: false, error: `Unknown shift "${shift}".` };
    const overtimeH = Number(raw.overtimeH ?? 0);
    if (!Number.isFinite(overtimeH) || overtimeH < 0 || overtimeH > 12) return { ok: false, error: "Overtime must be between 0 and 12 hours." };
    const roundedOvertime = Math.round(overtimeH * 2) / 2;
    if (shift !== DEFAULT_SHIFT && roundedOvertime > 0) return { ok: false, error: "Overtime is available to the day shift only." };
    if (roundedOvertime > 0 && Math.abs(roundedOvertime - shiftHours.overtime) > 0.001) {
      return { ok: false, error: `Overtime is the fixed ${shiftHours.overtime}-hour period from 16:00 to 19:00.` };
    }
    const present = raw.present !== false;
    lines.push({ dept, workerId, present, shift, overtimeH: present ? roundedOvertime : 0, note: String(raw.note ?? "").trim() || null });
  }

  const depts = [...new Set(lines.map((l) => l.dept))];
  let by: string | null = null;
  for (const d of depts) {
    const guard = await requirePerm(shiftPermKey(d));
    if (guard.error) return { ok: false, error: guard.error };
    by = guard.user?.name ?? by;
  }
  const workers = await prisma.worker.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.workerId))] } }, select: { id: true } });
  const workerIds = new Set(workers.map((w) => w.id));
  if (lines.some((l) => !workerIds.has(l.workerId))) return { ok: false, error: "A worker on the page is no longer on the list — reload the page." };

  await prisma.$transaction(async (tx) => {
    for (const l of lines) {
      await tx.shiftEntry.upsert({
        where: { date_dept_workerId: { date, dept: l.dept, workerId: l.workerId } },
        create: { date, dept: l.dept, workerId: l.workerId, present: l.present, shift: l.shift, overtimeH: l.overtimeH, note: l.note, recordedBy: by },
        update: { present: l.present, shift: l.shift, overtimeH: l.overtimeH, note: l.note, recordedBy: by },
      });
    }
    for (const d of depts) await syncDeptDayHours(tx, date, d);
  });
  revalidate();
  return { ok: true };
}

/** Forget the given departments' day entirely — their rows and man-hours. */
export async function clearShiftDay(fd: FormData): Promise<ShiftActionResult> {
  const date = readDate(fd);
  if (!(date instanceof Date)) return { ok: false, error: date.error };
  const depts = String(fd.get("depts") ?? "").split(",").map((s) => s.trim()).filter(isRosterDept);
  if (depts.length === 0) return { ok: false, error: "Pick a department." };
  for (const d of depts) {
    const guard = await requirePerm(shiftPermKey(d));
    if (guard.error) return { ok: false, error: guard.error };
  }
  await prisma.$transaction(async (tx) => {
    await tx.shiftEntry.deleteMany({ where: { date, dept: { in: depts } } });
    for (const d of depts) await syncDeptDayHours(tx, date, d);
  });
  revalidate();
  return { ok: true };
}
