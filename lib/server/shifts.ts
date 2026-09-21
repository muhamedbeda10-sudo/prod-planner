import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, MACHINE_DEPTS, dayTotals, isShiftCode, lineHours, type DayTotals, type ShiftCode, type ShiftDept, type ShiftHours } from "@/lib/domain/shifts";
import { getShiftHours } from "./data";
import { isFridayISO, weekDaysISO, weekStartISO, type ShiftWeek, type WeekDayCell } from "@/lib/domain/quickHours";
import { SHIFT_DEPTS } from "@/lib/domain/shifts";
import { loadHolidays } from "./loads";
import { getMachinesFor, type MachineDTO } from "./machines";
import { getRosterFor, type WorkerDTO } from "./workers";
import { sectionDept, sectionLabel } from "@/lib/domain/tanks";
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
  /** The section(s) of this department he is registered in — "Fin Folding", "Bending TX". */
  section: string | null;
  /** Away on vacation on this roster's day as of today — absent unless the supervisor says otherwise. */
  onVacation: boolean;
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
    getRosterFor(dept),
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
  const all: Pick<WorkerDTO, "id" | "empId" | "name" | "jobTitle" | "sections" | "onVacation">[] = [...workers, ...retired.map((w) => ({ id: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle, sections: [], onVacation: false }))];

  const lines: ShiftLineDTO[] = all.map((w) => {
    const r = byWorker.get(w.id);
    const section = w.sections.filter((c) => (sectionDept(c) as string) === dept).map(sectionLabel).join(" · ") || null;
    return {
      workerId: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle, section,
      // no record yet: present, unless he is away on vacation
      present: r?.present ?? !w.onVacation,
      onVacation: w.onVacation,
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

// ---- the week summary: what the rosters summed, every department at once ----

export interface ShiftWeekData {
  startISO: string;
  /** The seven days, Saturday first; Friday is shown but off. */
  days: { dateISO: string; off: boolean; holiday: string | null; future: boolean }[];
  week: ShiftWeek;
}

export async function getShiftWeek(anyDayISO: string, todayISO: string): Promise<ShiftWeekData> {
  const startISO = weekStartISO(anyDayISO);
  const dayISOs = weekDaysISO(startISO);
  const [rows, holidays] = await Promise.all([
    prisma.deptDayHours.findMany({ where: { date: { gte: dayOf(dayISOs[0]), lte: dayOf(dayISOs[6]) } } }),
    loadHolidays(),
  ]);
  const holidayByISO = new Map(holidays.map((h) => [toISODate(h.date), h.name ?? "holiday"]));
  const empty = (): WeekDayCell => ({ people: null, hours: 0, recorded: false });
  const week: ShiftWeek = Object.fromEntries(dayISOs.map((d) => [d, Object.fromEntries(SHIFT_DEPTS.map((x) => [x, empty()])) as Record<ShiftDept, WeekDayCell>]));
  for (const r of rows) {
    const iso = toISODate(r.date);
    const dept = r.dept as ShiftDept;
    if (!week[iso] || !SHIFT_DEPTS.includes(dept)) continue;
    week[iso][dept] = { people: r.people, hours: r.hours, recorded: true };
  }
  return {
    startISO,
    days: dayISOs.map((d) => ({ dateISO: d, off: isFridayISO(d), holiday: holidayByISO.get(d) ?? null, future: d > todayISO })),
    week,
  };
}

/** The days a department has recorded, newest first, with their totals — the
 *  strip under the day so the supervisor sees what is missing. */
export async function getShiftHistory(dept: ShiftDept, days = 14): Promise<{ dateISO: string; hours: number }[]> {
  const rows = await prisma.deptDayHours.findMany({ where: { dept }, orderBy: { date: "desc" }, take: days });
  return rows.map((r) => ({ dateISO: toISODate(r.date), hours: r.hours }));
}
