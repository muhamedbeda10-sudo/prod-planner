import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { getActiveLine } from "./line";
import { factoryDayISO, parseISODate, toISODate } from "@/lib/domain/dates";
import { blockedItem, isDoneStatus, odooRowBom, odooRowBomLabel, parseOdooSheet, statusTone, type OdooEntryView, type OdooScope } from "@/lib/domain/odoo";
import { buildOdooDashboard, previousPeriod, type OdooBasis, type OdooDashboardData, type OdooPeriod } from "@/lib/domain/odooStats";
import { buildOdooInsights, type OdooInsightRow, type OdooInsights } from "@/lib/domain/odooInsights";
import { candidateBoms, candidateMos, moKey, nestingKey, type NeedContext, type NestingLookup } from "@/lib/domain/odooMaterial";

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
  /** Panels: the registry's order MO(s) per SOI — the material is filed by
   *  MO, and the lookup carries those lines under "MO|<mo>". */
  soiMos: Record<string, string[]>;
  /** Kept for the page's shape: the tab shows both lines, and each row's own
   *  line says how its material is looked up (a panel by MO). */
  lv: boolean;
  /** The WHOLE log, not just the day on screen: how many rows it holds and how
   *  many are still not closed. The tab opens on one day, so without this a
   *  row logged last week reads as lost — it says what is off-screen. */
  totalRows: number;
  openRows: number;
}

/** The tab for one day, a from..to range (both days included), or every day. */
export async function getOdooData(scope: OdooScope): Promise<OdooPageData> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const from = scope.kind === "day" ? parseISODate(scope.iso) : scope.kind === "range" ? parseISODate(scope.from) : null;
  const to = scope.kind === "day" ? parseISODate(scope.iso) : scope.kind === "range" ? parseISODate(scope.to) : null;
  const where = from && to ? { date: { gte: from, lt: new Date(to.getTime() + DAY_MS) } } : undefined;

  // both product lines together — each row carries its own
  const [rows, dayRows, orders, totalRows, byStatus] = await Promise.all([
    prisma.odooEntry.findMany({
      where,
      orderBy: [{ date: "desc" }, { id: "asc" }],
      include: { notes: { orderBy: { id: "desc" } } },
    }),
    prisma.odooEntry.findMany({ select: { date: true }, distinct: ["date"], orderBy: { date: "desc" } }),
    prisma.masterOrder.findMany({ select: { soi: true, fgCode: true, bom: true, mo: true, line: true } }),
    prisma.odooEntry.count(),
    // grouped and judged in JS, so "off-screen, still open" counts a status
    // exactly the way the rows on screen are coloured
    prisma.odooEntry.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const soiBoms: Record<string, string[]> = {};
  const soiMos: Record<string, string[]> = {};
  for (const o of orders) {
    const soi = (o.soi ?? "").trim().toUpperCase();
    const bom = o.bom.trim().toUpperCase();
    const mo = o.mo.trim().toUpperCase();
    if (!soi) continue;
    if (bom) { const list = (soiBoms[soi] ??= []); if (!list.includes(bom)) list.push(bom); }
    if (mo && o.line === "LV") { const list = (soiMos[soi] ??= []); if (!list.includes(mo)) list.push(mo); }
  }

  // the closing a row was born from names the planner's MO — the key a
  // panel row's material sits under
  const ledgerIds = rows.map((r) => r.ledgerId).filter((id): id is number => id !== null);
  const ledgers = ledgerIds.length
    ? await prisma.handoverEntry.findMany({ where: { id: { in: ledgerIds } }, select: { id: true, mo: true, bom: true } })
    : [];
  const moOfLedger = new Map(ledgers.map((l) => [l.id, (l.mo ?? "").trim().toUpperCase() || null]));
  const bomOfLedger = new Map(ledgers.map((l) => [l.id, l.bom]));

  const entries: OdooEntryView[] = rows.map((r) => ({
    mo: r.ledgerId !== null ? (moOfLedger.get(r.ledgerId) ?? null) : null,
    line: r.line,
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
    bom: odooRowBom(r.fgCode, r.ledgerId !== null ? bomOfLedger.get(r.ledgerId) : null, soiBoms[(r.soi ?? "").trim().toUpperCase()] ?? []),
    notes: r.notes.map((n) => ({ id: n.id, text: n.text, atISO: n.at.toISOString(), by: n.recordedBy, blockedItem: blockedItem(n.text) })),
  }));

  const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].sort();
  return {
    entries,
    days: [...new Set(dayRows.map((d) => toISODate(d.date)))],
    knownSois: uniq(orders.map((o) => o.soi)),
    knownFgCodes: uniq(orders.map((o) => o.fgCode)),
    // each line's rows read their own material; the keys never collide (an
    // MO belongs to one line)
    nesting: Object.assign(
      {},
      await nestingOf(entries.filter((e) => e.line !== "LV"), "TR", soiBoms, soiMos),
      await nestingOf(entries.filter((e) => e.line === "LV"), "LV", soiBoms, soiMos),
    ),
    soiBoms,
    soiMos,
    lv: false,
    totalRows,
    openRows: byStatus.reduce((n, g) => n + (isDoneStatus(g.status) ? 0 : g._count._all), 0),
  };
}

/** The material lines the rows may read: panels by their orders' MOs; a
 *  transformer row by its own Odoo MO (the newer sheet files each part under
 *  it) and by its part × BOM (the older sheet, and the rows with no MO yet). */
async function nestingOf(
  entries: { fgCode: string; soi: string | null; odooMo: string; mo?: string | null }[],
  line: string, soiBoms: Record<string, string[]>, soiMos: Record<string, string[]>,
): Promise<NestingLookup> {
  const soi = (e: { soi: string | null }) => (e.soi ?? "").trim().toUpperCase();
  if (line === "LV") return linesByMo(entries.map((e) => candidateMos(e, soiMos[soi(e)] ?? []).map((c) => c.mo)), "LV");
  const [byPart, byMo] = await Promise.all([
    nestingFor(entries.map((e) => ({ fgCode: e.fgCode, boms: soiBoms[soi(e)] ?? [] })), line),
    linesByMo(entries.map((e) => [e.odooMo.trim().toUpperCase()].filter(Boolean)), "TR"),
  ]);
  return { ...byPart, ...byMo };
}

/** Everything the material popup needs for ONE row — the ODOO alert's popup
 *  opens it from any page, so it cannot lean on the log page's lookup. */
export async function getOdooRowMaterial(id: number): Promise<{ entry: OdooEntryView; nesting: NestingLookup; needCtx: NeedContext } | null> {
  const r = await prisma.odooEntry.findUnique({ where: { id }, include: { notes: { orderBy: { id: "desc" } } } });
  if (!r) return null;
  const soi = (r.soi ?? "").trim().toUpperCase();
  const [ledger, orders] = await Promise.all([
    r.ledgerId !== null ? prisma.handoverEntry.findUnique({ where: { id: r.ledgerId }, select: { mo: true, bom: true } }) : Promise.resolve(null),
    soi ? prisma.masterOrder.findMany({ where: { line: r.line, soi: { equals: soi, mode: "insensitive" } }, select: { bom: true, mo: true } }) : Promise.resolve([]),
  ]);
  const soiBoms: Record<string, string[]> = soi ? { [soi]: [...new Set(orders.map((o) => o.bom.trim().toUpperCase()).filter(Boolean))] } : {};
  const soiMos: Record<string, string[]> = soi && r.line === "LV" ? { [soi]: [...new Set(orders.map((o) => o.mo.trim().toUpperCase()).filter(Boolean))] } : {};
  const entry: OdooEntryView = {
    mo: (ledger?.mo ?? "").trim().toUpperCase() || null,
    line: r.line,
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
    bom: odooRowBom(r.fgCode, ledger?.bom, soiBoms[soi] ?? []),
    notes: r.notes.map((n) => ({ id: n.id, text: n.text, atISO: n.at.toISOString(), by: n.recordedBy, blockedItem: blockedItem(n.text) })),
  };
  return { entry, nesting: await nestingOf([entry], r.line, soiBoms, soiMos), needCtx: { lv: r.line === "LV", soiBoms, soiMos } };
}

/** The tracker's lines for every part × BOM these rows may sit under
 *  (the SOI's BOM and the FG-CODE's), every month. */
async function nestingFor(entries: { fgCode: string; boms: string[] }[], line: string): Promise<NestingLookup> {
  const keys = new Map<string, { partCode: string; bom: string }>();
  for (const r of entries) {
    const cand = candidateBoms(r.fgCode, r.boms);
    if (!cand) continue;
    for (const c of cand.boms) keys.set(nestingKey(cand.partCode, c.bom), { partCode: cand.partCode, bom: c.bom });
  }
  if (keys.size === 0) return {};
  const rows = await prisma.materialUsage.findMany({
    where: { line, bom: { in: [...new Set([...keys.values()].map((k) => k.bom))] } },
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

/** The Material tab's lines of every MO these rows may be filed under, keyed
 *  "MO|<mo>" — every month, the newest first. Panels: the orders' MOs;
 *  transformers: Odoo's MO per part, from the newer material sheet. */
async function linesByMo(mosPerRow: string[][], line: string): Promise<NestingLookup> {
  const mos = [...new Set(mosPerRow.flat())];
  if (mos.length === 0) return {};
  const rows = await prisma.materialUsage.findMany({
    where: { line, mo: { in: mos, mode: "insensitive" } },
    select: {
      id: true, month: true, bom: true, mo: true, partCode: true, partName: true, materialCode: true, material: true,
      thicknessMm: true, sheetSize: true, units: true, sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true, note: true,
    },
    orderBy: [{ month: "desc" }, { thicknessMm: "asc" }, { material: "asc" }],
  });
  const out: NestingLookup = {};
  for (const { mo, ...r } of rows) (out[moKey(mo)] ??= []).push(r);
  return out;
}

// ---- dashboard: what was logged, by day and product ----

/** Rows logged in the window OR closed in it — a row logged before the period
 *  and closed inside it counts among the period's closings. The doneAt window
 *  is a day wider each side; the aggregation filters by the factory's day. */
async function statRows(fromISO: string | null, toISO: string): Promise<OdooInsightRow[]> {
  const DAY = 24 * 60 * 60 * 1000;
  const from = fromISO ? parseISODate(fromISO) : null;
  const to = parseISODate(toISO)!;
  const rows = await prisma.odooEntry.findMany({
    where: {
      // both product lines together, like the log
      OR: [
        { date: { ...(from ? { gte: from } : {}), lt: new Date(to.getTime() + DAY) } },
        { doneAt: { ...(from ? { gte: new Date(from.getTime() - DAY) } : {}), lt: new Date(to.getTime() + 2 * DAY) } },
      ],
    },
    select: { date: true, product: true, qty: true, status: true, doneAt: true, fgCode: true, odooMo: true, soi: true, ledgerId: true },
  });
  // the BOM the way the log reads it: the closing's, else the SOI's order,
  // else the FG code's suffix (a top cover's suffix is its drawing code)
  const sois = [...new Set(rows.map((r) => (r.soi ?? "").trim()).filter(Boolean))];
  const ledgerIds = rows.map((r) => r.ledgerId).filter((id): id is number => id !== null);
  const [orders, ledgers] = await Promise.all([
    sois.length ? prisma.masterOrder.findMany({ where: { soi: { in: sois, mode: "insensitive" } }, select: { soi: true, bom: true } }) : Promise.resolve([]),
    ledgerIds.length ? prisma.handoverEntry.findMany({ where: { id: { in: ledgerIds } }, select: { id: true, bom: true } }) : Promise.resolve([]),
  ]);
  const soiBoms: Record<string, string[]> = {};
  for (const o of orders) {
    const soi = (o.soi ?? "").trim().toUpperCase();
    if (soi) (soiBoms[soi] ??= []).push(o.bom);
  }
  const bomOfLedger = new Map(ledgers.map((l) => [l.id, l.bom]));
  return rows.map((r) => ({
    dateISO: toISODate(r.date), product: r.product, qty: r.qty, status: r.status,
    doneISO: r.doneAt ? factoryDayISO(r.doneAt) : null,
    bom: odooRowBomLabel(odooRowBom(r.fgCode, r.ledgerId !== null ? bomOfLedger.get(r.ledgerId) : null, soiBoms[(r.soi ?? "").trim().toUpperCase()] ?? [])),
    hasMo: r.odooMo.trim() !== "",
  }));
}

/** The dashboard's numbers for one period, compared with the period before it. */
/** The dashboard as drawn: the per-product numbers and the close-out insights. */
export type OdooDashboardView = OdooDashboardData & { insights: OdooInsights };

export async function getOdooDashboard(period: OdooPeriod, basis: OdooBasis = "closed", bom: string | null = null): Promise<OdooDashboardView> {
  const prev = previousPeriod(period);
  const [rows, prevRows] = await Promise.all([
    statRows(period.fromISO, period.toISO),
    prev ? statRows(prev.fromISO, prev.toISO) : Promise.resolve(null),
  ]);
  return { ...buildOdooDashboard(rows, period, prevRows, basis, bom), insights: buildOdooInsights(rows, period, bom) };
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
  buffer: ArrayBuffer, fallbackDayISO: string | null, recordedBy: string | null, preview = false, sheetLine: string | null = null
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
  // the sheet is one line's — picked with it — its rows match and join that line only
  const line = sheetLine ?? await getActiveLine();
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
