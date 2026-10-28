import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getActiveLine } from "./line";
import {
  actualPerUnit, adoptedPartLine, lineClosings, materialClosings, materialPlanIndex, materialPlanMonths, traceMaterialMatch, type MaterialClosings, type OdooClosingRow, nestingSpecKey, parseNestingTracker, sheetsDifference, sheetsForJob, sheetsForProduced,
  type MaterialLineView, type MaterialPlanIndex,
} from "@/lib/domain/material";
import { lvActualRate, lvRemainingUnits, parseLvConsumption } from "@/lib/domain/lvMaterial";
import { LV_ITEM } from "@/lib/domain/lv";
import { ODOO_CANCELLED_STATUS, isDoneStatus } from "@/lib/domain/odoo";
import type { ProductLine } from "@/lib/domain/lines";

export interface MaterialPageData {
  lines: MaterialLineView[];
  /** Each MO the ODOO log carries (upper case) → its status there, so the
   *  sheet's rows show which MOs the clerk has typed in. */
  odooByMo: Record<string, string>;
}

type Row = {
  id: number; month: string; bom: string; mo: string; units: number; partCode: string; partName: string; materialCode: string;
  material: string; thicknessMm: number;
  sheetSize: string; sheetsPerUnit: number; actualPerUnit: number | null; actualPerUnitManual: boolean;
  sheetsUsed: number | null; producedQty: number | null;
  soi: string; mtr: string; weightKg: number | null; utilization: number | null;
  note: string | null; recordedBy: string | null; updatedAt: Date;
};

/** What the ODOO log says of the lines' MOs: the day a part MO was closed
 *  Done, what each closed and whose it is; and which MOs are orders of the
 *  registry (the sheet may file the order's MO rather than the part's). */
interface OdooLinks {
  doneByMo: ReadonlyMap<string, string>;
  closings: MaterialClosings;
  isOrder: (mo: string) => boolean;
}

/** `lv`: the panels' tab counts units produced (the sheet's count, else the
 *  tracker's painted); the transformers' counts the pieces closed Done on the
 *  ODOO log — a transformer line's old typed quantity is not shown or costed. */
function toView(r: Row, lv: boolean, plans: MaterialPlanIndex, odoo: OdooLinks, producedAuto: number | null = null): MaterialLineView {
  const mo = r.mo.trim().toUpperCase();
  // the panels' sheet files each order's MO and counts painted panels; the
  // ODOO log's part MOs are the transformers'
  const link = lv ? { orderMos: [], partMos: [], closed: null } : lineClosings(r, odoo.isOrder, odoo.closings);
  const plan = materialPlanMonths(r, plans, odoo.doneByMo.get(mo) ?? null, link.orderMos);
  const forJob = sheetsForJob(r.sheetsPerUnit, r.units);
  // the sheet's count; else the tracker's painted count on the line's own order
  const producedUsed = lv ? (r.producedQty ?? producedAuto) : link.closed;
  return {
    producedAuto: lv ? producedAuto : link.closed,
    producedUsed,
    remainingUnits: r.mo ? lvRemainingUnits(r.units, producedUsed) : null,
    id: r.id, month: r.month, bom: r.bom, mo: r.mo, units: r.units,
    partCode: r.partCode, partName: r.partName, materialCode: r.materialCode, material: r.material,
    thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, sheetsPerUnit: r.sheetsPerUnit,
    sheetsUsed: r.sheetsUsed, producedQty: r.producedQty, note: r.note,
    soi: r.soi, mtr: r.mtr, weightKg: r.weightKg, utilization: r.utilization,
    actualWeightKg: r.sheetsUsed !== null && r.weightKg !== null ? Math.round(r.sheetsUsed * r.weightKg * 100) / 100 : null,
    forJob,
    difference: sheetsDifference(forJob, r.sheetsUsed),
    // the sheet's own rate where there is one; the old division only where
    // the line predates the column or was typed in by hand
    actualPerUnit: actualPerUnit(r.actualPerUnit, r.sheetsUsed, r.units),
    forProduced: sheetsForProduced(r.actualPerUnit, r.sheetsUsed, r.units, producedUsed),
    updatedISO: r.updatedAt.toISOString().slice(0, 10),
    recordedBy: r.recordedBy,
    planMonths: plan.months,
    planMatch: plan.match,
    orderMos: link.orderMos,
    partMos: link.partMos,
  };
}

/** The tab: the living sheet (`month` "", the default), one older sheet
 *  filed under its plan month, or everything ("all"). */
export async function getMaterialData(month: string): Promise<MaterialPageData> {
  const line = await getActiveLine(); // one product line at a time
  return loadMaterial(line, month === "all" ? { line } : { month, line });
}

/** An MO, SOI or code as the registry and the ODOO log are matched by. */
const up = (v: string) => v.trim().toUpperCase();

/** One order's (or one code's) lines of the sheet, for its trace — which
 *  lines, lib/domain/material.ts traceMaterialMatch says. Everything is read
 *  for those lines alone, never the whole line's log and registry. */
export async function getTraceMaterial(line: ProductLine, target: { scope: "mo" | "bom"; mos: readonly string[]; bom: string; sois: readonly string[] }): Promise<MaterialPageData> {
  const mos = [...new Set(target.mos.map(up).filter(Boolean))];
  const sois = [...new Set(target.sois.map(up).filter(Boolean))];
  const bom = up(target.bom);
  // the part MOs closed against these orders on the ODOO log: their lines
  // belong here whatever SOI or code the sheet files them under
  const [closings, soiOrders] = await Promise.all([
    mos.length > 0 ? prisma.handoverEntry.findMany({ where: { mo: { in: mos, mode: "insensitive" } }, select: { id: true } }) : [],
    sois.length > 0 ? prisma.masterOrder.findMany({ where: { line, soi: { in: sois, mode: "insensitive" } }, select: { mo: true, soi: true, bom: true } }) : [],
  ]);
  const parts = closings.length > 0
    ? (await prisma.odooEntry.findMany({ where: { line, ledgerId: { in: closings.map((c) => c.id) }, odooMo: { not: "" }, status: { not: ODOO_CANCELLED_STATUS } }, select: { odooMo: true } })).map((o) => up(o.odooMo))
    : [];
  const keys = [...new Set([...mos, ...parts])];
  const or: Prisma.MaterialUsageWhereInput[] = [
    ...(keys.length > 0 ? [{ mo: { in: keys, mode: "insensitive" as const } }] : []),
    ...(sois.length > 0 ? [{ soi: { in: sois, mode: "insensitive" as const } }] : []),
    ...(bom ? [{ bom: { equals: bom, mode: "insensitive" as const } }] : []),
  ];
  if (or.length === 0) return { lines: [], odooByMo: {} };
  // the living table, as the tab shows it
  const data = await loadMaterial(line, { line, month: "", OR: or }, true);
  const lines = data.lines.filter(traceMaterialMatch({ scope: target.scope, mos, sois, bom, soiOrders: soiOrders.map((o) => ({ mo: o.mo, soi: o.soi ?? "", bom: o.bom })) }));
  return { lines, odooByMo: data.odooByMo };
}

type OdooRow = { odooMo: string; status: string; qty: number; date: Date; ledgerId: number | null };
const ODOO_SELECT = { odooMo: true, status: true, qty: true, date: true, ledgerId: true } as const;
const ODOO_ORDER = [{ date: "asc" as const }, { id: "asc" as const }];
const ORDER_SELECT = { mo: true, soi: true, bom: true, months: true, source: true, planQty: true } as const;
const PAINTING = { dept: "Painting", item: LV_ITEM } as const;
const ROWS_ORDER = [{ month: "desc" as const }, { sortOrder: "asc" as const }, { id: "asc" as const }];
const keysOf = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()).filter(Boolean))];

/** What loadMaterial costs its lines by: the lines, their ODOO rows, and —
 *  once the orders their parts were closed against are known — the registry
 *  rows and the panels' painted counts. */
interface MaterialSource {
  rows: Row[];
  odoo: OdooRow[];
  orders: (linked: readonly string[]) => Promise<{ mo: string; soi: string | null; bom: string; months: string; source: string | null; planQty: number }[]>;
  painted: Promise<{ mo: string | null; _sum: { qty: number | null } }[] | null>;
}

/** The tab: the whole line's log and registry, every query at once. */
async function wideSource(line: ProductLine, where: Prisma.MaterialUsageWhereInput): Promise<MaterialSource> {
  // every order of the line, closed ones too: a month's sheet stays that month's
  const orders = prisma.masterOrder.findMany({ where: { line }, select: ORDER_SELECT });
  const painted = line === "LV" ? prisma.handoverEntry.groupBy({ by: ["mo"], where: { ...PAINTING, mo: { not: null } }, _sum: { qty: true } }) : Promise.resolve(null);
  for (const p of [orders, painted]) p.catch(() => undefined); // awaited by the caller; a failure before then is the call's own
  const [rows, odoo] = await Promise.all([
    prisma.materialUsage.findMany({ where, orderBy: ROWS_ORDER }),
    prisma.odooEntry.findMany({ where: { line, odooMo: { not: "" } }, select: ODOO_SELECT, orderBy: ODOO_ORDER }),
  ]);
  return { rows, odoo, orders: () => orders, painted };
}

/** A trace's few lines: only the log and registry rows that touch them. */
async function narrowSource(line: ProductLine, where: Prisma.MaterialUsageWhereInput): Promise<MaterialSource> {
  const rows = await prisma.materialUsage.findMany({ where, orderBy: ROWS_ORDER });
  const mos = keysOf(rows.map((r) => r.mo));
  const painted = line === "LV" && mos.length > 0
    ? prisma.handoverEntry.groupBy({ by: ["mo"], where: { ...PAINTING, mo: { in: mos, mode: "insensitive" } }, _sum: { qty: true } })
    : Promise.resolve(null);
  painted.catch(() => undefined);
  // the ODOO rows of the lines' MOs: on a part's MO, or born of an order's
  // closings where the sheet files the order's MO
  const ownClosings = mos.length > 0 ? await prisma.handoverEntry.findMany({ where: { mo: { in: mos, mode: "insensitive" } }, select: { id: true } }) : [];
  const odoo = mos.length > 0
    ? await prisma.odooEntry.findMany({
        where: { line, odooMo: { not: "" }, OR: [{ odooMo: { in: mos, mode: "insensitive" } }, { ledgerId: { in: ownClosings.map((c) => c.id) } }] },
        select: ODOO_SELECT, orderBy: ODOO_ORDER,
      })
    : [];
  // the registry rows these lines can be tied to: by MO (theirs, or the
  // orders their parts were closed against), by SOI, by code
  const orders = (linked: readonly string[]) => prisma.masterOrder.findMany({
    where: {
      line,
      OR: [
        { mo: { in: keysOf([...mos, ...linked]), mode: "insensitive" } },
        { soi: { in: keysOf(rows.map((r) => r.soi)), mode: "insensitive" } },
        { bom: { in: keysOf(rows.map((r) => r.bom)), mode: "insensitive" } },
      ],
    },
    select: ORDER_SELECT,
  });
  return { rows, odoo, orders, painted };
}

/** A row born of an order's daily-log closing carries the part's own MO the
 *  clerk typed: the part MO → the order and component it was closed against
 *  (`materialClosings`), and the orders those closings name. */
async function closingsOf(odoo: readonly OdooClosingRow[]) {
  const ledgerIds = odoo.flatMap((o) => (o.ledgerId === null ? [] : [o.ledgerId]));
  const ledgerRows = ledgerIds.length > 0
    ? await prisma.handoverEntry.findMany({ where: { id: { in: ledgerIds }, mo: { not: null } }, select: { id: true, mo: true, item: true } })
    : [];
  const ledger = new Map(ledgerRows.map((h) => [h.id, { mo: up(h.mo!), item: h.item }]));
  return { closings: materialClosings(odoo, ledger), orderMos: [...new Set([...ledger.values()].map((l) => l.mo))] };
}

/** The lines `where` picks, with what the ODOO log and the registry say of
 *  them — read for the whole line (the tab) or, `narrow`, for these lines
 *  alone (a trace). */
async function loadMaterial(line: ProductLine, where: Prisma.MaterialUsageWhereInput, narrow = false): Promise<MaterialPageData> {
  const lv = line === "LV";
  const { rows, odoo, orders: ordersOf, painted: paintedRows } = await (narrow ? narrowSource : wideSource)(line, where);

  // the latest row of an MO speaks for it: its status, and — Done — the day
  // of that closing (the row's own day, not when it was ticked)
  const odooByMo: Record<string, string> = {};
  const doneByMo = new Map<string, string>();
  for (const o of odoo) {
    const mo = o.odooMo.trim().toUpperCase();
    odooByMo[mo] = o.status;
    if (isDoneStatus(o.status)) doneByMo.set(mo, o.date.toISOString().slice(0, 10));
    else doneByMo.delete(mo);
  }
  const { closings, orderMos } = await closingsOf(odoo);

  const [orders, painted] = await Promise.all([ordersOf(orderMos), paintedRows]);
  const paintedByMo = painted ? lvPaintedByMo(orders, painted) : new Map<string, number>();
  const plans = materialPlanIndex(orders.map((o) => ({ ...o, months: (o.months || o.source || "").split(",") })));
  const registry = new Set(orders.map((o) => o.mo.trim().toUpperCase()));
  const links: OdooLinks = { doneByMo, closings, isOrder: (mo) => registry.has(mo) };
  const lines = rows.map((r) => toView(r, lv, plans, links, lv && r.mo ? (paintedByMo.get(r.mo) ?? 0) : null));

  return { lines, odooByMo };
}

/** Each panel order's MO → the panels the tracker says were painted on it
 *  (never more than the order) — the produced count the LV tab costs its
 *  lines by where the sheet gives none. */
function lvPaintedByMo(orders: readonly { mo: string; planQty: number }[], painted: readonly { mo: string | null; _sum: { qty: number | null } }[]): Map<string, number> {
  const by = new Map(painted.map((p) => [p.mo!, Math.max(0, p._sum.qty ?? 0)]));
  return new Map(orders.map((o) => [o.mo, Math.min(o.planQty, by.get(o.mo) ?? 0)]));
}

// ---- import: the planner's material sheet — one living table, row by MO ----

export interface MaterialImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  unchanged?: number;
  issues?: string[];
  preview?: boolean;
  sheet?: string;
  /** Rows whose "for Job" column disagrees with their own per-unit rate —
   *  kept as written, counted so the planner can look. */
  recomputed?: number;
  /** Lines of the tab's table the file no longer carries — removed when the
   *  import was asked to, else kept. */
  missing?: number;
  removed?: number;
  /** Older lines on a part's MO taken over by the sheet's row on the order's MO. */
  moved?: number;
}

/** The tab's lines that the file no longer carries: the ids to drop when the
 *  import mirrors the file. The sheet is the tab's only source, so a line
 *  typed in by hand before typing was closed goes like any other. */
async function rowsGone(line: string, month: string, seen: Set<number>, prune: boolean, preview: boolean) {
  const gone = (await prisma.materialUsage.findMany({ where: { line, month }, select: { id: true } }))
    .map((r) => r.id).filter((id) => !seen.has(id));
  let removed = 0;
  if (prune && !preview && gone.length > 0) removed = (await prisma.materialUsage.deleteMany({ where: { id: { in: gone } } })).count;
  return { missing: gone.length, removed };
}

/** Mirroring the file removes the rows it no longer carries — but a row the
 *  parser had to skip (a #VALUE! thickness, a blank size) IS in the file: its
 *  line stays, and the person is told why nothing was removed. `skipped` is
 *  the parser's own count of those rows, never read back from message text. */
function pruneSafely(prune: boolean, skipped: number, issues: string[]): boolean {
  if (!prune) return false;
  if (skipped === 0) return true;
  issues.push(`${skipped} row(s) could not be read, so nothing was removed — fix them and upload again to mirror the file.`);
  return false;
}

/**
 * Import the material sheet into the tab's one table — no month: each row is
 * known by its MO (Odoo's, per part), BOM, part, material, thickness and
 * size, so uploading the sheet again adds the rows that are new and updates
 * the ones whose values changed — never doubles them. The sheet is the
 * tab's only source: what it says replaces what the line held (a blank note
 * aside). With `prune`, every line the file no longer carries leaves the
 * table.
 */
export async function importNestingTracker(
  buffer: ArrayBuffer, recordedBy: string | null, preview = false, prune = false
): Promise<MaterialImportResult> {
  const month = ""; // the living table
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  // the workbook carries pivots and lookup tabs beside the tracker — take the
  // tab NAMED for it, else the first one
  const sheetName = wb.SheetNames.find((n) => /nesting/i.test(n)) ?? wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) return { ok: false, error: "The file has no sheets." };

  const opts: XLSX.Sheet2JSONOpts = { header: 1, raw: true, defval: null, blankrows: true };
  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0; range.s.c = 0;
    opts.range = XLSX.utils.encode_range(range);
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, opts);
  const line = await getActiveLine(); // the sheet is the line on screen's
  if (line === "LV") return importLvConsumption(grid, month, recordedBy, preview, sheetName, prune);
  const { rows, issues, recomputed, skipped } = parseNestingTracker(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues, sheet: sheetName };

  // a line is its MO's when the sheet names one (the transformer's MO; the
  // older sheets, Odoo's MO per part), else the BOM's (mo "")
  const existing = await prisma.materialUsage.findMany({ where: { month, line } });
  const moving = await partMoMove(line, rows, existing);
  const keyOf = (e: { bom: string; mo: string; partCode: string; material: string; thicknessMm: number; sheetSize: string }) =>
    `${e.bom}|${e.mo}|${e.partCode}|${e.material}|${e.thicknessMm}|${e.sheetSize}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));

  let added = 0, updated = 0, unchanged = 0;
  const seen = new Set<number>();
  const creates: Prisma.MaterialUsageCreateManyInput[] = [];
  const updates: { id: number; data: Prisma.MaterialUsageUpdateInput }[] = [];
  const adopted = new Set<number>();
  // a sheet may list the same line twice — the later row wins, as it would
  // have row by row
  const last = new Map<string, (typeof rows)[number]>();
  for (const r of rows) last.set(keyOf(r), r);
  // the lines another row may take over, by the part and sheet they nest — a
  // line the file still carries as it is is never one
  const bySpec = <T extends Parameters<typeof nestingSpecKey>[0]>(items: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const x of items) { const k = nestingSpecKey(x); const g = m.get(k); if (g) g.push(x); else m.set(k, [x]); }
    return m;
  };
  const takeable = moving ? bySpec(existing.filter((e) => !last.has(keyOf(e)))) : new Map<string, typeof existing>();
  const rivals = moving ? bySpec([...last.values()]) : new Map<string, typeof rows>();
  for (const r of last.values()) {
    const exact = byKey.get(keyOf(r));
    // the sheet now filing the order's MO: the older line on the part's MO
    // is the same nesting — taken over, never added beside it
    const older = exact || !moving ? null
      : adoptedPartLine(r, (takeable.get(nestingSpecKey(r)) ?? []).filter((e) => !adopted.has(e.id)), rivals.get(nestingSpecKey(r)) ?? [], moving.isOrder, moving.ordersOf);
    if (older) adopted.add(older.id);
    const cur = exact ?? older;
    if (cur) seen.add(cur.id);
    // the sheet is the only source: its rate replaces one typed in the tab
    // before typing was closed
    const same = !older && cur && cur.units === r.units && cur.sheetsPerUnit === r.sheetsPerUnit
      && !cur.actualPerUnitManual && cur.actualPerUnit === r.actualPerUnit && cur.sheetsUsed === r.sheetsUsed && cur.partName === r.partName && cur.materialCode === r.materialCode
      && cur.sortOrder === r.rowNum && cur.soi === r.soi && cur.mtr === r.mtr && cur.weightKg === r.weightKg && cur.utilization === r.utilization
      && (cur.note ?? null) === (r.note ?? cur.note ?? null);
    if (!cur) added += 1; else if (same) unchanged += 1; else updated += 1;
    if (preview || same) continue;

    const data = {
      units: r.units, partName: r.partName, materialCode: r.materialCode,
      sheetsPerUnit: r.sheetsPerUnit, sheetsUsed: r.sheetsUsed,
      soi: r.soi, mtr: r.mtr, weightKg: r.weightKg, utilization: r.utilization,
      sortOrder: r.rowNum, // the sheet's row — the tab reads in this order
      actualPerUnit: r.actualPerUnit, actualPerUnitManual: false,
      // a sheet without the optional Notes column must not erase the notes
      ...(r.note !== null ? { note: r.note } : {}),
      recordedBy,
    };
    // a line taken over is the row's from here on: its key the row's own
    if (cur) updates.push({ id: cur.id, data: older ? { ...data, mo: r.mo, bom: r.bom, partCode: r.partCode } : data });
    else creates.push({ month, bom: r.bom, mo: r.mo, partCode: r.partCode, material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, ...data, note: r.note, line });
  }
  // in bulk — a sheet of hundreds of rows written one by one outlasted the
  // request and stopped part-way
  if (creates.length) await prisma.materialUsage.createMany({ data: creates, skipDuplicates: true });
  for (let i = 0; i < updates.length; i += 100) {
    await prisma.$transaction(updates.slice(i, i + 100).map((u) => prisma.materialUsage.update({ where: { id: u.id }, data: u.data })));
  }
  const pruning = pruneSafely(prune, skipped, issues);
  if (moving) {
    if (adopted.size > 0) issues.push(`${adopted.size} line(s) filed under a part's MO now sit under their transformer's MO — the same nesting, not added twice.`);
    // part-MO lines of an order the sheet now files, left beside the one taken over
    const filed = new Set([...last.values()].map((r) => `${up(r.mo)}|${nestingSpecKey(r)}`));
    const leftOnParts = existing.filter((e) => !seen.has(e.id) && up(e.mo) && !moving.isOrder(e.mo)
      && moving.ordersOf(e.mo).some((o) => filed.has(`${o}|${nestingSpecKey(e)}`))).length;
    if (leftOnParts > 0 && !pruning) issues.push(`${leftOnParts} older line(s) on a part's MO belong to an order the sheet now files under its own MO — "Upload and remove the rows no longer in the file" drops them.`);
    const partRows = [...last.values()].filter((r) => up(r.mo) && !moving.isOrder(r.mo)).length;
    if (partRows > 0) issues.push(`${partRows} row(s) name an MO no order of the Plan Tracker has (a part's MO?) — the sheet files the transformer's own MO (PF01/MO/…); the part's MO is read off the ODOO log.`);
  }
  const { missing, removed } = await rowsGone(line, month, seen, pruning, preview);
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed, missing, removed, moved: adopted.size };
}

/** What moving the sheet from the part's MO to the order's needs to know: the
 *  MOs that are orders (the Plan Tracker's, and those the ODOO log closed
 *  parts against), and the orders each part MO was closed against there.
 *  Null when no row of the sheet names an MO — nothing can move. */
async function partMoMove(line: ProductLine, rows: readonly { mo: string }[], existing: readonly { mo: string }[]) {
  const rowMos = keysOf(rows.map((r) => r.mo));
  if (rowMos.length === 0) return null;
  const mos = keysOf([...rowMos, ...existing.map((e) => e.mo)]);
  const [orders, odoo] = await Promise.all([
    prisma.masterOrder.findMany({ where: { line, mo: { in: mos, mode: "insensitive" } }, select: { mo: true } }),
    prisma.odooEntry.findMany({ where: { line, odooMo: { in: mos, mode: "insensitive" }, ledgerId: { not: null } }, select: { odooMo: true, status: true, qty: true, ledgerId: true } }),
  ]);
  const { closings, orderMos } = await closingsOf(odoo);
  const registry = new Set([...orders.map((o) => up(o.mo)), ...orderMos]);
  return {
    isOrder: (mo: string) => registry.has(up(mo)),
    ordersOf: (partMo: string) => [...(closings.ordersByPart.get(up(partMo)) ?? [])],
  };
}

/**
 * The panels' "Consumption Details" sheet: one line per order × thickness,
 * keyed on month × BOM × MO × material × thickness × size. The planned qty,
 * the sheets per unit and what was consumed so far come off the sheet; a
 * running block's "For 8 Units 14.4 Sheets Consumed" lands as produced 8
 * with the rate 14.4 ÷ 8, a Done block as the whole job nested. A bare
 * number with neither says nothing a line can hold — the job is not nested
 * yet and no unit count came with it — so the import says so for that row.
 */
async function importLvConsumption(grid: unknown[][], month: string, recordedBy: string | null, preview: boolean, sheetName: string, prune: boolean): Promise<MaterialImportResult> {
  const { rows, issues, skipped } = parseLvConsumption(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues, sheet: sheetName };
  const existing = await prisma.materialUsage.findMany({ where: { month, line: "LV" } });
  const keyOf = (r: { bom: string; mo: string; material: string; thicknessMm: number; sheetSize: string }) => `${r.bom}|${r.mo}|${r.material}|${r.thicknessMm}|${r.sheetSize}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const known = new Set((await prisma.masterOrder.findMany({ where: { line: "LV" }, select: { mo: true } })).map((o) => o.mo));

  let added = 0, updated = 0, unchanged = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    if (!known.has(r.mo)) issues.push(`Row ${r.rowNum}: ${r.mo} is not in the LV orders registry — the line is kept, but the tracker cannot count its panels.`);
    const cur = byKey.get(keyOf(r));
    if (cur) seen.add(cur.id);
    // a bare number in the consumed cell on a block that is neither Done nor
    // "For N units": not the job's nesting (it is still running) and no rate
    // (no unit count) — said out loud rather than dropped in silence
    if (r.consumed !== null && !r.done && r.producedQty === null) {
      issues.push(`Row ${r.rowNum}: ${r.mo} shows ${r.consumed} sheets consumed but neither "Done" nor "For N units" — not counted yet; write "For N units" on the sheet, or "Done" once the job is nested.`);
    }
    // the job's nesting is what a DONE block consumed; a running one is not it
    const used = r.done ? r.consumed : null;
    // a running block: the rate is what was consumed over what was produced.
    // The sheet is the only source — its rate and produced count replace any
    // typed in the tab before typing was closed; a produced count the sheet
    // leaves out falls back to the panels painted on the tracker
    const rate = lvActualRate(r);
    const data = {
      units: r.units, partName: r.product, materialCode: r.secItem,
      sheetsPerUnit: r.sheetsPerUnit,
      sheetsUsed: used,
      actualPerUnit: rate, actualPerUnitManual: false,
      producedQty: r.producedQty,
      sortOrder: r.rowNum,
      // a blank remark must not erase the notes
      ...(r.note !== null ? { note: r.note } : {}),
      recordedBy,
    };
    const same = cur && cur.units === data.units && cur.sheetsPerUnit === data.sheetsPerUnit && cur.sheetsUsed === used
      && !cur.actualPerUnitManual && cur.actualPerUnit === rate && cur.producedQty === r.producedQty && cur.partName === data.partName && cur.materialCode === data.materialCode
      && cur.sortOrder === data.sortOrder && (cur.note ?? null) === (r.note ?? cur.note ?? null);
    if (!cur) added += 1; else if (same) unchanged += 1; else updated += 1;
    if (preview || same) continue;
    const key = { month, bom: r.bom, mo: r.mo, partCode: "", material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize };
    await prisma.materialUsage.upsert({
      where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: key },
      create: { ...key, ...data, note: r.note, line: "LV" },
      update: data,
    });
  }
  const { missing, removed } = await rowsGone("LV", month, seen, pruneSafely(prune, skipped, issues), preview);
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed: 0, missing, removed };
}
