import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine } from "./line";
import { buildMaterialDashboard, type DoneRow, type MaterialDashboard, type SheetLine } from "@/lib/domain/materialDashboard";
import { factoryDayISO, factoryToday, toISODate } from "@/lib/domain/dates";
import { isDoneStatus } from "@/lib/domain/odoo";

// The material dashboard's one query pair: every MO closed on Odoo, and every
// line of the material sheet. The sheet is NOT windowed — an MO closed today
// was nested whenever it was nested.

/** The windows the page offers, in days back from today. */
export const WINDOWS = [30, 60, 90, 0] as const; // 0 = everything on record
export type Window = (typeof WINDOWS)[number];

export function resolveWindow(raw: string | undefined): Window {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as Window) : 90;
}

export interface MaterialDashboardData extends MaterialDashboard {
  windowDays: Window;
  fromISO: string | null;
}

/**
 * The material dashboard: the whole material sheet, and the window's
 * closings on the ODOO log of the sheet's MOs — booked on the day each was
 * moved to Done.
 */
export async function getMaterialDashboard(windowDays: Window): Promise<MaterialDashboardData> {
  let from: Date | null = null;
  if (windowDays > 0) {
    from = factoryToday();
    from.setUTCDate(from.getUTCDate() - windowDays);
  }

  const line = await getActiveLine(); // the line on screen's sheet and closings only
  const [done, material] = await Promise.all([
    // every closing — what is still open needs all of them; the window picks its own
    prisma.odooEntry.findMany({
      where: { line, odooMo: { not: "" }, doneAt: { not: null } },
      select: { odooMo: true, qty: true, status: true, doneAt: true },
    }),
    prisma.materialUsage.findMany({
      where: { line, month: "" },
      select: {
        mo: true, soi: true, bom: true, partCode: true, partName: true, material: true, thicknessMm: true, sheetSize: true, units: true,
        sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true, weightKg: true, utilization: true,
      },
    }),
  ]);

  const rows: DoneRow[] = done
    .filter((r) => r.doneAt && isDoneStatus(r.status))
    .map((r) => ({ dateISO: factoryDayISO(r.doneAt!), mo: r.odooMo.trim(), qty: r.qty }));
  const fromISO = from ? toISODate(from) : null;
  const lines: SheetLine[] = material;

  return { ...buildMaterialDashboard(lines, rows, fromISO), windowDays, fromISO };
}
