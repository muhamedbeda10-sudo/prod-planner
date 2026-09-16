import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine, ledgerItemWhere } from "./line";
import { buildFabAnalytics, type FabAnalytics, type NestingRow, type OutputRow } from "@/lib/domain/fabAnalytics";
import { toISODate } from "@/lib/domain/dates";

// The Fabrication analytics page's one query pair: the daily log's cut rows
// over a window, and every nesting line the Material tab holds. The nesting
// lines are NOT windowed — a BOM cut last week was nested whenever it was
// nested, and its bill of sheets is just as true today.

/** The windows the page offers, in days back from today. */
export const WINDOWS = [30, 60, 90, 0] as const; // 0 = everything on record
export type Window = (typeof WINDOWS)[number];

export function resolveWindow(raw: string | undefined): Window {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as Window) : 90;
}

export interface FabAnalyticsData extends FabAnalytics {
  windowDays: Window;
  fromISO: string | null;
  /** Nesting lines on record, and the BOMs they cover — the page says how much
   *  of the plant the Material tab actually describes. */
  nestingRows: number;
  nestingBoms: number;
}

export async function getFabAnalytics(windowDays: Window): Promise<FabAnalyticsData> {
  let from: Date | null = null;
  if (windowDays > 0) {
    from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - windowDays);
  }

  const line = await getActiveLine(); // the line on screen's sheets and cutting only
  const [entries, nesting] = await Promise.all([
    prisma.handoverEntry.findMany({
      where: { dept: "Cut", ...ledgerItemWhere(line), ...(from ? { date: { gte: from } } : {}) },
      select: { date: true, bom: true, item: true, qty: true },
    }),
    prisma.materialUsage.findMany({
      where: { line, partCode: { not: "" }, sheetsPerUnit: { gt: 0 } },
      select: { month: true, bom: true, mo: true, partCode: true, material: true, thicknessMm: true, sheetSize: true, sheetsPerUnit: true },
    }),
  ]);

  const output: OutputRow[] = entries.map((e) => ({
    dateISO: toISODate(e.date),
    bom: e.bom,
    item: e.item,
    qty: e.qty,
  }));
  const rows: NestingRow[] = nesting.map((n) => ({
    month: n.month,
    bom: n.bom,
    mo: n.mo,
    partCode: n.partCode,
    material: n.material,
    thicknessMm: n.thicknessMm,
    sheetSize: n.sheetSize,
    sheetsPerUnit: n.sheetsPerUnit,
  }));

  return {
    ...buildFabAnalytics(output, rows),
    windowDays,
    fromISO: from ? toISODate(from) : null,
    nestingRows: rows.length,
    nestingBoms: new Set(rows.map((r) => r.bom.trim().toUpperCase())).size,
  };
}
