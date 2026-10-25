"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { parseISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, isRosterDept, overtimeHoursFor, overtimeTime, isShiftCode, isWorkCentre, workerCentres, type RosterDept } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import { parseWorkerSections, workerDepts } from "@/lib/domain/workers";
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

const PATHS = ["/shifts", "/admin/standard-times", "/tracker", "/"];

function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

function readDate(fd: FormData): Date | { error: string } {
  const date = parseISODate(String(fd.get("date") ?? ""));
  if (!date) return { error: "Pick a day." };
  if (date.getTime() > Date.now()) return { error: "That day has not come yet." };
  return date;
}

type Line = { dept: RosterDept; workerId: number; present: boolean; shift: string; overtimeH: number; center: string | null; note: string | null };

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

  // a worker the page still shows as not set is never saved as absent
  const unset = (parsed as Record<string, unknown>[]).filter((raw) => raw?.recorded === false).length;
  if (unset > 0) return { ok: false, error: `${unset} worker(s) are not set yet — pick Day, Night or Absent for everyone, then save.` };

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
    if (roundedOvertime > 0 && Math.abs(roundedOvertime - overtimeHoursFor(shift, shiftHours)) > 0.001) {
      return { ok: false, error: `Overtime is the fixed ${overtimeHoursFor(shift, shiftHours)}-hour period (${overtimeTime(shift)}).` };
    }
    const present = raw.present !== false;
    // the work centre, where the department has several; anything else is none
    const rawCenter = String(raw.center ?? "");
    const own = workerCentres(dept);
    const center = own && isWorkCentre(rawCenter) && own.includes(rawCenter) ? rawCenter : null;
    if (rawCenter && own && !center) return { ok: false, error: `"${rawCenter}" is not a work centre of this department.` };
    lines.push({ dept, workerId, present, shift, overtimeH: present ? roundedOvertime : 0, center, note: String(raw.note ?? "").trim() || null });
  }

  const depts = [...new Set(lines.map((l) => l.dept))];
  let by: string | null = null;
  for (const d of depts) {
    const guard = await requirePerm(shiftPermKey(d));
    if (guard.error) return { ok: false, error: guard.error };
    by = guard.user?.name ?? by;
  }
  const workerIds = [...new Set(lines.map((l) => l.workerId))];
  const refused = await prisma.$transaction(async (tx) => {
    // A row is saved under a department the worker is registered in (and he
    // is still active) — the permission is per department — or under one the
    // day already has his row in: a worker moved or retired since keeps the
    // rows recorded then (getShiftRoster shows them). Checked with the writes.
    const workers = await tx.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, empId: true, name: true, active: true, depts: true } });
    const byId = new Map(workers.map((w) => [w.id, { ...w, depts: new Set<string>(w.active ? workerDepts(parseWorkerSections(w.depts)) : []) }]));
    const outside = lines.filter((l) => !byId.get(l.workerId)?.depts.has(l.dept));
    if (outside.length > 0) {
      const key = (r: { dept: string; workerId: number }) => `${r.dept}|${r.workerId}`;
      const recorded = await tx.shiftEntry.findMany({
        where: { date, dept: { in: [...new Set(outside.map((l) => l.dept))] }, workerId: { in: [...new Set(outside.map((l) => l.workerId))] } },
        select: { dept: true, workerId: true },
      });
      const keys = new Set(recorded.map(key));
      const bad = outside.find((l) => !keys.has(key(l)));
      if (bad) {
        const w = byId.get(bad.workerId);
        if (!w?.active) return "A worker on the page is no longer on the list — reload the page.";
        return `${w.empId} — ${w.name} is not registered in ${WORKER_DEPT_LABEL[bad.dept]} — reload the page.`;
      }
    }
    for (const l of lines) {
      await tx.shiftEntry.upsert({
        where: { date_dept_workerId: { date, dept: l.dept, workerId: l.workerId } },
        create: { date, dept: l.dept, workerId: l.workerId, present: l.present, shift: l.shift, overtimeH: l.overtimeH, center: l.center, note: l.note, recordedBy: by },
        update: { present: l.present, shift: l.shift, overtimeH: l.overtimeH, center: l.center, note: l.note, recordedBy: by },
      });
    }
    for (const d of depts) await syncDeptDayHours(tx, date, d);
    return null;
  });
  if (refused) return { ok: false, error: refused };
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
