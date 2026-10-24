import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT, ROSTER_DEPTS, dayTotals, isShiftCode, lineHours, type DayTotals, type RosterDept, type ShiftCode, type ShiftHours } from "@/lib/domain/shifts";
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
}

/** The last days recorded, newest first, with the man-hours of the given
 *  departments summed per day and who came on which shift — the strip under
 *  the roster. */
export async function getShiftHistory(depts: readonly RosterDept[], days = 14): Promise<ShiftHistoryDay[]> {
  const rows = await prisma.deptDayHours.findMany({ where: { dept: { in: [...depts] } }, orderBy: { date: "desc" }, take: days * depts.length });
  const byDay = new Map<string, { hours: number; people: number; day: number; night: number; date: Date }>();
  for (const r of rows) {
    const iso = toISODate(r.date);
    const cur = byDay.get(iso) ?? { hours: 0, people: 0, day: 0, night: 0, date: r.date };
    byDay.set(iso, { ...cur, hours: Math.round((cur.hours + r.hours) * 10) / 10, people: cur.people + (r.people ?? 0) });
  }
  const picked = [...byDay.entries()].slice(0, days);
  if (picked.length > 0) {
    const split = await prisma.shiftEntry.groupBy({
      by: ["date", "shift"],
      where: { dept: { in: [...depts] }, present: true, date: { in: picked.map(([, v]) => v.date) } },
      _count: { _all: true },
    });
    for (const s of split) {
      const cur = byDay.get(toISODate(s.date));
      if (!cur) continue;
      if (s.shift === "S11") cur.night += s._count._all;
      else cur.day += s._count._all;
    }
  }
  return picked.map(([dateISO]) => {
    const { hours, people, day, night } = byDay.get(dateISO)!;
    return { dateISO, hours, people, day, night };
  });
}
