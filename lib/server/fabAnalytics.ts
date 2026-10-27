import "server-only";
import { prisma } from "@/lib/db";
import { buildMaterialDashboard, type DoneRow, type MaterialDashboard, type MaterialRequest, type SheetLine } from "@/lib/domain/materialDashboard";
import { factoryDayISO, factoryDayStart } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import type { ProductLine } from "@/lib/domain/lines";
import { effectiveDoneAt, normMo } from "@/lib/domain/odooSync";
import { moStatesOf } from "@/lib/server/odooFacts";

const DAY_MS = 24 * 60 * 60 * 1000;

// The material dashboard's one query pair, for the line on screen: every line
// of its material sheet (every month — the domain reads one copy of each MO)
// and its ODOO rows moved to Done from the period before's first day to the
// period's last, blank MOs included so the page can say what did not link.
// The sheet is NOT windowed — an MO closed today was nested whenever it was
// nested. Nothing here writes; the page and the assistant read the same.

export interface MaterialDashboardData extends MaterialDashboard {
  /** When the sheet and the ODOO log of the line last changed — null when empty. */
  sheetUpdatedISO: string | null;
  odooUpdatedISO: string | null;
}

/** `maxRows`: how many detail rows to carry — the page's few hundred by
 *  default, the assistant's Excel sheet all of them. */
export async function getMaterialDashboard(req: MaterialRequest, line: ProductLine, opts: { maxRows?: number } = {}): Promise<MaterialDashboardData> {
  const firstDay = req.prev?.fromISO ?? req.fromISO;
  const gte = firstDay ? factoryDayStart(firstDay) : null;
  const lt = factoryDayStart(addDaysISO(req.toISO, 1));

  const [material, done, sheetLatest, odooLatest] = await Promise.all([
    prisma.materialUsage.findMany({
      where: { line },
      select: {
        month: true, mo: true, soi: true, bom: true, partCode: true, partName: true, material: true, thicknessMm: true, sheetSize: true, units: true,
        sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true, weightKg: true, utilization: true,
      },
    }),
    prisma.odooEntry.findMany({
      // a day wider each side: a closing counts on Odoo's own closing day
      // when the sync read it, which can sit a day off the tick here
      where: { line, doneAt: { not: null, ...(gte ? { gte: new Date(gte.getTime() - DAY_MS) } : {}), ...(lt ? { lt: new Date(lt.getTime() + DAY_MS) } : {}) } },
      select: { odooMo: true, qty: true, status: true, doneAt: true },
    }),
    prisma.materialUsage.aggregate({ where: { line }, _max: { updatedAt: true } }),
    prisma.odooEntry.aggregate({ where: { line }, _max: { updatedAt: true } }),
  ]);

  // Done on Odoo, on the factory's day it was closed there — Odoo's own
  // moment when the sync read it, else the moment it was ticked here
  const states = await moStatesOf(done.map((r) => r.odooMo));
  const rows: DoneRow[] = done
    .flatMap((r) => {
      const odooDone = states.get(normMo(r.odooMo))?.doneAtISO;
      const at = effectiveDoneAt(r, odooDone ? new Date(odooDone) : null);
      return at ? [{ dateISO: factoryDayISO(at), mo: r.odooMo ?? "", qty: r.qty }] : [];
    })
    .filter((r) => (!firstDay || r.dateISO >= firstDay) && r.dateISO <= req.toISO);
  const lines: SheetLine[] = material;

  return {
    ...buildMaterialDashboard(lines, rows, req, opts),
    sheetUpdatedISO: sheetLatest._max.updatedAt ? sheetLatest._max.updatedAt.toISOString() : null,
    odooUpdatedISO: odooLatest._max.updatedAt ? odooLatest._max.updatedAt.toISOString() : null,
  };
}
