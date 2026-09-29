import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO } from "@/lib/domain/dates";
import { buildMonthlyReport, reportSpan, shiftMonth, type MonthlyReport } from "@/lib/domain/consumableMonthly";
import { loadUses, toRule } from "./consumableLimits";

// The CONSUMABLES monthly review — the reads. The arithmetic is
// lib/domain/consumableMonthly.ts.

export interface MonthlyReportView extends MonthlyReport {
  /** Worker names for the per-person limits' "over" lists. */
  workers: Record<number, { name: string; empId: string }>;
  /** The months the picker offers: the first month anything was handed out
   *  to this month, newest first. */
  months: string[];
}

export async function getMonthlyReport(month: string): Promise<MonthlyReportView> {
  const span = reportSpan(month);
  const [items, uses, first] = await Promise.all([
    prisma.consumableItem.findMany({ orderBy: { name: "asc" }, include: { limits: { orderBy: { id: "asc" } } } }),
    loadUses(span.from, span.to),
    prisma.consumableIssue.findFirst({ where: { deletedAt: null }, orderBy: { issuedAt: "asc" }, select: { issuedAt: true } }),
  ]);
  const report = buildMonthlyReport(
    items.map((i) => ({ id: i.id, code: i.code, name: i.name, uom: i.uom, active: i.active, rules: i.limits.map(toRule) })),
    uses,
    month,
  );

  const ids = [...new Set(report.rows.flatMap((r) => r.limits.flatMap((l) => l.workersOver.map((w) => w.workerId))))];
  const workers = ids.length
    ? Object.fromEntries((await prisma.worker.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, empId: true } })).map((w) => [w.id, { name: w.name, empId: w.empId }]))
    : {};

  const thisMonth = factoryDayISO(new Date()).slice(0, 7);
  const start = first ? factoryDayISO(first.issuedAt).slice(0, 7) : thisMonth;
  const months: string[] = [];
  for (let m = thisMonth; m >= start && months.length < 60; m = shiftMonth(m, -1)) months.push(m);
  if (!months.includes(month)) months.push(month);

  return { ...report, workers, months: months.sort().reverse() };
}
