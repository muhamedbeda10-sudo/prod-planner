import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseHandoverGrid, validateHandoverRow } from "@/lib/domain/importHandover";
import { buildBomClassifier } from "@/lib/domain/normalizeBoms";
import { dayNumber } from "@/lib/domain/dates";
import { getKnownBoms } from "./handover";

export interface HandoverImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  skippedExisting?: number;
  invalid?: number;
  corrected?: number;
  unknownBoms?: string[]; // codes imported as-is that nothing in the registry matches
  issues?: string[]; // first N validation problems
  preview?: boolean; // true = nothing was written, this is a dry-run report
}

interface Insert {
  date: Date;
  dept: string;
  bom: string;
  bomRaw: string | null;
  mo: string | null;
  item: string;
  qty: number;
  planNo: number;
}

const sig = (r: { date: Date; dept: string; bom: string; mo?: string | null; item: string; qty: number; planNo: number }) =>
  `${dayNumber(r.date)}|${r.dept}|${r.bom}|${(r.mo ?? "").trim()}|${r.item}|${r.qty}|${r.planNo}`;

export async function importHandoverFile(buffer: ArrayBuffer, preview = false): Promise<HandoverImportResult> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { ok: false, error: "The file has no sheets." };
  // blank rows stay in the grid so "row N" in a message is the sheet's row N;
  // the parser skips them itself
  const opts: XLSX.Sheet2JSONOpts = { header: 1, raw: true, defval: null, blankrows: true };
  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0;
    range.s.c = 0;
    opts.range = XLSX.utils.encode_range(range);
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, opts);
  const { rows } = parseHandoverGrid(grid);
  if (rows.length === 0) return { ok: false, error: "No data rows (data starts on row 2)." };

  const [known, plans] = await Promise.all([
    getKnownBoms(),
    prisma.plan.findMany({ select: { planNo: true } }),
  ]);
  const classify = buildBomClassifier(known);
  const validPlans = new Set(plans.map((p) => p.planNo));

  const issues: string[] = [];
  let invalid = 0;
  let corrected = 0;
  const unknownBoms = new Set<string>();

  // desired multiset: signature -> { count, representative Insert }
  const desired = new Map<string, { count: number; rec: Insert }>();
  for (const row of rows) {
    const err = validateHandoverRow(row);
    if (err) {
      invalid++;
      if (issues.length < 25) issues.push(err);
      continue;
    }
    if (!validPlans.has(row.planNo!)) {
      invalid++;
      if (issues.length < 25) issues.push(`Plan ${row.planNo} is not imported (row ${row.rowNum})`);
      continue;
    }
    // resolve BOM
    const c = classify(row.bom);
    let bom = c.clean;
    let bomRaw: string | null = null;
    if (c.status === "corrected") {
      bom = c.corrected!;
      bomRaw = c.clean;
      corrected++;
    } else if (c.status === "unknown" || c.status === "ambiguous") {
      unknownBoms.add(c.clean);
    }
    const rec: Insert = { date: row.date!, dept: row.dept, bom, bomRaw, mo: row.mo, item: row.item, qty: row.qty, planNo: row.planNo! };
    const key = sig(rec);
    const cur = desired.get(key);
    if (cur) cur.count++;
    else desired.set(key, { count: 1, rec });
  }

  if (desired.size === 0) {
    return { ok: false, error: "No valid rows to import.", invalid, issues };
  }

  // existing multiset across ALL sources (so manual/seed rows aren't
  // duplicated) — of the plans the file names: the signature carries the plan,
  // so rows of other plans can never match, and the ledger grows for ever
  const existing = await prisma.handoverEntry.findMany({
    where: { planNo: { in: [...new Set([...desired.values()].map((d) => d.rec.planNo))] } },
    select: { date: true, dept: true, bom: true, mo: true, item: true, qty: true, planNo: true },
  });
  const existingCount = new Map<string, number>();
  for (const e of existing) existingCount.set(sig(e), (existingCount.get(sig(e)) ?? 0) + 1);

  const toInsert: Insert[] = [];
  let skippedExisting = 0;
  for (const [key, { count, rec }] of desired) {
    const have = existingCount.get(key) ?? 0;
    const add = Math.max(0, count - have);
    for (let i = 0; i < add; i++) toInsert.push(rec);
    skippedExisting += Math.min(count, have);
  }

  if (!preview) {
    for (let i = 0; i < toInsert.length; i += 500) {
      await prisma.handoverEntry.createMany({
        data: toInsert.slice(i, i + 500).map((r) => ({ ...r, source: "import" })),
      });
    }
  }

  return {
    ok: true,
    ...(preview ? { preview: true } : {}),
    added: toInsert.length,
    skippedExisting,
    invalid,
    corrected,
    unknownBoms: [...unknownBoms].slice(0, 50),
    issues,
  };
}
