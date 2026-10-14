import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO } from "@/lib/domain/dates";
import { buildMonthlyReport, monthBounds, reportSpan, shiftMonth, type MonthlyReport } from "@/lib/domain/consumableMonthly";
import { departmentWorkers } from "@/lib/domain/consumables";
import { loadUses, toRule } from "./consumableLimits";
import { getAllWorkers } from "./workers";

// The CONSUMABLES monthly review — the reads. The arithmetic is
// lib/domain/consumableMonthly.ts.

export interface MonthlyReportView extends MonthlyReport {
  /** The months the picker offers: the first month anything was handed out
   *  to this month, newest first. */
  months: string[];
  /** The log covers the whole month before — its figures are a comparison.
   *  When it began later, "vs last month" is left out rather than shown as a
   *  rise from nothing. */
  prevComplete: boolean;
}

export async function getMonthlyReport(month: string): Promise<MonthlyReportView> {
  const span = reportSpan(month);
  const [items, uses, first, workers] = await Promise.all([
    prisma.consumableItem.findMany({ orderBy: { name: "asc" }, include: { limits: { orderBy: { id: "asc" } } } }),
    loadUses(span.from, span.to),
    prisma.consumableIssue.findFirst({ where: { deletedAt: null }, orderBy: { issuedAt: "asc" }, select: { issuedAt: true } }),
    getAllWorkers(),
  ]);
  // the same headcount the record form and the alarms multiply a per-worker
  // limit by — the workers on the list today (the list keeps no history)
  const report = buildMonthlyReport(
    items.map((i) => ({ id: i.id, code: i.code, name: i.name, uom: i.uom, active: i.active, rules: i.limits.map(toRule) })),
    uses,
    month,
    { headcount: departmentWorkers(workers) },
  );

  const thisMonth = factoryDayISO(new Date()).slice(0, 7);
  const start = first ? factoryDayISO(first.issuedAt).slice(0, 7) : thisMonth;
  const months: string[] = [];
  for (let m = thisMonth; m >= start && months.length < 60; m = shiftMonth(m, -1)) months.push(m);
  if (!months.includes(month)) months.push(month);

  const prevComplete = first !== null && factoryDayISO(first.issuedAt) <= monthBounds(report.prevMonth).from;
  return {
    ...report,
    rows: prevComplete ? report.rows : report.rows.map((r) => ({ ...r, change: null })),
    months: months.sort().reverse(), prevComplete,
  };
}
