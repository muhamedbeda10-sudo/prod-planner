import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine } from "./line";
import { buildClosedConsumption, type ClosedConsumption, type ClosingRow, type MoMaterialLine } from "@/lib/domain/fabAnalytics";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { isDoneStatus } from "@/lib/domain/odoo";

// The material analytics page's one query pair: the MOs closed on Odoo over a
// window, and every line the Material tab holds under an MO. The lines are
// NOT windowed — an MO closed today was nested whenever it was nested.

/** The windows the page offers, in days back from today. */
export const WINDOWS = [30, 60, 90, 0] as const; // 0 = everything on record
export type Window = (typeof WINDOWS)[number];

export function resolveWindow(raw: string | undefined): Window {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as Window) : 90;
}

export interface FabAnalyticsData extends ClosedConsumption {
  windowDays: Window;
  fromISO: string | null;
  /** Lines on the Material tab filed under an MO, and the MOs they cover —
   *  the page says how much of the plant the tab actually describes. */
  nestingRows: number;
  nestingBoms: number;
}

/**
 * The window's material consumption, booked on the day each MO was closed
 * (moved to Done) on the ODOO tab, through the Material tab's lines of the
 * same MO.
 */
export async function getFabAnalytics(windowDays: Window): Promise<FabAnalyticsData> {
  let from: Date | null = null;
  if (windowDays > 0) {
    from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - windowDays);
  }

  const line = await getActiveLine(); // the line on screen's closings and sheet only
  const [done, material] = await Promise.all([
    prisma.odooEntry.findMany({
      where: { line, odooMo: { not: "" }, doneAt: from ? { gte: from } : { not: null } },
      select: { odooMo: true, qty: true, status: true, doneAt: true },
    }),
    prisma.materialUsage.findMany({
      where: { line, mo: { not: "" } },
      select: { mo: true, partCode: true, material: true, thicknessMm: true, sheetSize: true, sheetsPerUnit: true, actualPerUnit: true, weightKg: true },
    }),
  ]);

  // a row moved back out of Done keeps no doneAt, but check the status too
  const closings: ClosingRow[] = done
    .filter((r) => r.doneAt && isDoneStatus(r.status))
    .map((r) => ({ dateISO: factoryDayISO(r.doneAt!), mo: r.odooMo.trim(), qty: r.qty }));
  const lines: MoMaterialLine[] = material;

  return {
    ...buildClosedConsumption(closings, lines),
    windowDays,
    fromISO: from ? toISODate(from) : null,
    nestingRows: lines.length,
    nestingBoms: new Set(lines.map((l) => l.mo.trim().toUpperCase())).size,
  };
}
