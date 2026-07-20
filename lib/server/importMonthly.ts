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

/** One field change detected on an existing MO in a plan REVISION. */
export interface RevisionChange {
  mo: string;
  field: string;
  from: string;
  to: string;
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
  /** Revision diff: every field change on existing MOs (applied unless preview). */
  changes?: RevisionChange[];
  /** Open MOs previously imported from this same month but ABSENT from this
   *  sheet — reported only, never auto-closed. */
  missingFromSheet?: string[];
  /** REPORT ONLY — the sheet's done quantities vs our system. Never applied. */
  comparison?: ComparisonRow[];
  comparedCells?: number; // how many MO×item×stage cells were compared
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
  const S = (v: string | null | undefined) => (v ?? "").trim();
  const FIELDS: { field: string; get: (r: (typeof rows)[number]) => string; cur: (o: (typeof registry)[number]) => string }[] = [
    { field: "Qty", get: (r) => String(r.planQty), cur: (o) => String(o.planQty) },
    { field: "Urgent", get: (r) => (r.urgent ? "Yes" : "No"), cur: (o) => (o.urgent ? "Yes" : "No") },
    { field: "BOM", get: (r) => S(r.bom), cur: (o) => S(o.bom) },
    { field: "SOI", get: (r) => S(r.soi), cur: (o) => S(o.soi) },
    { field: "Customer", get: (r) => S(r.customer), cur: (o) => S(o.customer) },
    { field: "FG Code", get: (r) => S(r.fgCode), cur: (o) => S(o.fgCode) },
    { field: "KVA", get: (r) => S(r.kva), cur: (o) => S(o.kva) },
    { field: "Rating", get: (r) => S(r.rating), cur: (o) => S(o.rating) },
    { field: "SEC Item", get: (r) => S(r.secItem), cur: (o) => S(o.secItem) },
    { field: "Color RAL", get: (r) => S(r.colorRal), cur: (o) => S(o.colorRal) },
    { field: "Remarks", get: (r) => S(r.remarks), cur: (o) => S(o.remarks) },
    { field: "OSP CF", get: (r) => String(r.osp.CF), cur: (o) => String(o.ospCF) },
    { field: "OSP TC", get: (r) => String(r.osp.TC), cur: (o) => String(o.ospTC) },
    { field: "OSP TN", get: (r) => String(r.osp.TN), cur: (o) => String(o.ospTN) },
    { field: "OSP CB", get: (r) => String(r.osp.CB), cur: (o) => String(o.ospCB) },
  ];

  const changes: RevisionChange[] = [];
  const changedRows = rows.filter((r) => {
    const cur = byMo.get(r.mo);
    if (!cur) return false;
    let changed = false;
    for (const f of FIELDS) {
      const from = f.cur(cur);
      const to = f.get(r);
      if (from !== to) {
        changes.push({ mo: r.mo, field: f.field, from: from || "—", to: to || "—" });
        changed = true;
      }
    }
    return changed;
  });
  if (changedRows.length > 0 && !preview) {
    await prisma.$transaction(
      changedRows.map((r) =>
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
            planQty: r.planQty,
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

  // warn when a revision cuts an order below what we already produced
  for (const r of changedRows) {
    const cur = byMo.get(r.mo)!;
    if (r.planQty < cur.planQty) {
      let maxDone = 0;
      for (const it of ["CF", "TC", "TN", "CB"] as const) {
        for (const dept of ["Cut", "Welding", "Painting"]) {
          maxDone = Math.max(maxDone, system.get(`${r.mo}|${dept}|${it}`) ?? 0);
        }
      }
      if (maxDone > r.planQty) {
        issues.push(`${r.mo}: revised qty ${r.planQty} is BELOW what is already produced (${maxDone}) — check with planning.`);
      }
    }
  }

  return {
    ok: true,
    added: toAdd.length,
    existing: rows.length - toAdd.length,
    updatedMos: changedRows.length,
    totalOrders: await prisma.masterOrder.count(),
    addedMos: toAdd.slice(0, 30).map((r) => r.mo),
    issues,
    preview,
    changes: changes.slice(0, 300),
    missingFromSheet,
    comparison: comparison.slice(0, 200),
    comparedCells,
  };
}
