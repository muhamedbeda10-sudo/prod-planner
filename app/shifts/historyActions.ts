"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { isRosterDept } from "@/lib/domain/shifts";

/** Delete only the selected departments' shift-log data, atomically. Production output and worker profiles are separate records. */
export async function deleteRecordedShiftDay(fd: FormData): Promise<{ ok: boolean; error?: string; attendance?: number; stops?: number; totals?: number }> {
  const dateISO = String(fd.get("date") ?? "").trim();
  const date = parseISODate(dateISO);
  if (!date) return { ok: false, error: "Pick a real day." };
  if (dateISO > factoryDayISO(new Date())) return { ok: false, error: "That day has not come yet." };
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
      const stops = await tx.machineDowntime.deleteMany({ where: { date, machine: { dept: { in: depts } } } });
      const totals = await tx.deptDayHours.deleteMany({ where: { date, dept: { in: depts } } });
      return { attendance: attendance.count, stops: stops.count, totals: totals.count };
    }, { isolationLevel: "Serializable" });
    for (const path of ["/shifts", "/", "/admin/standard-times", "/admin/machine-times", "/report", "/tracker", "/simulate", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/punching", "/worklist/bending", "/worklist/machines"]) revalidatePath(path);
    return { ok: true, ...removed };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, error: "The day's records changed at the same time. Reload and try again." };
    throw error;
  }
}
