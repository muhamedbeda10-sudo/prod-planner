"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { isRosterDept } from "@/lib/domain/shifts";
import { downtimeScope } from "@/lib/domain/downtime";

type DeleteResult = { ok: boolean; error?: string; attendance?: number; stops?: number; totals?: number };

/** Both entry points validate the entire request before any write. Never turn a bulk request into a range. */
async function removeDays(fd: FormData, values: unknown, single: boolean): Promise<DeleteResult> {
  if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "string")) return { ok: false, error: "Choose at least one recorded day." };
  const datesISO = [...new Set((values as string[]).map((v) => v.trim()))];
  const dates = datesISO.map(parseISODate);
  if (dates.some((d) => !d)) return { ok: false, error: "Pick real dates for every selected day." };
  const today = factoryDayISO(new Date());
  if (datesISO.some((d) => d > today)) return { ok: false, error: "A selected day has not come yet." };
  const date = single ? dates[0]! : { in: dates as Date[] };
  const raw = String(fd.get("depts") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!raw.length || raw.some((d) => !isRosterDept(d))) return { ok: false, error: "Choose the departments whose day should be deleted." };
  const depts = [...new Set(raw.filter(isRosterDept))];
  // Every scope is checked before any deletion; partial permission never deletes a partial day silently.
  for (const dept of depts) {
    const guard = await requirePerm(shiftPermKey(dept));
    if (guard.error) return { ok: false, error: guard.error };
  }
  try {
    const removed = await prisma.$transaction(async (tx) => {
      const attendance = await tx.shiftEntry.deleteMany({ where: { date, dept: { in: depts } } });
      const stops = await tx.machineDowntime.deleteMany({ where: { date, ...downtimeScope(depts) } });
      const totals = await tx.deptDayHours.deleteMany({ where: { date, dept: { in: depts } } });
      return { attendance: attendance.count, stops: stops.count, totals: totals.count };
    }, { isolationLevel: "Serializable" });
    for (const path of ["/shifts", "/", "/admin/standard-times", "/admin/machine-times", "/report", "/tracker", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/punching", "/worklist/bending", "/worklist/machines"]) revalidatePath(path);
    return { ok: true, ...removed };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, error: "The selected records changed at the same time. Reload and try again." };
    throw error;
  }
}

/** Delete only the selected departments' shift-log data, atomically. Production output and worker profiles are separate records. */
export async function deleteRecordedShiftDay(fd: FormData): Promise<DeleteResult> {
  return removeDays(fd, [String(fd.get("date") ?? "")], true);
}

/** Exact-date bulk deletion: one permission-checked transaction, no partial success. */
export async function deleteRecordedShiftDays(fd: FormData): Promise<DeleteResult> {
  let dates: unknown;
  try { dates = JSON.parse(String(fd.get("dates") ?? "")); }
  catch { return { ok: false, error: "Choose valid recorded days." }; }
  return removeDays(fd, dates, false);
}
