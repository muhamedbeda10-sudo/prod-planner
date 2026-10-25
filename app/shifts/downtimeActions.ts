"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type MachineDowntime } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { deptCentre, isRosterDept, workerCentres } from "@/lib/domain/shifts";
import { MAX_STOP_HOURS, clockMinutes, downtimeLabel, isDowntimeCode, stopHours, stopTiming } from "@/lib/domain/downtime";
import { emitEvent } from "@/lib/server/events";

export interface DowntimeActionResult { ok: boolean; error?: string; id?: number; hours?: number }
const PATHS = ["/shifts", "/", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/machines", "/simulate"];
const revalidate = () => { for (const p of PATHS) revalidatePath(p); };

type Target = { fields: { machineId: number } | { machineId: null; customName: string; customDept: string; customCentre: string | null }; label: string; dept: string; by: string | null; active: boolean };
async function machineGuard(machineId: number): Promise<Target | { error: string }> {
  const machine = await prisma.machine.findUnique({ where: { id: machineId } });
  if (!machine) return { error: "That machine is not on the list — reload the page." };
  if (!isRosterDept(machine.dept)) return { error: `${machine.code} belongs to no department the shift log records.` };
  const guard = await requirePerm(shiftPermKey(machine.dept));
  if (guard.error) return { error: guard.error };
  return { fields: { machineId }, label: machine.code, dept: machine.dept, by: guard.user?.name ?? null, active: machine.active };
}
async function customGuard(name: string, dept: string, centre: string): Promise<Target | { error: string }> {
  const customName = name.trim().replace(/\s+/g, " ");
  if (!customName || customName.length > 120) return { error: "Give the equipment's name (up to 120 characters)." };
  if (!isRosterDept(dept)) return { error: "Choose this equipment's department." };
  const guard = await requirePerm(shiftPermKey(dept));
  if (guard.error) return { error: guard.error };
  const centres = workerCentres(dept);
  if (centres && !centres.some((c) => c === centre)) return { error: "Choose the equipment's work centre." };
  const customCentre = centres ? centre : deptCentre(dept);
  return { fields: { machineId: null, customName, customDept: dept, customCentre }, label: customName, dept, by: guard.user?.name ?? null, active: true };
}
async function targetOf(fd: FormData) {
  const id = String(fd.get("machineId") ?? "").trim();
  const name = String(fd.get("customName") ?? "");
  if (id === "custom" || (!id && name.trim())) return customGuard(name, String(fd.get("customDept") ?? ""), String(fd.get("customCentre") ?? ""));
  if (name.trim()) return { error: "Choose a listed machine or a named unlisted asset, not both." };
  const machineId = Number(id);
  return Number.isInteger(machineId) && machineId > 0 ? machineGuard(machineId) : { error: "Pick the equipment that stopped." };
}
async function targetOfRow(row: MachineDowntime) {
  return row.machineId !== null ? machineGuard(row.machineId) : customGuard(row.customName ?? "", row.customDept ?? "", row.customCentre ?? "");
}
function equipmentWhere(target: Target): Prisma.MachineDowntimeWhereInput {
  const f = target.fields;
  return f.machineId !== null ? { machineId: f.machineId } : { machineId: null, customDept: f.customDept, customName: { equals: f.customName, mode: "insensitive" } };
}
type Duration = { hours: number; startTime?: string; endTime?: string; endsNextDay?: boolean };
function durationOf(fd: FormData): Duration | { error: string } {
  const start = String(fd.get("startTime") ?? "").trim(), end = String(fd.get("endTime") ?? "").trim();
  if (start || end) {
    const flag = fd.get("endsNextDay");
    if (flag !== null && !["true", "false", "on", ""].includes(String(flag))) return { error: "Choose whether the end is on the next day." };
    const timing = stopTiming(start, end, flag === null ? undefined : flag === "true" || flag === "on");
    return timing ? { hours: timing.hours, startTime: start, endTime: end, endsNextDay: timing.endsNextDay } : { error: "Choose valid start/end times, after the start and within 24 hours. Tick next day for an overnight stop." };
  }
  if (fd.get("endsNextDay") === "true" || fd.get("endsNextDay") === "on") return { error: "Give both clock times for a next-day end." };
  // Backward compatibility for historical duration-only records and existing AI calls.
  const hours = stopHours(Number(String(fd.get("hours") ?? "").trim()));
  if (!Number.isFinite(hours) || hours <= 0) return { error: "Choose start and end times (legacy durations need a quarter of an hour at least)." };
  return hours <= MAX_STOP_HOURS ? { hours } : { error: `A machine cannot stand more than ${MAX_STOP_HOURS} hours in a day.` };
}
/** Checks adjacent days too: an overnight stop must not overlap tomorrow's first stop. */
async function checkStop(tx: Prisma.TransactionClient, target: Target, date: Date, duration: Duration, excludeId?: number) {
  const equipment = equipmentWhere(target), exclude = excludeId ? { id: { not: excludeId } } : {};
  const before = await tx.machineDowntime.aggregate({ where: { date, ...equipment, ...exclude }, _sum: { hours: true } });
  if ((before._sum.hours ?? 0) + duration.hours > MAX_STOP_HOURS + 1e-8) return `${target.label} already has ${before._sum.hours} h of stops that day — the total would be more than the day.`;
  if (!duration.startTime || !duration.endTime) return null;
  const start = date.getTime() / 60000 + clockMinutes(duration.startTime)!;
  const end = start + duration.hours * 60;
  const rows = await tx.machineDowntime.findMany({ where: { ...equipment, ...exclude, date: { gte: new Date(date.getTime() - 86400000), lte: new Date(date.getTime() + 86400000) } }, select: { date: true, startTime: true, endTime: true, endsNextDay: true } });
  for (const row of rows) {
    const timing = row.startTime && row.endTime ? stopTiming(row.startTime, row.endTime, row.endsNextDay) : null;
    if (!timing) continue;
    const otherStart = row.date.getTime() / 60000 + clockMinutes(timing.startTime)!;
    if (start < otherStart + timing.minutes && end > otherStart) return "This equipment already has a stop overlapping those times. Edit that record or choose another time range.";
  }
  return null;
}
export async function addDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const dateISO = String(fd.get("date") ?? "").trim(), date = parseISODate(dateISO);
  if (!date) return { ok: false, error: "Pick a day." };
  if (dateISO > factoryDayISO(new Date())) return { ok: false, error: "That day has not come yet." };
  const duration = durationOf(fd);
  if ("error" in duration) return { ok: false, error: duration.error };
  const reasonCode = String(fd.get("reasonCode") ?? "");
  if (!isDowntimeCode(reasonCode)) return { ok: false, error: "Pick why it stopped." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200) || null;
  const target = await targetOf(fd);
  if ("error" in target) return { ok: false, error: target.error };
  if (!target.active) return { ok: false, error: `${target.label} is retired — bring it back under Machines & lines first.` };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const error = await checkStop(tx, target, date, duration);
      if (error) return { ok: false, error };
      const row = await tx.machineDowntime.create({ data: { date, ...target.fields, ...duration, reasonCode, reason, recordedBy: target.by } });
      return { ok: true, id: row.id, hours: duration.hours };
    }, { isolationLevel: "Serializable" });
    if (!result.ok) return result;
    await emitEvent({ type: "machine.stopped", subject: target.label, summary: `${target.label} stood ${duration.hours} h on ${dateISO} — ${downtimeLabel(reasonCode)}${reason ? `: ${reason}` : ""}`, data: { machine: target.label, dept: target.dept, hours: duration.hours, reasonCode, date: dateISO } });
    revalidate();
    return result;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return { ok: false, error: "Someone changed this equipment's stops at the same moment — reload and try again." };
    throw e;
  }
}
export async function deleteDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Pick the stop to delete." };
  const row = await prisma.machineDowntime.findUnique({ where: { id } });
  if (!row) return { ok: false, error: "That stop is already gone — reload the page." };
  const target = await targetOfRow(row);
  if ("error" in target) return { ok: false, error: target.error };
  const { count } = await prisma.machineDowntime.deleteMany({ where: { id } });
  if (!count) return { ok: false, error: "That stop is already gone — reload the page." };
  revalidate(); return { ok: true, id };
}
/** Machine/name/department and factory day stay attached to the original record. */
export async function updateDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Pick the stop to edit." };
  const row = await prisma.machineDowntime.findUnique({ where: { id } });
  if (!row) return { ok: false, error: "That stop is already gone — reload the page." };
  const target = await targetOfRow(row);
  if ("error" in target) return { ok: false, error: target.error };
  if (row.date.toISOString().slice(0, 10) > factoryDayISO(new Date())) return { ok: false, error: "That day has not come yet." };
  const original = { hours: row.hours, reasonCode: row.reasonCode, reason: row.reason, startTime: row.startTime ?? null, endTime: row.endTime ?? null, endsNextDay: row.endsNextDay ?? false };
  let before: Partial<typeof original>;
  try { before = JSON.parse(String(fd.get("before") ?? "")); } catch { return { ok: false, error: "Reload this stop before editing it." }; }
  if (!before || before.hours !== row.hours || before.reasonCode !== row.reasonCode || before.reason !== row.reason || (before.startTime ?? null) !== original.startTime || (before.endTime ?? null) !== original.endTime || (before.endsNextDay ?? false) !== original.endsNextDay) return { ok: false, error: "This stop changed since you opened it. Reload before saving." };
  const keepLegacyHours = !row.startTime && !String(fd.get("startTime") ?? "").trim() && !String(fd.get("endTime") ?? "").trim() && !["true", "on"].includes(String(fd.get("endsNextDay"))) && Number(fd.get("hours")) === row.hours && row.hours > 0 && row.hours <= MAX_STOP_HOURS;
  const duration = keepLegacyHours ? { hours: row.hours } : durationOf(fd);
  if ("error" in duration) return { ok: false, error: duration.error };
  if (row.startTime && !duration.startTime) return { ok: false, error: "Keep or correct both clock times on this stop." };
  const reasonCode = String(fd.get("reasonCode") ?? "");
  if (!isDowntimeCode(reasonCode)) return { ok: false, error: "Pick why it stopped." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200) || null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const error = await checkStop(tx, target, row.date, duration, id);
      if (error) return { ok: false, error };
      const saved = await tx.machineDowntime.updateMany({ where: { id, date: row.date, machineId: row.machineId, customName: row.customName ?? null, customDept: row.customDept ?? null, customCentre: row.customCentre ?? null, ...original }, data: { ...duration, reasonCode, reason, recordedBy: target.by } });
      return saved.count ? { ok: true, id, hours: duration.hours } : { ok: false, error: "This stop changed or was deleted. Reload before saving." };
    }, { isolationLevel: "Serializable" });
    if (result.ok) revalidate(); return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, error: "The equipment's stops changed at the same time. Reload and try again." };
    throw error;
  }
}
