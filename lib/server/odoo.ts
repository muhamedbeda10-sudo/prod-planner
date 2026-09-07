import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { blockedItem, isDoneStatus, parseOdooSheet, statusTone, type OdooEntryView } from "@/lib/domain/odoo";
import { buildOdooDashboard, previousPeriod, type OdooDashboardData, type OdooPeriod, type OdooStatRow } from "@/lib/domain/odooStats";

export interface OdooPageData {
  entries: OdooEntryView[];
  /** Every day that has at least one row — the day picker's quick jumps. */
  days: string[];
  /** Typing aids from the orders registry: SOIs and FG codes it already knows. */
  knownSois: string[];
  knownFgCodes: string[];
}

/** The tab for one day (ISO), or every day when `dayISO` is "all". */
export async function getOdooData(dayISO: string): Promise<OdooPageData> {
  const day = dayISO === "all" ? null : parseISODate(dayISO);
  const where = day
    ? { date: { gte: day, lt: new Date(day.getTime() + 24 * 60 * 60 * 1000) } }
    : undefined;

  const [rows, dayRows, orders] = await Promise.all([
    prisma.odooEntry.findMany({
      where,
      orderBy: [{ date: "desc" }, { id: "asc" }],
      include: { notes: { orderBy: { id: "desc" } } },
    }),
    prisma.odooEntry.findMany({ select: { date: true }, distinct: ["date"], orderBy: { date: "desc" } }),
    prisma.masterOrder.findMany({ select: { soi: true, fgCode: true } }),
  ]);

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
    recordedBy: r.recordedBy,
    notes: r.notes.map((n) => ({ id: n.id, text: n.text, atISO: n.at.toISOString(), by: n.recordedBy, blockedItem: blockedItem(n.text) })),
  }));

  const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].sort();
  return {
    entries,
    days: [...new Set(dayRows.map((d) => toISODate(d.date)))],
    knownSois: uniq(orders.map((o) => o.soi)),
    knownFgCodes: uniq(orders.map((o) => o.fgCode)),
  };
}

// ---- dashboard: what was logged, by day and product ----

async function statRows(fromISO: string | null, toISO: string): Promise<OdooStatRow[]> {
  const from = fromISO ? parseISODate(fromISO) : null;
  const to = parseISODate(toISO)!;
  const rows = await prisma.odooEntry.findMany({
    where: { date: { ...(from ? { gte: from } : {}), lt: new Date(to.getTime() + 24 * 60 * 60 * 1000) } },
    select: { date: true, product: true, qty: true, status: true },
  });
  return rows.map((r) => ({ dateISO: toISODate(r.date), product: r.product, qty: r.qty, status: r.status }));
}

/** The dashboard's numbers for one period, compared with the period before it. */
export async function getOdooDashboard(period: OdooPeriod): Promise<OdooDashboardData> {
  const prev = previousPeriod(period);
  const [rows, prevRows] = await Promise.all([
    statRows(period.fromISO, period.toISO),
    prev ? statRows(prev.fromISO, prev.toISO) : Promise.resolve(null),
  ]);
  return buildOdooDashboard(rows, period, prevRows);
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
  const existing = await prisma.odooEntry.findMany({
    where: { date: { in: days } },
    orderBy: { id: "asc" },
  });
  const key = (dateISO: string, mo: string) => `${dateISO}|${mo}`;
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
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
      const created = await prisma.odooEntry.create({ data: { date, odooMo: row.odooMo, status: row.status, ...data } });
      byKey.set(k, created); // a second line for the same MO in the file updates, not doubles
    }
  }
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName };
}
