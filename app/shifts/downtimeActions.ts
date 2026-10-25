"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type MachineDowntime } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { factoryDayISO, factoryWallClockMs, parseISODate, toISODate } from "@/lib/domain/dates";
import { deptCentre, isRosterDept, workerCentres } from "@/lib/domain/shifts";
import { MAX_STOP_HOURS, downtimeLabel, isDowntimeCode, stopHours, stopTiming } from "@/lib/domain/downtime";
import { downtimeHoursInRange, stopPeriodBounds, type StopPeriod } from "@/lib/domain/downtimePeriods";
import { emitEvent } from "@/lib/server/events";

export interface DowntimeActionResult { ok: boolean; error?: string; id?: number; hours?: number; isOpen?: boolean }
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
type Duration = { hours: number; startTime?: string; endTime?: string | null; endsNextDay?: boolean; isOpen?: boolean; endDate?: Date | null };
function durationOf(fd: FormData, date: Date): Duration | { error: string } {
  const start = String(fd.get("startTime") ?? "").trim(), end = String(fd.get("endTime") ?? "").trim();
  const dateISO = toISODate(date), nowWall = factoryWallClockMs(new Date());
  if (start || end) {
    const openFlag = fd.get("isOpen");
    if (openFlag !== null && !["true", "false", "on", ""].includes(String(openFlag))) return { error: "Choose whether the stop is still open." };
    const isOpen = !end;
    if (isOpen) {
      if (openFlag === "false") return { error: "Give the actual end time, or mark the stop as still open." };
      const bounds = stopPeriodBounds({ date, hours: 0, startTime: start, isOpen: true });
      if (!bounds || bounds.start > nowWall) return { error: "Give a valid start time that has already happened." };
      return { hours: 0, startTime: start, endTime: null, endsNextDay: false, isOpen: true, endDate: null };
    }
    if (openFlag === "true" || openFlag === "on") return { error: "An open stop has no end time. Clear To or mark it resolved." };
    const explicitEnd = String(fd.get("endDate") ?? "").trim();
    if (explicitEnd) {
      const endDate = parseISODate(explicitEnd);
      const bounds = endDate ? stopPeriodBounds({ date, hours: 0, startTime: start, endTime: end, endDate }) : null;
      if (!bounds || bounds.end > nowWall) return { error: "Give an actual end date/time after the start and no later than now." };
      return { hours: (bounds.end - bounds.start) / 3600000, startTime: start, endTime: end, endsNextDay: explicitEnd > dateISO, isOpen: false, endDate: endDate! };
    }
    // Previously supported short clock-range calls retain their original booking.
    const flag = fd.get("endsNextDay");
    if (flag !== null && !["true", "false", "on", ""].includes(String(flag))) return { error: "Choose whether the end is on the next day." };
    const timing = stopTiming(start, end, flag === null ? undefined : flag === "true" || flag === "on");
    return timing ? { hours: timing.hours, startTime: start, endTime: end, endsNextDay: timing.endsNextDay, isOpen: false } : { error: "Choose valid start/end times, after the start and within 24 hours, or give an explicit end date." };
  }
  if (fd.get("isOpen") === "true" || fd.get("isOpen") === "on") return { error: "Give the open stop's start time." };
  if (fd.get("endsNextDay") === "true" || fd.get("endsNextDay") === "on") return { error: "Give both clock times for a next-day end." };
  const hours = stopHours(Number(String(fd.get("hours") ?? "").trim()));
  if (!Number.isFinite(hours) || hours <= 0) return { error: "Give a start time (leave To blank while open), or a legacy duration of a quarter of an hour at least." };
  return hours <= MAX_STOP_HOURS ? { hours } : { error: `A machine cannot stand more than ${MAX_STOP_HOURS} hours in a day.` };
}
/** An open incident reserves its equipment until resolved; closed multi-day repairs are checked across their whole span. */
async function checkStop(tx: Prisma.TransactionClient, target: Target, date: Date, duration: Duration, excludeId?: number) {
  const equipment = equipmentWhere(target), exclude = excludeId ? { id: { not: excludeId } } : {};
  const before = await tx.machineDowntime.aggregate({ where: { date, ...equipment, ...exclude }, _sum: { hours: true } });
  const proposed: StopPeriod = { date, ...duration }, bounds = stopPeriodBounds(proposed);
  const upper = duration.isOpen ? parseISODate(factoryDayISO(new Date()))! : duration.endDate ?? new Date(date.getTime() + (duration.endsNextDay ? 86400000 : 0));
  const rows = await tx.machineDowntime.findMany({ where: { ...equipment, ...exclude, date: { lte: upper }, OR: [{ isOpen: true }, { endDate: { gte: date } }, { date: { gte: new Date(date.getTime() - 86400000) } }] }, select: { date: true, hours: true, startTime: true, endTime: true, endsNextDay: true, isOpen: true, endDate: true } });
  const now = new Date();
  const bookedToday = rows.length ? rows.reduce((sum, row) => sum + downtimeHoursInRange(row, toISODate(date), toISODate(date), now), 0) : before._sum.hours ?? 0;
  if (!duration.isOpen && !duration.endDate && bookedToday + duration.hours > MAX_STOP_HOURS + 1e-8) return `${target.label} already has ${bookedToday} h of stops that day — the total would be more than the day.`;
  for (const row of rows) {
    const other = stopPeriodBounds(row);
    if (bounds && other && bounds.start < other.end && bounds.end > other.start) return "This equipment already has an overlapping or open stop. Resolve or edit that record first.";
    if (!bounds && row.isOpen && row.date <= date) return "This equipment has an open stop on this day. Resolve it before adding duration-only records.";
  }
  if (bounds) {
    const legacyDays = new Set(rows.filter((r) => !r.startTime).map((r) => toISODate(r.date)));
    for (const day of legacyDays) {
      const total = downtimeHoursInRange(proposed, day, day, now) + rows.reduce((sum, row) => sum + downtimeHoursInRange(row, day, day, now), 0);
      if (total > MAX_STOP_HOURS + 1e-8) return "This equipment's known durations would exceed 24 hours on a day within that range.";
    }
  }
  return null;
}
export async function addDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const dateISO = String(fd.get("date") ?? "").trim(), date = parseISODate(dateISO);
  if (!date) return { ok: false, error: "Pick a day." };
  if (dateISO > factoryDayISO(new Date())) return { ok: false, error: "That day has not come yet." };
  const duration = durationOf(fd, date);
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
      return { ok: true, id: row.id, hours: duration.hours, ...(duration.isOpen ? { isOpen: true } : {}) };
    }, { isolationLevel: "Serializable" });
    if (!result.ok) return result;
    await emitEvent({ type: "machine.stopped", subject: target.label, summary: `${target.label} ${duration.isOpen ? "has an open stop" : `stood ${duration.hours} h`} on ${dateISO} — ${downtimeLabel(reasonCode)}${reason ? `: ${reason}` : ""}`, data: { machine: target.label, dept: target.dept, hours: duration.hours, reasonCode, date: dateISO } });
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
  const original = { isOpen: row.isOpen ?? false, endDate: row.endDate ?? null, hours: row.hours, reasonCode: row.reasonCode, reason: row.reason, startTime: row.startTime ?? null, endTime: row.endTime ?? null, endsNextDay: row.endsNextDay ?? false };
  let before: Partial<Omit<typeof original, "endDate">> & { endDate?: string | null };
  try { before = JSON.parse(String(fd.get("before") ?? "")); } catch { return { ok: false, error: "Reload this stop before editing it." }; }
  if (!before || before.hours !== row.hours || before.reasonCode !== row.reasonCode || before.reason !== row.reason || (before.startTime ?? null) !== original.startTime || (before.endTime ?? null) !== original.endTime || (before.endsNextDay ?? false) !== original.endsNextDay || (before.isOpen ?? false) !== original.isOpen || (before.endDate ?? null) !== (row.endDate ? toISODate(row.endDate) : null)) return { ok: false, error: "This stop changed since you opened it. Reload before saving." };
  const keepLegacyHours = !row.startTime && !String(fd.get("startTime") ?? "").trim() && !String(fd.get("endTime") ?? "").trim() && !["true", "on"].includes(String(fd.get("endsNextDay"))) && Number(fd.get("hours")) === row.hours && row.hours > 0 && row.hours <= MAX_STOP_HOURS;
  const duration = keepLegacyHours ? { hours: row.hours } : durationOf(fd, row.date);
  if ("error" in duration) return { ok: false, error: duration.error };
  if (row.isOpen && !duration.isOpen && duration.startTime && !duration.endDate) {
    duration.endDate = new Date(row.date.getTime() + (duration.endsNextDay ? 86400000 : 0));
    duration.isOpen = false;
  }
  const resolution = stopPeriodBounds({ date: row.date, ...duration });
  if (row.isOpen && !duration.isOpen && (!resolution || resolution.end > factoryWallClockMs(new Date()))) return { ok: false, error: "Give an actual resolution after the start and no later than now." };
  if (row.startTime && !duration.startTime) return { ok: false, error: "Keep or correct both clock times on this stop." };
  const reasonCode = String(fd.get("reasonCode") ?? "");
  if (!isDowntimeCode(reasonCode)) return { ok: false, error: "Pick why it stopped." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200) || null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const error = await checkStop(tx, target, row.date, duration, id);
      if (error) return { ok: false, error };
      const saved = await tx.machineDowntime.updateMany({ where: { id, date: row.date, machineId: row.machineId, customName: row.customName ?? null, customDept: row.customDept ?? null, customCentre: row.customCentre ?? null, ...original }, data: { ...duration, reasonCode, reason, recordedBy: target.by } });
      return saved.count ? { ok: true, id, hours: duration.hours, ...(duration.isOpen ? { isOpen: true } : {}) } : { ok: false, error: "This stop changed or was deleted. Reload before saving." };
    }, { isolationLevel: "Serializable" });
    if (result.ok) revalidate(); return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, error: "The equipment's stops changed at the same time. Reload and try again." };
    throw error;
  }
}
