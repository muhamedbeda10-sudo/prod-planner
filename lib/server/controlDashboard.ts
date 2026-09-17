import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine, ledgerItemWhere } from "./line";
import { loadHolidays } from "./loads";
import { getMasterTracker } from "./masterTracker";
import { getOrderEtas } from "./eta";
import { getOtdStats } from "./otd";
import { currentMonthLabel, toISODate } from "@/lib/domain/dates";
import { isDoneStatus } from "@/lib/domain/odoo";
import {
  attentionOf, backlogOf, bottleneckOf, paceOf, piecesOf, planSummaryOf, workingDaysBetween, workingDaysLeft,
  type AttentionRow, type BacklogStage, type Pace, type PlanSummary, type StagePieces,
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
}

const TRAIL_DAYS = 14; // calendar days behind today the pace is read over

export async function getControlDashboard(): Promise<ControlDashboardData> {
  const line = await getActiveLine();
  const now = new Date();
  const todayISO = toISODate(now);
  const today = new Date(`${todayISO}T00:00:00Z`);
  const monthLabel = currentMonthLabel(now);
  const trailStart = new Date(today.getTime() - TRAIL_DAYS * 86400000);

  const [tracker, { byMo: etas }, otd, holidays, odooRows, materialRows, hoursToday, finishedRows] = await Promise.all([
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
  ]);

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
  };
}
