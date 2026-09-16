import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { getActiveLine } from "./line";
import { factoryDayISO, parseISODate, toISODate } from "@/lib/domain/dates";
import { blockedItem, bomOfFgCode, isDoneStatus, parseOdooSheet, statusTone, type OdooEntryView } from "@/lib/domain/odoo";
import { buildOdooDashboard, previousPeriod, type OdooBasis, type OdooDashboardData, type OdooPeriod, type OdooStatRow } from "@/lib/domain/odooStats";
import { candidateBoms, nestingKey, type NestingLookup } from "@/lib/domain/odooMaterial";

export interface OdooPageData {
  entries: OdooEntryView[];
  /** Every day that has at least one row — the day picker's quick jumps. */
  days: string[];
  /** Typing aids from the orders registry: SOIs and FG codes it already knows. */
  knownSois: string[];
  knownFgCodes: string[];
  /** The MATERIAL tab's nesting lines for every part × BOM the rows may sit
   *  under, keyed "FB-022|14003E11M11" — what a row's popup scales to its qty. */
  nesting: NestingLookup;
  /** The registry's BOM(s) per SOI — the transformer a row's SOI is for. */
  soiBoms: Record<string, string[]>;
  /** The WHOLE log, not just the day on screen: how many rows it holds and how
   *  many are still not closed. The tab opens on one day, so without this a
   *  row logged last week reads as lost — it says what is off-screen. */
  totalRows: number;
  openRows: number;
}

/** The tab for one day (ISO), or every day when `dayISO` is "all". */
export async function getOdooData(dayISO: string): Promise<OdooPageData> {
  const day = dayISO === "all" ? null : parseISODate(dayISO);
  const where = day
    ? { date: { gte: day, lt: new Date(day.getTime() + 24 * 60 * 60 * 1000) } }
    : undefined;

  // one product line at a time — the toggle in the nav decides which
  const line = await getActiveLine();
  const [rows, dayRows, orders, totalRows, byStatus] = await Promise.all([
    prisma.odooEntry.findMany({
      where: { ...where, line },
      orderBy: [{ date: "desc" }, { id: "asc" }],
      include: { notes: { orderBy: { id: "desc" } } },
    }),
    prisma.odooEntry.findMany({ where: { line }, select: { date: true }, distinct: ["date"], orderBy: { date: "desc" } }),
    prisma.masterOrder.findMany({ where: { line }, select: { soi: true, fgCode: true, bom: true } }),
    prisma.odooEntry.count({ where: { line } }),
    // grouped and judged in JS, so "off-screen, still open" counts a status
    // exactly the way the rows on screen are coloured
    prisma.odooEntry.groupBy({ by: ["status"], where: { line }, _count: { _all: true } }),
  ]);

  const soiBoms: Record<string, string[]> = {};
  for (const o of orders) {
    const soi = (o.soi ?? "").trim().toUpperCase();
    const bom = o.bom.trim().toUpperCase();
    if (!soi || !bom) continue;
    const list = (soiBoms[soi] ??= []);
    if (!list.includes(bom)) list.push(bom);
  }

  const entries: OdooEntryView[] = rows.map((r) => ({
    id: r.id,
    dateISO: toISODate(r.date),
    soi: r.soi,
    fgCode: r.fgCode,
    product: r.product,
    odooMo: r.odooMo,
    qty: r.qty,
    status: r.status,
    tone: statusTone(r.status),
    done: isDoneStatus(r.status),
    doneAtISO: r.doneAt ? r.doneAt.toISOString() : null,
    recordedBy: r.recordedBy,
    source: r.source,
    fgGuessed: r.fgGuessed,
    notes: r.notes.map((n) => ({ id: n.id, text: n.text, atISO: n.at.toISOString(), by: n.recordedBy, blockedItem: blockedItem(n.text) })),
  }));

  const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].sort();
  return {
    entries,
    days: [...new Set(dayRows.map((d) => toISODate(d.date)))],
    knownSois: uniq(orders.map((o) => o.soi)),
    knownFgCodes: uniq(orders.map((o) => o.fgCode)),
    nesting: await nestingFor(entries.map((e) => ({ fgCode: e.fgCode, boms: soiBoms[(e.soi ?? "").trim().toUpperCase()] ?? [] }))),
    soiBoms,
    totalRows,
    openRows: byStatus.reduce((n, g) => n + (isDoneStatus(g.status) ? 0 : g._count._all), 0),
  };
}

/** The tracker's lines for every part × BOM these rows may sit under
 *  (the SOI's BOM and the FG-CODE's), every month. */
async function nestingFor(entries: { fgCode: string; boms: string[] }[]): Promise<NestingLookup> {
  const keys = new Map<string, { partCode: string; bom: string }>();
  for (const r of entries) {
    const cand = candidateBoms(r.fgCode, r.boms);
    if (!cand) continue;
    for (const c of cand.boms) keys.set(nestingKey(cand.partCode, c.bom), { partCode: cand.partCode, bom: c.bom });
  }
  if (keys.size === 0) return {};
  const rows = await prisma.materialUsage.findMany({
    where: { line: await getActiveLine(), bom: { in: [...new Set([...keys.values()].map((k) => k.bom))] } },
    select: {
      id: true, month: true, bom: true, partCode: true, partName: true, materialCode: true, material: true,
      thicknessMm: true, sheetSize: true, units: true, sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true, note: true,
    },
    orderBy: [{ month: "desc" }, { material: "asc" }, { thicknessMm: "asc" }],
  });
  const out: NestingLookup = {};
  for (const r of rows) {
    const key = nestingKey(r.partCode.toUpperCase(), r.bom.toUpperCase());
    if (!keys.has(key)) continue;
    (out[key] ??= []).push(r);
  }
  return out;
}

// ---- dashboard: what was logged, by day and product ----

/** Rows logged in the window OR closed in it — a row logged before the period
 *  and closed inside it counts among the period's closings. The doneAt window
 *  is a day wider each side; the aggregation filters by the factory's day. */
async function statRows(fromISO: string | null, toISO: string): Promise<OdooStatRow[]> {
  const DAY = 24 * 60 * 60 * 1000;
  const from = fromISO ? parseISODate(fromISO) : null;
  const to = parseISODate(toISO)!;
  const rows = await prisma.odooEntry.findMany({
    where: {
      line: await getActiveLine(),
      OR: [
        { date: { ...(from ? { gte: from } : {}), lt: new Date(to.getTime() + DAY) } },
        { doneAt: { ...(from ? { gte: new Date(from.getTime() - DAY) } : {}), lt: new Date(to.getTime() + 2 * DAY) } },
      ],
    },
    select: { date: true, product: true, qty: true, status: true, doneAt: true, fgCode: true },
  });
  return rows.map((r) => ({
    dateISO: toISODate(r.date), product: r.product, qty: r.qty, status: r.status,
    doneISO: r.doneAt ? factoryDayISO(r.doneAt) : null,
    // the BOM is read off the FG code rather than stored again — see bomOfFgCode
    bom: bomOfFgCode(r.fgCode),
  }));
}

/** The dashboard's numbers for one period, compared with the period before it. */
export async function getOdooDashboard(period: OdooPeriod, basis: OdooBasis = "closed", bom: string | null = null): Promise<OdooDashboardData> {
  const prev = previousPeriod(period);
  const [rows, prevRows] = await Promise.all([
    statRows(period.fromISO, period.toISO),
    prev ? statRows(prev.fromISO, prev.toISO) : Promise.resolve(null),
  ]);
  return buildOdooDashboard(rows, period, prevRows, basis, bom);
}

// ---- import: the office's sheet, once, its first seven columns ----

export interface OdooImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  unchanged?: number;
  issues?: string[];
  preview?: boolean;
  sheet?: string;
}

/**
 * Import the close-out sheet. A row is the same attempt as an existing one
 * when it is the same Odoo MO on the same day: those are updated in place
 * (SOI, FG code, product, qty) instead of doubled, so the same file twice
 * adds nothing. Status is taken from the sheet only for NEW rows — on a row
 * already in the tab it is the planner's column, moved by hand, and the
 * clerk's re-import must not put it back. Notes are never read from the
 * sheet. Rows whose Date cell is blank are filed under `fallbackDayISO`.
 */
export async function importOdooSheet(
  buffer: ArrayBuffer, fallbackDayISO: string | null, recordedBy: string | null, preview = false
): Promise<OdooImportResult> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  const sheetName = wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) return { ok: false, error: "The file has no sheets." };

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const { rows, issues } = parseOdooSheet(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No rows found.", issues, sheet: sheetName };

  const fallback = fallbackDayISO ? parseISODate(fallbackDayISO) : null;
  const dated: { date: Date; row: (typeof rows)[number] }[] = [];
  for (const r of rows) {
    const date = r.date ?? fallback;
    if (!date) { issues.push(`Row ${r.rowNum} (${r.odooMo}): no date — pick a day in the tab to file it under, or fill the Date cell.`); continue; }
    dated.push({ date, row: r });
  }
  if (dated.length === 0) return { ok: false, error: issues[0] ?? "No dated rows found.", issues, sheet: sheetName };

  const days = [...new Set(dated.map((d) => d.date.getTime()))].map((t) => new Date(t));
  // the sheet is the line on screen's — its rows match and join that line only
  const line = await getActiveLine();
  const existing = await prisma.odooEntry.findMany({
    where: { date: { in: days }, line },
    orderBy: { id: "asc" },
  });
  const key = (dateISO: string, mo: string) => `${dateISO}|${mo}`;
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    // a row born from a painting record has no MO yet — the sheet's rows
    // never describe it, so it is never the one a sheet row updates
    if (!e.odooMo) continue;
    const k = key(toISODate(e.date), e.odooMo);
    if (!byKey.has(k)) byKey.set(k, e); // the first attempt of the day is the one the sheet describes
  }

  let added = 0, updated = 0, unchanged = 0;
  for (const { date, row } of dated) {
    const k = key(toISODate(date), row.odooMo);
    const cur = byKey.get(k);
    const same = cur && (cur.soi ?? null) === row.soi && cur.fgCode === row.fgCode && cur.product === row.product
      && cur.qty === row.qty;
    if (!cur) added += 1; else if (same) unchanged += 1; else updated += 1;
    if (preview || same) continue;

    const data = { soi: row.soi, fgCode: row.fgCode, product: row.product, qty: row.qty, recordedBy };
    if (cur) {
      await prisma.odooEntry.update({ where: { id: cur.id }, data });
    } else {
      // a row the sheet already marks Done was closed on its own day — the
      // only day known for it
      const created = await prisma.odooEntry.create({
        data: { line, date, odooMo: row.odooMo, status: row.status, doneAt: isDoneStatus(row.status) ? date : null, source: "import", ...data },
      });
      byKey.set(k, created); // a second line for the same MO in the file updates, not doubles
    }
  }
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName };
}
