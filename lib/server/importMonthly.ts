import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseMonthlyPlan, diffRevisionRow, type RevisionChange } from "@/lib/domain/importMonthly";

export type { RevisionChange };

/** A qty DECREASE found in a revision — never applied automatically. */
export interface QtyReduction {
  mo: string;
  from: number;
  to: number;
  produced: number; // max quantity any dept already produced on this MO
}

export interface MonthlyImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  existing?: number; // MOs already in the registry
  updatedMos?: number; // existing MOs whose plan fields changed in this revision
  totalOrders?: number; // registry size after the import
  addedMos?: string[]; // first N new MOs for the confirmation view
  issues?: string[];
  preview?: boolean; // true = nothing was written, this is a dry-run report
  /** Revision diff: every field change on existing MOs (applied unless preview).
   *  Qty changes appear here only when the qty GREW — decreases are never
   *  applied automatically and are listed in qtyReductions instead. */
  changes?: RevisionChange[];
  /** Qty decreases in the sheet — reported for MANUAL action on the tracker. */
  qtyReductions?: QtyReduction[];
  /** Open MOs previously imported from this same month but ABSENT from this
   *  sheet — reported only, never auto-closed. */
  missingFromSheet?: string[];
}

export async function importMonthlyPlan(buffer: ArrayBuffer, sourceLabel: string, preview = false): Promise<MonthlyImportResult> {
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

  const registry = await prisma.masterOrder.findMany();
  const byMo = new Map(registry.map((o) => [o.mo, o]));

  const toAdd = rows.filter((r) => !byMo.has(r.mo));
  if (toAdd.length > 0 && !preview) {
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

  // ---- REVISION handling: mid-month the planner re-sends the same plan with
  // edits. Existing MOs are diffed field by field; every difference is applied
  // (unless preview) and reported as old → new so nothing changes silently.
  // EXCEPTION — plan qty: an INCREASE is applied like any other change, but a
  // DECREASE is only reported; the planner confirms and lowers it manually
  // (a lowered qty may cancel work the departments already produced).
  const changes: RevisionChange[] = [];
  const reductions: { mo: string; from: number; to: number }[] = [];
  const changedRows: { r: (typeof rows)[number]; planQty: number }[] = [];
  for (const r of rows) {
    const cur = byMo.get(r.mo);
    if (!cur) continue;
    const diff = diffRevisionRow(r, cur);
    changes.push(...diff.changes);
    if (diff.qtyReduction) reductions.push(diff.qtyReduction);
    if (diff.changes.length > 0) changedRows.push({ r, planQty: diff.planQty });
  }
  if (changedRows.length > 0 && !preview) {
    await prisma.$transaction(
      changedRows.map(({ r, planQty }) =>
        prisma.masterOrder.update({
          where: { mo: r.mo },
          data: {
            soi: r.soi,
            urgent: r.urgent,
            customer: r.customer,
            fgCode: r.fgCode,
            bom: r.bom,
            kva: r.kva,
            rating: r.rating,
            secItem: r.secItem,
            planQty, // never lowered here — decreases stay manual
            colorRal: r.colorRal,
            remarks: r.remarks,
            ospCF: r.osp.CF,
            ospTC: r.osp.TC,
            ospTN: r.osp.TN,
            ospCB: r.osp.CB,
          },
        })
      )
    );
  }

  // MOs previously imported from THIS month's plan but missing from the new
  // revision — the planner may have cancelled them. Reported, never touched.
  const inSheet = new Set(rows.map((r) => r.mo));
  const missingFromSheet = registry
    .filter((o) => o.source === sourceLabel && o.status === "open" && !inSheet.has(o.mo))
    .map((o) => o.mo);

  // qty decreases are never applied — enrich each with what the departments
  // already produced so the planner can judge the manual change (progress
  // columns in the sheet are ignored entirely — the daily logs are the truth)
  let qtyReductions: QtyReduction[] = [];
  if (reductions.length > 0) {
    const sums = await prisma.handoverEntry.groupBy({
      by: ["mo", "dept", "item"],
      where: { mo: { in: reductions.map((d) => d.mo) } },
      _sum: { qty: true },
    });
    const produced = new Map<string, number>();
    for (const s of sums) {
      if (s.mo) produced.set(s.mo, Math.max(produced.get(s.mo) ?? 0, s._sum.qty ?? 0));
    }
    qtyReductions = reductions.map((d) => ({ ...d, produced: produced.get(d.mo) ?? 0 }));
  }

  return {
    ok: true,
    added: toAdd.length,
    existing: rows.length - toAdd.length,
    updatedMos: changedRows.length,
    totalOrders: await prisma.masterOrder.count(),
    addedMos: toAdd.slice(0, 30).map((r) => r.mo),
    issues: issues.filter((m) => !m.startsWith("Progress sections")),
    preview,
    changes: changes.slice(0, 300),
    qtyReductions,
    missingFromSheet,
  };
}
