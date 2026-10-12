import "server-only";
import { prisma } from "@/lib/db";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, factoryDayStart, parseISODate, toISODate } from "@/lib/domain/dates";
import { canEditIssue, factoryDateTimeLabel } from "@/lib/domain/consumables";
import { shiftMonth } from "@/lib/domain/consumableMonthly";
import {
  buildPowderReport, describeScrap, isPowderItem, parseScrapSnapshot, powderSpan, scrapChanges,
  type PowderReport, type PowderWithdrawal,
} from "@/lib/domain/powderScrap";
import { sectionLabel } from "@/lib/domain/tanks";

// POWDER SCRAP — the reads. The arithmetic is lib/domain/powderScrap.ts;
// the writes app/consumables/powderActions.ts.

export interface ScrapRevisionView {
  id: number;
  action: "edit" | "delete" | "restore";
  before: string;
  after: string | null;
  changes: string[];
  by: string;
  atLabel: string;
}

export interface ScrapEntryView {
  id: number;
  dayISO: string;
  department: string;
  departmentLabel: string;
  kg: number;
  notes: string | null;
  recordedBy: string;
  recordedAtLabel: string;
  edited: { by: string; atLabel: string } | null;
  canEdit: boolean;
  version: string;
  /** Newest first — admin only. */
  revisions: ScrapRevisionView[];
}

export interface PowderView extends PowderReport {
  /** The month's weighings, newest day first. */
  entries: ScrapEntryView[];
  /** The months the picker offers, newest first. */
  months: string[];
}

/** Powder hand-outs in factory days from..to — every department, every
 *  unit; the report sorts out which count. Deleted hand-outs are out. */
async function loadWithdrawals(fromISO: string, toISO: string): Promise<PowderWithdrawal[]> {
  const gte = factoryDayStart(fromISO);
  const lt = factoryDayStart(addDaysISO(toISO, 1));
  if (!gte || !lt) return [];
  // "powder" in the stored name (a catalogue item is stored under its
  // catalogue name) — the database narrows, the domain rule decides
  const rows = await prisma.consumableIssue.findMany({
    where: { deletedAt: null, issuedAt: { gte, lt }, item: { contains: "powder", mode: "insensitive" } },
    select: { issuedAt: true, department: true, item: true, qty: true, catalog: { select: { uom: true } } },
  });
  return rows
    .filter((r) => isPowderItem(r.item))
    .map((r) => ({ dayISO: factoryDayISO(r.issuedAt), department: r.department, item: r.item, uom: r.catalog?.uom ?? null, qty: r.qty.toNumber() }));
}

export async function getPowderReport(month: string, viewer: { id: number; isAdmin: boolean; canRecord: boolean }): Promise<PowderView> {
  const span = powderSpan(month);
  const [withdrawals, scraps, firstIssue, firstScrap] = await Promise.all([
    loadWithdrawals(span.from, span.to),
    prisma.powderScrap.findMany({
      where: { deletedAt: null, day: { gte: parseISODate(span.from)!, lte: parseISODate(span.to)! } },
      orderBy: [{ day: "desc" }, { id: "desc" }],
      include: viewer.isAdmin ? { revisions: { orderBy: { id: "desc" } } } : undefined,
    }),
    prisma.consumableIssue.findFirst({ where: { deletedAt: null, item: { contains: "powder", mode: "insensitive" } }, orderBy: { issuedAt: "asc" }, select: { issuedAt: true } }),
    prisma.powderScrap.findFirst({ where: { deletedAt: null }, orderBy: { day: "asc" }, select: { day: true } }),
  ]);

  const report = buildPowderReport(
    month,
    withdrawals,
    scraps.map((s) => ({ dayISO: toISODate(s.day), department: s.department, kg: s.kg.toNumber() })),
  );

  const entries: ScrapEntryView[] = scraps
    .filter((s) => toISODate(s.day).slice(0, 7) === month)
    .map((s) => ({
      id: s.id,
      dayISO: toISODate(s.day),
      department: s.department,
      departmentLabel: sectionLabel(s.department),
      kg: s.kg.toNumber(),
      notes: s.notes,
      recordedBy: s.recordedBy,
      recordedAtLabel: factoryDateTimeLabel(s.createdAt),
      edited: s.editedAt && s.editedBy ? { by: s.editedBy, atLabel: factoryDateTimeLabel(s.editedAt) } : null,
      canEdit: canEditIssue(viewer, s),
      version: s.updatedAt.toISOString(),
      revisions: "revisions" in s && Array.isArray(s.revisions)
        ? s.revisions.map((v) => {
          const before = parseScrapSnapshot(v.before);
          const after = parseScrapSnapshot(v.after);
          return {
            id: v.id, action: v.action === "delete" || v.action === "restore" ? v.action : "edit" as const,
            before: describeScrap(before), after: after ? describeScrap(after) : null, changes: scrapChanges(before, after),
            by: v.by, atLabel: factoryDateTimeLabel(v.at),
          };
        })
        : [],
    }));

  // the picker: from the first powder hand-out or weighing to this month
  const thisMonth = factoryDayISO(new Date()).slice(0, 7);
  const starts = [firstIssue ? factoryDayISO(firstIssue.issuedAt).slice(0, 7) : null, firstScrap ? toISODate(firstScrap.day).slice(0, 7) : null].filter((x): x is string => x !== null);
  const start = starts.length ? starts.sort()[0] : thisMonth;
  const months: string[] = [];
  for (let m = thisMonth; m >= start && months.length < 60; m = shiftMonth(m, -1)) months.push(m);
  if (!months.includes(month)) months.push(month);

  return { ...report, entries, months: months.sort().reverse() };
}
