import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine } from "./line";
import { buildMaterialDashboard, type DoneRow, type MaterialDashboard, type MaterialRequest, type SheetLine } from "@/lib/domain/materialDashboard";
import { factoryDayISO, factoryDayStart } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import type { ProductLine } from "@/lib/domain/lines";
import { isDoneStatus } from "@/lib/domain/odoo";

// The material dashboard's one query pair, for the line on screen: every line
// of its material sheet (every month — the domain reads one copy of each MO)
// and its ODOO rows moved to Done from the period before's first day to the
// period's last, blank MOs included so the page can say what did not link.
// The sheet is NOT windowed — an MO closed today was nested whenever it was
// nested. Nothing here writes; the page and the assistant read the same.

export interface MaterialDashboardData extends MaterialDashboard {
  line: ProductLine;
  request: MaterialRequest;
  /** When the sheet and the ODOO log of the line last changed — null when empty. */
  sheetUpdatedISO: string | null;
  odooUpdatedISO: string | null;
}

/** `maxRows`: how many detail rows to carry — the page's few hundred by
 *  default, the assistant's Excel sheet all of them. */
export async function getMaterialDashboard(req: MaterialRequest, lineOverride?: ProductLine, opts: { maxRows?: number } = {}): Promise<MaterialDashboardData> {
  const line = lineOverride ?? (await getActiveLine());
  const firstDay = req.prev?.fromISO ?? req.fromISO;
  const gte = firstDay ? factoryDayStart(firstDay) : null;
  const lt = factoryDayStart(addDaysISO(req.toISO, 1));

  const [material, done, odooLatest] = await Promise.all([
    prisma.materialUsage.findMany({
      where: { line },
      select: {
        month: true, mo: true, soi: true, bom: true, partCode: true, partName: true, material: true, thicknessMm: true, sheetSize: true, units: true,
        sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true, weightKg: true, utilization: true, updatedAt: true,
      },
    }),
    prisma.odooEntry.findMany({
      where: { line, doneAt: { not: null, ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } },
      select: { odooMo: true, qty: true, status: true, doneAt: true },
    }),
    prisma.odooEntry.aggregate({ where: { line }, _max: { updatedAt: true } }),
  ]);

  // Done on Odoo, on the factory's day it was moved there
  const rows: DoneRow[] = done
    .filter((r) => r.doneAt && isDoneStatus(r.status))
    .map((r) => ({ dateISO: factoryDayISO(r.doneAt!), mo: r.odooMo ?? "", qty: r.qty }));
  const lines: SheetLine[] = material;
  const sheetUpdated = material.reduce<Date | null>((m, l) => (!m || l.updatedAt > m ? l.updatedAt : m), null);

  return {
    ...buildMaterialDashboard(lines, rows, req, opts),
    line,
    request: req,
    sheetUpdatedISO: sheetUpdated ? sheetUpdated.toISOString() : null,
    odooUpdatedISO: odooLatest._max.updatedAt ? odooLatest._max.updatedAt.toISOString() : null,
  };
}
