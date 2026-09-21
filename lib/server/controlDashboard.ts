import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine, ledgerItemWhere } from "./line";
import { loadHolidays } from "./loads";
import { getMasterTracker } from "./masterTracker";
import { getEtaBase, getOrderEtas } from "./eta";
import { getStageCapacity } from "./standardTimes";
import { getOtdStats } from "./otd";
import { currentMonthLabel, toISODate } from "@/lib/domain/dates";
import { isDoneStatus } from "@/lib/domain/odoo";
import {
  attentionOf, backlogOf, backlogSeries, bottleneckOf, byCustomer, monthBoundsISO, monthCompareOf, paceOf, piecesByItem, piecesOf, planSummaryOf, promisesAhead, stageLoadOf, workingDaysBetween, workingDaysLeft,
  type AttentionRow, type BacklogPoint, type BacklogStage, type CustomerStanding, type ItemPieces, type MonthCompare, type Pace, type PlanSummary, type PromisesAhead, type StageLoad, type StagePieces,
} from "@/lib/domain/control";

// The production-control screen: the plan's standing, where the work sits,
// the bottleneck, the pace against the month, and the orders that need a
// hand — plus the control loops around the floor (Odoo closing, material,
// today's shift log, on-time delivery). Read off what the app already keeps;
// nothing here is stored.

export interface ControlDashboardData {
  todayISO: string;
  monthLabel: string;
  plan: PlanSummary;
  pieces: StagePieces;
  backlog: Record<BacklogStage, number>;
  bottleneck: BacklogStage | null;
  pace: Pace & { windowDays: number; finishedInWindow: number };
  attention: AttentionRow[];
  /** How many of each kind exist beyond the list shown. */
  attentionCounts: { late: number; dueSoon: number; blocked: number; hold: number };
  otd: { pct: number | null; due: number; openLate: number; avgLateDays: number | null };
  closing: { open: number; needMo: number };
  material: { lines: number; overBom: number; notNested: number };
  shifts: { dept: string; label: string; hours: number | null }[];
  /** The backlog at each stage, day by day over the last month, for the orders open today. */
  backlogHistory: BacklogPoint[];
  /** Std-hours queued per stage against the pace it earns, the capacity set and the hours logged. */
  load: { stages: StageLoad[]; windowDays: number; uncoveredOrders: number };
  /** The pipeline and backlog per component, for the components some open order needs. */
  byItem: ItemPieces[];
  /** The next two weeks' promises, day by day, with the at-risk share; overdue and unscheduled beside. */
  promises: PromisesAhead;
  customers: CustomerStanding[];
  /** Pieces per department this month to date against last month, with the month projected from the run-rate. */
  months: { rows: MonthCompare[]; elapsedWd: number; monthWd: number; lastMonthLabel: string };
  floor: {
    /** Attendance recorded today per department: present of logged; null when nothing is logged. */
    attendance: { dept: string; label: string; present: number; logged: number }[];
    /** Machine downtime this work week: hours and machines. */
    downtime: { hours: number; machines: number };
    /** Pieces sent back by a downstream department and not re-delivered yet. */
    openReturns: { pieces: number; lines: number };
  };
}

const HISTORY_DAYS = 30; // calendar days the backlog curve covers

const TRAIL_DAYS = 14; // calendar days behind today the pace is read over

export async function getControlDashboard(): Promise<ControlDashboardData> {
  const line = await getActiveLine();
  const now = new Date();
  const todayISO = toISODate(now);
  const today = new Date(`${todayISO}T00:00:00Z`);
  const monthLabel = currentMonthLabel(now);
  const trailStart = new Date(today.getTime() - TRAIL_DAYS * 86400000);

  const bounds = monthBoundsISO(todayISO);
  const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
  // the work week runs Sat–Thu: the most recent Saturday on or before today
  const weekStart = new Date(today.getTime() - ((today.getUTCDay() + 1) % 7) * 86400000);
  const [tracker, { byMo: etas }, otd, holidays, odooRows, materialRows, hoursToday, finishedRows, etaBase, capacity, loggedHours, monthRows, shiftRows, downtimeRows, returnRows] = await Promise.all([
    getMasterTracker(),
    getOrderEtas(),
    getOtdStats(),
    loadHolidays(),
    prisma.odooEntry.findMany({ where: { line }, select: { status: true, odooMo: true } }),
    prisma.materialUsage.findMany({ where: { line, month: monthLabel }, select: { units: true, sheetsPerUnit: true, sheetsUsed: true } }),
    prisma.deptDayHours.findMany({ where: { date: today } }),
    prisma.handoverEntry.findMany({
      where: { date: { gte: trailStart, lt: today }, dept: { in: ["Painting", "ShotBlast"] }, ...ledgerItemWhere(line) },
      select: { qty: true },
    }),
    getEtaBase(),
    getStageCapacity(),
    prisma.deptDayHours.findMany({ where: { date: { gte: trailStart, lt: today } }, select: { dept: true, hours: true, date: true } }),
    prisma.handoverEntry.findMany({
      where: { date: { gte: dayOf(bounds.lastStart), lte: today }, dept: { in: ["Cut", "Welding", "Painting", "ShotBlast"] }, ...ledgerItemWhere(line) },
      select: { date: true, dept: true, qty: true },
    }),
    prisma.shiftEntry.findMany({ where: { date: today }, select: { dept: true, present: true } }),
    prisma.machineDowntime.findMany({ where: { date: { gte: weekStart, lte: today } }, select: { machineId: true, hours: true } }),
    prisma.returnEntry.findMany({ where: { status: "open" }, select: { qty: true } }),
  ]);

  const openMos = tracker.filter((r) => r.status === "open").map((r) => r.mo);
  const ledger = openMos.length === 0 ? [] : await prisma.handoverEntry.findMany({
    where: { mo: { in: openMos }, ...ledgerItemWhere(line) },
    select: { mo: true, item: true, dept: true, date: true, qty: true },
  });
  const rows = tracker.map((r) => ({
    mo: r.mo, bom: r.bom, soi: r.soi, customer: r.customer, required: r.required, complete: r.complete,
    status: r.status, urgent: r.urgent, priority: r.priority, onHold: r.hold.onHold, months: r.months, items: r.items,
  }));
  const holidayISOs = new Set(holidays.map((h) => toISODate(h.date)));
  const pieces = piecesOf(rows);
  const backlog = backlogOf(pieces);
  const finishedInWindow = finishedRows.reduce((s, e) => s + Math.max(0, e.qty), 0);
  const windowDays = workingDaysBetween(toISODate(trailStart), toISODate(new Date(today.getTime() - 86400000)), holidayISOs);
  const pace = paceOf(pieces.need - pieces.finished, finishedInWindow, windowDays, workingDaysLeft(todayISO, holidayISOs));

  // the counts behind the capped list — the list shows the worst, the counts say how many there are
  const all = attentionOf(rows, etas, todayISO, Number.MAX_SAFE_INTEGER);
  const attentionCounts = { late: 0, dueSoon: 0, blocked: 0, hold: 0 };
  for (const a of all) attentionCounts[a.kind] += 1;

  const openOdoo = odooRows.filter((o) => !isDoneStatus(o.status));

  // this month against last, per department (finishing = painting + shot blast)
  const deptOf = (d: string) => (d === "Cut" ? "Fabrication" : d === "Welding" ? "Welding" : "Finishing");
  const sums = { mtd: new Map<string, number>(), last: new Map<string, number>() };
  for (const e of monthRows) {
    const iso = toISODate(e.date);
    const bucket = iso >= bounds.thisStart ? sums.mtd : sums.last;
    const k = deptOf(e.dept);
    bucket.set(k, (bucket.get(k) ?? 0) + Math.max(0, e.qty));
  }
  const elapsedWd = workingDaysBetween(bounds.thisStart, todayISO, holidayISOs);
  const monthWd = workingDaysBetween(bounds.thisStart, todayISO, holidayISOs) + workingDaysLeft(todayISO, holidayISOs);
  const months = {
    rows: ["Fabrication", "Welding", "Finishing"].map((k) => monthCompareOf(k, sums.mtd.get(k) ?? 0, sums.last.get(k) ?? 0, elapsedWd, monthWd)),
    elapsedWd,
    monthWd,
    lastMonthLabel: dayOf(bounds.lastStart).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };

  // load: the ETA's jobs already carry the std-hours each open order still
  // owes every stage (held orders and orders with no standard times excluded)
  const queued = { cut: 0, weld: 0, finish: 0 };
  for (const j of etaBase.jobs) { queued.cut += j.hours.cut; queued.weld += j.hours.weld; queued.finish += j.hours.finish; }
  const jobMos = new Set(etaBase.jobs.map((j) => j.mo));
  const uncoveredOrders = rows.filter((r) => r.status === "open" && !r.onHold && !jobMos.has(r.mo)).length;
  const capOf = (depts: string[]) => { const v = depts.map((d) => capacity[d]).filter((x): x is number => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const loggedOf = (depts: string[]) => {
    const rows = loggedHours.filter((h) => depts.includes(h.dept));
    if (rows.length === 0 || windowDays === 0) return null;
    return rows.reduce((s, h) => s + h.hours, 0) / windowDays;
  };
  const load = {
    windowDays: etaBase.windowDays,
    uncoveredOrders,
    stages: [
      stageLoadOf("cut", queued.cut, etaBase.rates.cut, capOf(["Cut"]), loggedOf(["Cut"])),
      stageLoadOf("weld", queued.weld, etaBase.rates.weld, capOf(["Welding"]), loggedOf(["Welding"])),
      stageLoadOf("finish", queued.finish, etaBase.rates.finish, capOf(["ShotBlast", "Painting"]), loggedOf(["ShotBlast", "Painting"])),
    ],
  };
  const shiftDepts = [["Cut", "Fabrication"], ["Welding", "Welding"], ["ShotBlast", "Shot blast"], ["Painting", "Painting"]] as const;

  return {
    todayISO,
    monthLabel,
    plan: planSummaryOf(rows),
    pieces,
    backlog,
    bottleneck: bottleneckOf(backlog),
    pace: { ...pace, windowDays, finishedInWindow },
    attention: all.slice(0, 8),
    attentionCounts,
    otd: { pct: otd.otdPct, due: otd.due, openLate: otd.openLate, avgLateDays: otd.avgLatenessDays },
    closing: { open: openOdoo.length, needMo: openOdoo.filter((o) => !o.odooMo.trim()).length },
    material: {
      lines: materialRows.length,
      overBom: materialRows.filter((m) => m.sheetsUsed !== null && m.sheetsUsed > m.sheetsPerUnit * m.units).length,
      notNested: materialRows.filter((m) => m.sheetsUsed === null).length,
    },
    shifts: shiftDepts.map(([dept, label]) => ({ dept, label, hours: hoursToday.find((h) => h.dept === dept)?.hours ?? null })),
    backlogHistory: backlogSeries(
      rows,
      ledger.map((e) => ({ mo: e.mo, item: e.item, dept: e.dept, dateISO: toISODate(e.date), qty: e.qty })),
      toISODate(new Date(today.getTime() - (HISTORY_DAYS - 1) * 86400000)),
      todayISO
    ),
    load,
    byItem: piecesByItem(rows),
    promises: promisesAhead(rows, etas, todayISO),
    customers: byCustomer(rows),
    months,
    floor: {
      attendance: shiftDepts.map(([dept, label]) => {
        const rows = shiftRows.filter((s) => s.dept === dept);
        return { dept, label, present: rows.filter((s) => s.present).length, logged: rows.length };
      }),
      downtime: { hours: downtimeRows.reduce((s, d) => s + d.hours, 0), machines: new Set(downtimeRows.map((d) => d.machineId)).size },
      openReturns: { pieces: returnRows.reduce((s, r) => s + r.qty, 0), lines: returnRows.length },
    },
  };
}
