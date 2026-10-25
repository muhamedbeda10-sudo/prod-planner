import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, ROSTER_DEPTS, centreOf, dayTotals, isShiftCode, lineHours, type DayTotals, type RosterDept, type ShiftCode, type ShiftHours, type WorkCentre } from "@/lib/domain/shifts";
import { sectionDept, sectionLabel, type WorkerSection } from "@/lib/domain/tanks";
import { getShiftHours } from "./data";
import { getRosterFor } from "./workers";
import { getStageCapacity } from "./standardTimes";

// The day's roster: every worker of every department joined with what was
// recorded for him. Saving rewrites each department's rows for the day and
// re-sums DeptDayHours, the figure the calibration and the capacity check
// read — so those keep working, fed by the supervisor instead of the admin.

export interface ShiftLineDTO {
  workerId: number;
  empId: string;
  name: string;
  jobTitle: string | null;
  /** The department the line is recorded under. */
  dept: RosterDept;
  /** The sections of that department he is registered in — the roster's filter. */
  sections: WorkerSection[];
  sectionLabels: string[];
  /** Away on vacation today, on today's roster only: the workers list keeps
   *  when a vacation ends, not when it began, so an earlier day cannot tell.
   *  "Set the rest" leaves such a worker absent. */
  onVacation: boolean;
  present: boolean;
  shift: ShiftCode;
  overtimeH: number;
  /** The work centre the day books him to — the one recorded, else his
   *  section's. Null outside the transformer departments. */
  center: WorkCentre | null;
  note: string;
  /** False while the day has no row for this worker — the defaults are shown. */
  recorded: boolean;
}

export interface ShiftRosterData {
  dateISO: string;
  lines: ShiftLineDTO[];
  totals: DayTotals;
  /** The departments whose rows were saved for this day. */
  savedDepts: RosterDept[];
  recordedBy: string | null;
  /** The stage's available man-hours a day from Admin → Standard Times, for the comparison. */
  capacityMh: Partial<Record<RosterDept, number>>;
  /** What a shift and the "+OT" button are worth today (Settings). */
  shiftHours: ShiftHours;
}

const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function getShiftRoster(dateISO: string): Promise<ShiftRosterData> {
  const date = dayOf(dateISO);
  const [hours, rows, capacity, perDept] = await Promise.all([
    getShiftHours(),
    prisma.shiftEntry.findMany({ where: { date } }),
    getStageCapacity(),
    Promise.all(ROSTER_DEPTS.map(async (dept) => ({ dept, workers: await getRosterFor(dept) }))),
  ]);
  const byKey = new Map(rows.map((r) => [`${r.dept}|${r.workerId}`, r]));
  // a worker retired since the day was recorded still shows on that day
  const listed = new Set(perDept.flatMap(({ dept, workers }) => workers.map((w) => `${dept}|${w.id}`)));
  const extra = rows.filter((r) => !listed.has(`${r.dept}|${r.workerId}`));
  const retired = extra.length ? await prisma.worker.findMany({ where: { id: { in: [...new Set(extra.map((r) => r.workerId))] } } }) : [];
  const retiredById = new Map(retired.map((w) => [w.id, w]));

  const isToday = dateISO === factoryDayISO(new Date());
  const lines: ShiftLineDTO[] = [];
  const build = (dept: RosterDept, w: { id: number; empId: string; name: string; jobTitle: string | null; sections: WorkerSection[]; onVacation: boolean }) => {
    const r = byKey.get(`${dept}|${w.id}`);
    const sections = w.sections.filter((c) => (sectionDept(c) as string) === dept);
    lines.push({
      workerId: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle, dept,
      sections, sectionLabels: sections.map(sectionLabel), onVacation: isToday && w.onVacation,
      // A worker belongs to the master roster, not automatically to the day shift.
      // Until the supervisor records this day, leave the worker unassigned.
      present: r?.present ?? false,
      shift: r && isShiftCode(r.shift) ? r.shift : DEFAULT_SHIFT,
      overtimeH: r?.overtimeH ?? 0,
      center: centreOf(dept, sections, r?.center),
      note: r?.note ?? "",
      recorded: !!r,
    });
  };
  for (const { dept, workers } of perDept) for (const w of workers) build(dept, w);
  for (const r of extra) {
    const w = retiredById.get(r.workerId);
    if (w && (ROSTER_DEPTS as readonly string[]).includes(r.dept)) build(r.dept as RosterDept, { id: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle, sections: [], onVacation: false });
  }

  const capacityMh: Partial<Record<RosterDept, number>> = {};
  for (const d of ROSTER_DEPTS) { const c = (capacity as Record<string, number | undefined>)[d]; if (c != null) capacityMh[d] = c; }
  return {
    dateISO, lines,
    totals: dayTotals(lines, hours),
    savedDepts: ROSTER_DEPTS.filter((d) => rows.some((r) => r.dept === d)),
    recordedBy: rows.find((r) => r.recordedBy)?.recordedBy ?? null,
    capacityMh,
    shiftHours: hours,
  };
}

/** Re-sum a department's day into DeptDayHours — the figure the calibration
 *  and the plan's capacity check read. No rows → no figure for that day. */
export async function syncDeptDayHours(tx: Prisma.TransactionClient, date: Date, dept: RosterDept): Promise<number> {
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

export interface ShiftHistoryDay {
  dateISO: string;
  hours: number;
  people: number;
  /** Present on the day shift and on the night shift — from the roster's rows. */
  day: number;
  night: number;
  entries?: number;
  stops?: number;
  legacyHours?: number;
}

/** Recent department days, including days with only machine stops. An explicitly selected older day is included when it has data. */
export async function getShiftHistory(depts: readonly RosterDept[], days = 14, selectedDateISO?: string): Promise<ShiftHistoryDay[]> {
  const [recent, stopDays] = await Promise.all([
    prisma.deptDayHours.findMany({ where: { dept: { in: [...depts] } }, orderBy: { date: "desc" }, take: days * depts.length, select: { date: true } }),
    prisma.machineDowntime.groupBy({ by: ["date"], where: { machine: { dept: { in: [...depts] } } }, orderBy: { date: "desc" }, take: days, _count: { _all: true } }),
  ]);
  const dates = [...new Set([...recent, ...stopDays].map((r) => toISODate(r.date)))].sort().reverse().slice(0, days);
  if (selectedDateISO && !dates.includes(selectedDateISO)) dates.push(selectedDateISO);
  if (!dates.length) return [];
  const where = { date: { in: dates.map(dayOf) }, dept: { in: [...depts] } };
  const [totals, entries, stops, hours] = await Promise.all([
    prisma.deptDayHours.findMany({ where, select: { date: true, dept: true, hours: true, people: true } }),
    prisma.shiftEntry.findMany({ where, select: { date: true, dept: true, present: true, shift: true, overtimeH: true } }),
    prisma.machineDowntime.groupBy({ by: ["date"], where: { date: where.date, machine: { dept: where.dept } }, _count: { _all: true } }),
    getShiftHours(),
  ]);
  const byDay = new Map<string, ShiftHistoryDay>();
  const get = (date: Date) => {
    const dateISO = toISODate(date);
    if (!byDay.has(dateISO)) byDay.set(dateISO, { dateISO, hours: 0, people: 0, day: 0, night: 0, entries: 0, stops: 0 });
    return byDay.get(dateISO)!;
  };
  const recorded = new Set<string>();
  for (const row of entries) {
    const day = get(row.date);
    recorded.add(`${day.dateISO}|${row.dept}`);
    day.entries! += 1;
    day.hours = Math.round((day.hours + lineHours({ ...row, shift: isShiftCode(row.shift) ? row.shift : DEFAULT_SHIFT }, hours)) * 10) / 10;
    if (row.present) { day.people += 1; if (row.shift === "S11") day.night += 1; else day.day += 1; }
  }
  // Legacy department totals without individual attendance remain part of the day's hours.
  for (const row of totals) {
    const day = get(row.date);
    if (recorded.has(`${day.dateISO}|${row.dept}`)) continue;
    day.hours = Math.round((day.hours + row.hours) * 10) / 10;
    day.people += row.people ?? 0;
    day.legacyHours = Math.round(((day.legacyHours ?? 0) + row.hours) * 10) / 10;
  }
  for (const row of stops) get(row.date).stops = row._count._all;
  return [...byDay.values()].sort((a, b) => b.dateISO.localeCompare(a.dateISO));
}
