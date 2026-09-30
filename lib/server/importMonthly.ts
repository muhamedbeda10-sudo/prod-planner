import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseMonthlyPlan, diffRevisionRow, type RevisionChange } from "@/lib/domain/importMonthly";
import { parseChildMos } from "@/lib/domain/childMos";
import { fillBornRowsFromChildMos } from "@/lib/server/odooMirror";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";

export type { RevisionChange };

/** A qty in the sheet that differs from the registry's — NOT applied. It
 *  waits on the order (pendingPlanQty) until the planner uses it or keeps the
 *  old one; shown with what the floor already produced. */
export interface QtyProposal {
  mo: string;
  bom: string;
  from: number; // the registry's qty, kept for now
  to: number; // the sheet's
  produced: number; // max quantity any dept already produced on this MO
  /** Whether the order came from an earlier month's plan (carried over). */
  carried: boolean;
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
  /** Revision diff: every field change on existing MOs but the qty (applied
   *  unless preview). */
  changes?: RevisionChange[];
  /** Existing MOs whose qty in the sheet differs — held for the planner's
   *  decision, never applied by the import. */
  qtyProposals?: QtyProposal[];
  /** Open MOs previously imported from this same month but ABSENT from this
   *  sheet — taken out (unless preview): deleted when nothing was ever
   *  recorded on them, closed when the daily log or a tank names them. */
  removed?: { mo: string; action: "deleted" | "closed" }[];
  /** The sheet's child MOs, when it carries them: stored (new or updated),
   *  rows the sheet flags with none (NOT_IN_BOM, UNRESOLVED …), and ODOO rows
   *  waiting for an MO that took one. */
  childMos?: { stored: number; added: number; flagged: Record<string, number>; filled: number };
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
  const children = parseChildMos(grid);
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

  // ---- REVISION handling: an MO already in the registry — carried over from
  // an earlier month, or re-sent in a revision of the same one — is diffed
  // field by field. Every difference but the qty is applied (unless preview)
  // and reported old → new. The qty is NEVER changed by the import: a
  // different figure is held on the order (pendingPlanQty) and listed, and
  // the planner uses it or keeps the old one, here or on the tracker.
  const changes: RevisionChange[] = [];
  const proposals: { mo: string; from: number; to: number }[] = [];
  const changedRows: { r: (typeof rows)[number] }[] = [];
  const agreed: string[] = []; // a held qty the sheet now matches — nothing left to decide
  for (const r of rows) {
    const cur = byMo.get(r.mo);
    if (!cur) continue;
    const diff = diffRevisionRow(r, cur);
    changes.push(...diff.changes);
    if (diff.qtyProposal) proposals.push(diff.qtyProposal);
    else if (cur.pendingPlanQty !== null) agreed.push(r.mo);
    if (diff.changes.length > 0) changedRows.push({ r });
  }
  if (!preview && (proposals.length > 0 || agreed.length > 0)) {
    const now = new Date();
    await prisma.$transaction([
      ...proposals.map((p) =>
        prisma.masterOrder.update({ where: { mo: p.mo }, data: { pendingPlanQty: p.to, pendingQtyMonth: sourceLabel, pendingQtyAt: now } })
      ),
      ...(agreed.length > 0
        ? [prisma.masterOrder.updateMany({ where: { mo: { in: agreed } }, data: { pendingPlanQty: null, pendingQtyMonth: null, pendingQtyAt: null } })]
        : []),
    ]);
  }
  if (changedRows.length > 0 && !preview) {
    await prisma.$transaction(
      changedRows.map(({ r }) =>
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
            // planQty is NOT here: a different qty waits for the planner
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
  // revision were taken off the plan. They go: deleted outright when nothing
  // was ever recorded on them (the planning layers keyed on the MO with them,
  // as the registry's own delete does), closed when the daily log or a tank
  // already names them — history is never touched.
  const inSheet = new Set(rows.map((r) => r.mo));
  const gone = registry.filter((o) => o.status === "open" && !inSheet.has(o.mo) && monthsOf(o.months || o.source || "").includes(sourceLabel));
  const removed: { mo: string; action: "deleted" | "closed" }[] = [];
  if (gone.length > 0) {
    const keys = gone.map((o) => o.mo);
    const [logged, tanks] = await Promise.all([
      prisma.handoverEntry.groupBy({ by: ["mo"], where: { mo: { in: keys } }, _count: { _all: true } }),
      prisma.tankUnit.groupBy({ by: ["mo"], where: { mo: { in: keys } }, _count: { _all: true } }),
    ]);
    const withHistory = new Set([...logged.map((g) => g.mo), ...tanks.map((g) => g.mo)].filter((m): m is string => !!m));
    for (const o of gone) removed.push({ mo: o.mo, action: withHistory.has(o.mo) ? "closed" : "deleted" });
    if (!preview) {
      const toDelete = removed.filter((r) => r.action === "deleted").map((r) => r.mo);
      const toClose = removed.filter((r) => r.action === "closed").map((r) => r.mo);
      await prisma.$transaction([
        ...(toDelete.length > 0 ? [
          prisma.worklistDateOverride.deleteMany({ where: { mo: { in: toDelete } } }),
          prisma.worklistLineHide.deleteMany({ where: { mo: { in: toDelete } } }),
          prisma.worklistPush.deleteMany({ where: { mo: { in: toDelete } } }),
          prisma.worklistMachine.deleteMany({ where: { mo: { in: toDelete } } }),
          prisma.runOrderEntry.deleteMany({ where: { mo: { in: toDelete } } }),
          prisma.queueNote.deleteMany({ where: { mo: { in: toDelete } } }),
          prisma.masterOrder.deleteMany({ where: { mo: { in: toDelete } } }),
        ] : []),
        ...(toClose.length > 0 ? [prisma.masterOrder.updateMany({ where: { mo: { in: toClose } }, data: { status: "closed", closedAt: new Date() } })] : []),
      ]);
    }
  }

  // each held qty carries what the departments already produced, so a new
  // figure under that count stands out (progress columns in the sheet are
  // ignored entirely — the daily logs are the truth)
  let qtyProposals: QtyProposal[] = [];
  if (proposals.length > 0) {
    const sums = await prisma.handoverEntry.groupBy({
      by: ["mo", "dept", "item"],
      where: { mo: { in: proposals.map((d) => d.mo) } },
      _sum: { qty: true },
    });
    const produced = new Map<string, number>();
    for (const s of sums) {
      if (s.mo) produced.set(s.mo, Math.max(produced.get(s.mo) ?? 0, s._sum.qty ?? 0));
    }
    qtyProposals = proposals.map((d) => {
      const o = byMo.get(d.mo)!;
      const earlier = monthsOf(o.months || o.source || "").some((m) => m !== sourceLabel);
      return { ...d, bom: o.bom, produced: produced.get(d.mo) ?? 0, carried: earlier };
    });
  }

  // ---- the child MOs: added or updated, never cleared — a plan MO keeps the
  // children an earlier sheet gave it. Only the plan MOs of this line's rows.
  let childMos: MonthlyImportResult["childMos"];
  if (children.present) {
    const mine = new Set(rows.map((r) => r.mo.trim().toUpperCase()));
    const list = children.rows.filter((c) => mine.has(c.planMo));
    const keyOf = (c: { planMo: string; component: string; childMo: string }) => `${c.planMo}|${c.component}|${c.childMo}`;
    const existing = new Map(
      (await prisma.childMo.findMany({ where: { planMo: { in: [...mine] } } })).map((c) => [keyOf(c), c]),
    );
    const dataOf = (c: (typeof list)[number]) => ({
      item: c.item, parentMo: c.parentMo, productCode: c.productCode, qty: c.qty, state: c.state,
      linkMethod: c.linkMethod, remarks: c.remarks, planMonth: c.planMonth ?? sourceLabel,
    });
    const creates = list.filter((c) => !existing.has(keyOf(c)));
    // only the children whose details moved (their Odoo state, mostly)
    const updates = list.flatMap((c) => {
      const cur = existing.get(keyOf(c));
      if (!cur) return [];
      const d = dataOf(c);
      const same = (Object.keys(d) as (keyof typeof d)[]).every((k) => cur[k] === d[k]);
      return same ? [] : [{ id: cur.id, data: d }];
    });
    const added = creates.length;
    let filled = 0;
    if (!preview) {
      // in bulk — a sheet of hundreds of children written one by one outlasts the request
      if (creates.length) {
        await prisma.childMo.createMany({
          data: creates.map((c) => ({ planMo: c.planMo, component: c.component, childMo: c.childMo, ...dataOf(c) })),
          skipDuplicates: true,
        });
      }
      for (let i = 0; i < updates.length; i += 100) {
        await prisma.$transaction(updates.slice(i, i + 100).map((u) => prisma.childMo.update({ where: { id: u.id }, data: u.data })));
      }
      filled = await prisma.$transaction((tx) => fillBornRowsFromChildMos(tx), { timeout: 60_000 });
    }
    childMos = { stored: list.length, added, flagged: children.flagged, filled };
  }

  return {
    ok: true,
    childMos,
    added: toAdd.length,
    existing: rows.length - toAdd.length,
    updatedMos: changedRows.length,
    totalOrders: await prisma.masterOrder.count({ where: { line } }),
    addedMos: toAdd.slice(0, 30).map((r) => r.mo),
    issues: issues.filter((m) => !m.startsWith("Progress sections")),
    preview,
    changes: changes.slice(0, 300),
    qtyProposals,
    removed,
  };
}
