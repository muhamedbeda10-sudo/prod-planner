import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseMonthlyPlan, diffRevisionRow, type RevisionChange } from "@/lib/domain/importMonthly";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";

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

/** Import one month's plan for ONE product line. Every order it adds is
 *  stamped with the line; an MO already filed under the OTHER line is a
 *  mistake in the sheet, not a revision, and is refused with its row. */
export async function importMonthlyPlan(buffer: ArrayBuffer, sourceLabel: string, preview = false, line: ProductLine = "TR"): Promise<MonthlyImportResult> {
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

  const parsed = parseMonthlyPlan(grid, line);
  const issues = [...parsed.issues];
  if (parsed.rows.length === 0) {
    return { ok: false, error: issues[0] ?? "No order rows found.", issues };
  }

  // MOs are one namespace across both lines — the same MO cannot be a
  // transformer and a panel. A row whose MO sits on the other line is left
  // out and named, so the sheet (or the toggle) gets fixed rather than the
  // order silently changing sides.
  const everything = await prisma.masterOrder.findMany();
  const elsewhere = new Map(everything.filter((o) => o.line !== line).map((o) => [o.mo, o.line]));
  const rows = parsed.rows.filter((r) => {
    const other = elsewhere.get(r.mo);
    if (!other) return true;
    issues.push(`Row ${r.rowNum}: MO "${r.mo}" is already in the registry as ${LINE_LABEL[other as ProductLine] ?? other} — skipped. Switch the line at the top if this sheet is that line's.`);
    return false;
  });
  if (rows.length === 0) {
    return { ok: false, error: `Every MO in this sheet is already filed under the other product line — is the toggle at the top on ${LINE_LABEL[line]} by mistake?`, issues };
  }
  const registry = everything.filter((o) => o.line === line);
  const byMo = new Map(registry.map((o) => [o.mo, o]));

  const toAdd = rows.filter((r) => !byMo.has(r.mo));
  if (toAdd.length > 0 && !preview) {
    await prisma.masterOrder.createMany({
      data: toAdd.map((r) => ({
        mo: r.mo,
        line,
        months: sourceLabel,
        soi: r.soi,
        urgent: r.urgent,
        customer: r.customer,
        fgCode: r.fgCode,
        bom: r.bom,
        kva: r.kva,
        rating: r.rating,
        secItem: r.secItem,
        planQty: r.planQty,
        remarks: r.remarks,
        product: r.product,
        ospEncloser: r.ospEncloser,
        materialsRemarks: r.materialsRemarks,
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
            // Fins / Color / CRC / SFM are NOT here on purpose: they are the
            // planner's own columns, typed on the tracker. A re-import of the
            // monthly plan must never blank or overwrite what he wrote.
            remarks: r.remarks,
            product: r.product,
            ospEncloser: r.ospEncloser,
            materialsRemarks: r.materialsRemarks,
            ospCF: r.osp.CF,
            ospTC: r.osp.TC,
            ospTN: r.osp.TN,
            ospCB: r.osp.CB,
          },
        })
      )
    );
  }

  // an EXISTING MO appearing in another month's plan gets that month appended
  // to its list — it shows under every month it belonged to (carried-over
  // orders get a badge on the tracker). Change data stays untouched.
  const monthsOf = (csv: string) => csv.split(",").map((s) => s.trim()).filter(Boolean);
  const carried = rows
    .map((r) => byMo.get(r.mo))
    .filter((o): o is NonNullable<typeof o> => !!o && !monthsOf(o.months || o.source || "").includes(sourceLabel));
  if (carried.length > 0 && !preview) {
    await prisma.$transaction(
      carried.map((o) =>
        prisma.masterOrder.update({
          where: { mo: o.mo },
          data: { months: [...monthsOf(o.months || o.source || ""), sourceLabel].join(",") },
        })
      )
    );
  }

  // MOs previously listed under THIS month's plan but missing from the new
  // revision — the planner may have cancelled them. Reported, never touched.
  const inSheet = new Set(rows.map((r) => r.mo));
  const missingFromSheet = registry
    .filter((o) => o.status === "open" && !inSheet.has(o.mo) && monthsOf(o.months || o.source || "").includes(sourceLabel))
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
    totalOrders: await prisma.masterOrder.count({ where: { line } }),
    addedMos: toAdd.slice(0, 30).map((r) => r.mo),
    issues: issues.filter((m) => !m.startsWith("Progress sections")),
    preview,
    changes: changes.slice(0, 300),
    qtyReductions,
    missingFromSheet,
  };
}
