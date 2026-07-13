import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseMonthlyPlan, applyCascade } from "@/lib/domain/importMonthly";

export interface ComparisonRow {
  mo: string;
  bom: string;
  item: string;
  stage: "Cut" | "Welding" | "Painting";
  sheet: number; // cascaded sheet value
  system: number; // our logs (setup + daily)
  diff: number; // sheet − system
}

export interface MonthlyImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  existing?: number; // MOs already in the registry — left untouched
  totalOrders?: number; // registry size after the import
  addedMos?: string[]; // first N new MOs for the confirmation view
  issues?: string[];
  /** REPORT ONLY — the sheet's done quantities vs our system. Never applied. */
  comparison?: ComparisonRow[];
  comparedCells?: number; // how many MO×item×stage cells were compared
}

export async function importMonthlyPlan(buffer: ArrayBuffer, sourceLabel: string): Promise<MonthlyImportResult> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { ok: false, error: "The file has no sheets." };
  const opts: XLSX.Sheet2JSONOpts = { header: 1, raw: true, defval: null, blankrows: true };
  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0;
    range.s.c = 0;
    opts.range = XLSX.utils.encode_range(range);
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, opts);

  const { rows, issues } = parseMonthlyPlan(grid);
  if (rows.length === 0) {
    return { ok: false, error: issues[0] ?? "No order rows found.", issues };
  }

  const existingMos = new Set(
    (await prisma.masterOrder.findMany({ select: { mo: true } })).map((o) => o.mo)
  );

  const toAdd = rows.filter((r) => !existingMos.has(r.mo));
  if (toAdd.length > 0) {
    await prisma.masterOrder.createMany({
      data: toAdd.map((r) => ({
        mo: r.mo,
        soi: r.soi,
        urgent: r.urgent,
        customer: r.customer,
        fgCode: r.fgCode,
        bom: r.bom,
        kva: r.kva,
        rating: r.rating,
        secItem: r.secItem,
        planQty: r.planQty,
        colorRal: r.colorRal,
        remarks: r.remarks,
        source: sourceLabel,
        ospCF: r.osp.CF,
        ospTC: r.osp.TC,
        ospTN: r.osp.TN,
        ospCB: r.osp.CB,
      })),
    });
  }

  // Existing MOs stay untouched EXCEPT their OSP status — outsourcing lives in
  // the monthly sheet, so a re-import refreshes it.
  const existing = rows.filter((r) => existingMos.has(r.mo));
  if (existing.length > 0) {
    await prisma.$transaction(
      existing.map((r) =>
        prisma.masterOrder.update({
          where: { mo: r.mo },
          data: { ospCF: r.osp.CF, ospTC: r.osp.TC, ospTN: r.osp.TN, ospCB: r.osp.CB },
        })
      )
    );
  }

  // ---- comparison report (display only — our data is NEVER changed by it) ----
  const sums = await prisma.handoverEntry.groupBy({
    by: ["mo", "dept", "item"],
    where: { mo: { not: null } },
    _sum: { qty: true },
  });
  const system = new Map<string, number>();
  for (const s of sums) if (s.mo) system.set(`${s.mo}|${s.dept}|${s.item}`, s._sum.qty ?? 0);

  const STAGE: { key: "cut" | "weld" | "paint"; dept: ComparisonRow["stage"] }[] = [
    { key: "cut", dept: "Cut" },
    { key: "weld", dept: "Welding" },
    { key: "paint", dept: "Painting" },
  ];
  const comparison: ComparisonRow[] = [];
  let comparedCells = 0;
  for (const r of rows) {
    const eff = applyCascade(r.done, r.planQty);
    for (const it of ["CF", "TC", "TN", "CB"] as const) {
      for (const { key, dept } of STAGE) {
        comparedCells++;
        const sheet = eff[key][it];
        const sys = system.get(`${r.mo}|${dept}|${it}`) ?? 0;
        if (sheet !== sys) comparison.push({ mo: r.mo, bom: r.bom, item: it, stage: dept, sheet, system: sys, diff: sheet - sys });
      }
    }
  }
  comparison.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    ok: true,
    added: toAdd.length,
    existing: rows.length - toAdd.length,
    totalOrders: await prisma.masterOrder.count(),
    addedMos: toAdd.slice(0, 30).map((r) => r.mo),
    issues,
    comparison: comparison.slice(0, 200),
    comparedCells,
  };
}
