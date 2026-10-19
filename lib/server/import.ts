import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseWeeklyPlan, type ImportWarning } from "@/lib/domain/importPlan";

export interface ImportResult {
  ok: boolean;
  error?: string;
  planNo?: number;
  sheetName?: string;
  orderCount?: number;
  scheduleCount?: number;
  warnings?: ImportWarning[];
  /** true = nothing was written, this is a dry-run report. */
  preview?: boolean;
  /** The plan's orders the import replaces (a dry run's count). */
  replacedOrders?: number;
}

/** Pick the sheet to import: explicit request > "week-<planNo>" > single sheet. */
function pickSheet(wb: XLSX.WorkBook, planNo: number, requested?: string): string | null {
  if (requested) {
    const hit = wb.SheetNames.find((n) => n.trim().toLowerCase() === requested.trim().toLowerCase());
    return hit ?? null;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = `week${planNo}`;
  const byName = wb.SheetNames.find((n) => norm(n) === want);
  if (byName) return byName;
  if (wb.SheetNames.length === 1) return wb.SheetNames[0];
  return null;
}

const MS_PER_DAY = 86400000;

export async function importWeeklyPlan(
  buffer: ArrayBuffer,
  planNo: number,
  startDate: Date,
  sheetName?: string,
  preview = false
): Promise<ImportResult> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  const name = pickSheet(wb, planNo, sheetName);
  if (!name) {
    return {
      ok: false,
      error:
        `The workbook has ${wb.SheetNames.length} sheets and none is named "week-${planNo}". ` +
        `Type the sheet name to import. Available: ${wb.SheetNames.join(", ")}`,
    };
  }
  const ws = wb.Sheets[name];
  if (!ws) return { ok: false, error: "The file has no sheets." };
  // Force the read range to start at A1 so absolute row 6 is always grid index 5,
  // even when the sheet's leading rows are blank (which would otherwise be trimmed).
  const opts: XLSX.Sheet2JSONOpts = { header: 1, raw: true, defval: null, blankrows: true };
  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0;
    range.s.c = 0;
    opts.range = XLSX.utils.encode_range(range);
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, opts);

  const parsed = parseWeeklyPlan(grid);
  if (parsed.orders.length === 0) {
    return { ok: false, error: "No order rows found (data starts on row 6 and the MO column is required)." };
  }

  // a dry run: what the import would put in, and what it would replace
  if (preview) {
    return {
      ok: true,
      preview: true,
      planNo,
      sheetName: name,
      orderCount: parsed.orders.length,
      scheduleCount: parsed.schedules.length,
      warnings: parsed.warnings,
      replacedOrders: await prisma.planOrder.count({ where: { planNo } }),
    };
  }

  // Idempotent replace: wipe this plan's orders + schedules, keep the header +
  // handover — all in one transaction, so a failure part-way leaves the week's
  // plan as it was instead of empty.
  await prisma.$transaction([
    prisma.plan.upsert({
      where: { planNo },
      create: { planNo, startDate },
      update: { startDate },
    }),
    prisma.planOrder.deleteMany({ where: { planNo } }),
    prisma.planSchedule.deleteMany({ where: { planNo } }),
    prisma.planOrder.createMany({
      data: parsed.orders.map((o) => ({
        planNo,
        bom: o.bom,
        soi: o.soi,
        mo: o.mo,
        description: o.description,
        item: o.item,
        requiredQty: o.requiredQty,
        plannerBalance: o.plannerBalance,
        targetQty: o.targetQty,
        remark: o.remark,
      })),
    }),
    prisma.planSchedule.createMany({
      data: parsed.schedules.map((s) => ({
        planNo,
        bom: s.bom,
        soi: s.soi,
        mo: s.mo,
        description: s.description,
        item: s.item,
        ovenDate: new Date(startDate.getTime() + s.dayOffset * MS_PER_DAY),
        qty: s.qty,
      })),
    }),
  ]);

  return {
    ok: true,
    planNo,
    sheetName: name,
    orderCount: parsed.orders.length,
    scheduleCount: parsed.schedules.length,
    warnings: parsed.warnings,
  };
}
