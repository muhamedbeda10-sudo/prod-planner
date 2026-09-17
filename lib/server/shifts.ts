import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, MACHINE_DEPTS, dayTotals, isShiftCode, lineHours, type DayTotals, type ShiftCode, type ShiftDept, type ShiftHours } from "@/lib/domain/shifts";
import { getShiftHours } from "./data";
import { isFridayISO, quickHours, weekDaysISO, weekStartISO, type QuickDayCell, type QuickWeek } from "@/lib/domain/quickHours";
import { SHIFT_DEPTS } from "@/lib/domain/shifts";
import { loadHolidays } from "./loads";
import { getMachinesFor, type MachineDTO } from "./machines";
import { getWorkersFor } from "./workers";
import { getStageCapacity } from "./standardTimes";

// One department's day on the shift log: its workers joined with what was
// recorded for them, the machines' downtime, and the totals. Saving a day
// rewrites the department's rows for it and re-sums DeptDayHours, the figure
// the calibration and the capacity check read — so those keep working
// exactly as before, fed by the supervisor instead of the admin.

export interface ShiftLineDTO {
  workerId: number;
  empId: string;
  name: string;
  jobTitle: string | null;
  present: boolean;
  shift: ShiftCode;
  overtimeH: number;
  machineId: number | null;
  note: string;
  /** False while the day has no row for this worker — the defaults are shown. */
  recorded: boolean;
}

export interface DowntimeDTO {
  id: number;
  machineId: number;
  hours: number;
  reason: string | null;
}

export interface ShiftDayData {
  dateISO: string;
  dept: ShiftDept;
  lines: ShiftLineDTO[];
  machines: MachineDTO[];
  downtime: DowntimeDTO[];
  totals: DayTotals;
  /** The stage's available man-hours a day from Admin → Standard Times, for the comparison. */
  capacityMh: number | null;
  /** What a shift and the "+OT" button are worth today (Settings). */
  shiftHours: ShiftHours;
  /** Whether any row was ever saved for this day — "not recorded yet" until then. */
  saved: boolean;
  recordedBy: string | null;
}

const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function getShiftDay(dateISO: string, dept: ShiftDept): Promise<ShiftDayData> {
  const date = dayOf(dateISO);
  const [hours, [workers, machines, rows, downtime, capacity]] = await Promise.all([getShiftHours(), Promise.all([
    getWorkersFor(dept),
    MACHINE_DEPTS.includes(dept) ? getMachinesFor(dept) : Promise.resolve([] as MachineDTO[]),
    prisma.shiftEntry.findMany({ where: { date, dept } }),
    MACHINE_DEPTS.includes(dept)
      ? prisma.machineDowntime.findMany({ where: { date, machine: { dept } }, orderBy: { id: "asc" } })
      : Promise.resolve([]),
    getStageCapacity(),
  ])]);
  const byWorker = new Map(rows.map((r) => [r.workerId, r]));
  // a worker retired since the day was recorded still shows on that day
  const extra = rows.filter((r) => !workers.some((w) => w.id === r.workerId)).map((r) => r.workerId);
  const retired = extra.length ? await prisma.worker.findMany({ where: { id: { in: extra } } }) : [];
  const all = [...workers, ...retired.map((w) => ({ id: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle }))];

  const lines: ShiftLineDTO[] = all.map((w) => {
    const r = byWorker.get(w.id);
    return {
      workerId: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle,
      present: r?.present ?? true,
      shift: r && isShiftCode(r.shift) ? r.shift : DEFAULT_SHIFT,
      overtimeH: r?.overtimeH ?? 0,
      machineId: r?.machineId ?? null,
      note: r?.note ?? "",
      recorded: !!r,
    };
  });
  return {
    dateISO, dept, lines, machines,
    downtime: downtime.map((d) => ({ id: d.id, machineId: d.machineId, hours: d.hours, reason: d.reason })),
    totals: dayTotals(lines, hours),
    capacityMh: capacity[dept] ?? null,
    shiftHours: hours,
    saved: rows.length > 0,
    recordedBy: rows.find((r) => r.recordedBy)?.recordedBy ?? null,
  };
}

/** Re-sum a department's day into DeptDayHours — the figure the calibration
 *  and the plan's capacity check read. No rows → no figure for that day. */
export async function syncDeptDayHours(tx: Prisma.TransactionClient, date: Date, dept: ShiftDept): Promise<number> {
  const rows = await tx.shiftEntry.findMany({ where: { date, dept }, select: { present: true, shift: true, overtimeH: true } });
  if (rows.length === 0) {
    await tx.deptDayHours.deleteMany({ where: { date, dept } });
    return 0;
  }
  const hrs = await getShiftHours();
  const hours = Math.round(rows.reduce((s, r) => s + lineHours({ present: r.present, shift: isShiftCode(r.shift) ? r.shift : DEFAULT_SHIFT, overtimeH: r.overtimeH }, hrs), 0) * 10) / 10;
  const present = rows.filter((r) => r.present).length;
  const data = { hours, people: present, hoursEach: null, source: "roster", recordedBy: null };
  await tx.deptDayHours.upsert({ where: { date_dept: { date, dept } }, create: { date, dept, ...data }, update: data });
  return hours;
}

// ---- the quick entry: a week of heads × hours, every department at once ----

export interface QuickWeekData {
  startISO: string;
  /** The seven days, Saturday first; Friday is shown but off. */
  days: { dateISO: string; off: boolean; holiday: string | null; future: boolean }[];
  week: QuickWeek;
  /** The hours a head is worth unless typed — the short shift from Settings. */
  defaultHours: number;
  /** The last head-count and hours typed per department — the placeholders. */
  last: Record<ShiftDept, { people: number; hoursEach: number } | null>;
}

export async function getQuickWeek(anyDayISO: string, todayISO: string): Promise<QuickWeekData> {
  const startISO = weekStartISO(anyDayISO);
  const dayISOs = weekDaysISO(startISO);
  const from = dayOf(dayISOs[0]);
  const to = dayOf(dayISOs[6]);
  const [hrs, rows, holidays, lastRows] = await Promise.all([
    getShiftHours(),
    prisma.deptDayHours.findMany({ where: { date: { gte: from, lte: to } } }),
    loadHolidays(),
    prisma.deptDayHours.findMany({ where: { source: "quick", people: { not: null } }, orderBy: { date: "desc" }, take: 40, select: { dept: true, people: true, hoursEach: true } }),
  ]);
  const holidayByISO = new Map(holidays.map((h) => [toISODate(h.date), h.name ?? "holiday"]));
  const empty = (): QuickDayCell => ({ people: null, hoursEach: null, hours: 0, source: null });
  const week: QuickWeek = Object.fromEntries(dayISOs.map((d) => [d, Object.fromEntries(SHIFT_DEPTS.map((x) => [x, empty()])) as Record<ShiftDept, QuickDayCell>]));
  for (const r of rows) {
    const iso = toISODate(r.date);
    const dept = r.dept as ShiftDept;
    if (!week[iso] || !SHIFT_DEPTS.includes(dept)) continue;
    week[iso][dept] = {
      people: r.people,
      hoursEach: r.hoursEach,
      hours: r.hours,
      source: r.source === "quick" ? "quick" : "roster",
    };
  }
  const last = Object.fromEntries(SHIFT_DEPTS.map((d) => [d, null])) as QuickWeekData["last"];
  for (const r of lastRows) {
    const dept = r.dept as ShiftDept;
    if (SHIFT_DEPTS.includes(dept) && !last[dept] && r.people) last[dept] = { people: r.people, hoursEach: r.hoursEach ?? hrs.short };
  }
  return {
    startISO,
    days: dayISOs.map((d) => ({ dateISO: d, off: isFridayISO(d), holiday: holidayByISO.get(d) ?? null, future: d > todayISO })),
    week,
    defaultHours: hrs.short,
    last,
  };
}

/** Write one quick cell: heads × hours each becomes the day's figure. A day
 *  summed from the roster is left alone — it is edited on the roster. */
export async function writeQuickCell(date: Date, dept: ShiftDept, cell: { people: number; hoursEach: number } | null, by: string | null): Promise<{ hours: number } | { error: string }> {
  const existing = await prisma.deptDayHours.findUnique({ where: { date_dept: { date, dept } }, select: { source: true } });
  if (existing && existing.source !== "quick") return { error: "That day was recorded on the roster — change it there." };
  if (!cell) {
    if (existing) await prisma.deptDayHours.delete({ where: { date_dept: { date, dept } } });
    return { hours: 0 };
  }
  const hours = quickHours(cell.people, cell.hoursEach);
  const data = { hours, people: cell.people, hoursEach: cell.hoursEach, source: "quick", recordedBy: by };
  await prisma.deptDayHours.upsert({ where: { date_dept: { date, dept } }, create: { date, dept, ...data }, update: data });
  return { hours };
}

/** The days a department has recorded, newest first, with their totals — the
 *  strip under the day so the supervisor sees what is missing. */
export async function getShiftHistory(dept: ShiftDept, days = 14): Promise<{ dateISO: string; hours: number }[]> {
  const rows = await prisma.deptDayHours.findMany({ where: { dept }, orderBy: { date: "desc" }, take: days });
  return rows.map((r) => ({ dateISO: toISODate(r.date), hours: r.hours }));
}
