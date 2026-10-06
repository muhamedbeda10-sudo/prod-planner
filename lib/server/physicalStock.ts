import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { parseStockGrid, stockView, type StockView } from "@/lib/domain/physicalStock";

export interface PhysicalStockItem extends StockView {
  id: number;
  note: string | null;
  updatedBy: string | null;
  updatedAtISO: string;
}

export interface PhysicalStockData {
  items: PhysicalStockItem[];
  /** The newest change to the table: when, and by whom. */
  lastUpdate: { atISO: string; by: string | null } | null;
}

export async function getPhysicalStock(): Promise<PhysicalStockData> {
  const rows = await prisma.physicalStock.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  const items = rows.map((r) => ({
    ...stockView({ code: r.code, name: r.name, uom: r.uom, physical: r.physical, odoo: r.odoo }),
    id: r.id, note: r.note, updatedBy: r.updatedBy, updatedAtISO: r.updatedAt.toISOString(),
  }));
  const newest = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.updatedAt > a.updatedAt ? r : a), null);
  return { items, lastUpdate: newest ? { atISO: newest.updatedAt.toISOString(), by: newest.updatedBy } : null };
}

export interface PhysicalImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  unchanged?: number;
  /** Codes on the tab the file does not carry — removed when asked, else kept. */
  missing?: number;
  removed?: number;
  issues?: string[];
}

/** The store's sheet → the table, matched on the product code (any case).
 *  A code already here is updated in place and keeps its note; `prune`
 *  removes the codes the file no longer carries. */
export async function importPhysicalStock(buf: ArrayBuffer, by: string | null, prune: boolean): Promise<PhysicalImportResult> {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { ok: false, error: "The file has no sheet." };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: true });
  const parsed = parseStockGrid(grid);
  if (parsed.rows.length === 0) return { ok: false, error: parsed.issues[0] ?? "No stock rows found in the file.", issues: parsed.issues };

  const existing = await prisma.physicalStock.findMany();
  const byCode = new Map(existing.map((r) => [r.code.toUpperCase(), r]));
  const seen = new Set<string>();
  let added = 0, updated = 0, unchanged = 0;
  await prisma.$transaction(async (tx) => {
    for (const [i, r] of parsed.rows.entries()) {
      const key = r.code.toUpperCase();
      seen.add(key);
      const cur = byCode.get(key);
      const data = { name: r.name, uom: r.uom, physical: r.physical, odoo: r.odoo, sortOrder: i + 1 };
      if (!cur) {
        await tx.physicalStock.create({ data: { code: r.code, ...data, updatedBy: by } });
        added++;
      } else if (cur.name !== r.name || cur.uom !== r.uom || cur.physical !== r.physical || cur.odoo !== r.odoo || cur.sortOrder !== i + 1) {
        // the figures moved — stamp who brought them; a re-sort alone is not news
        const figures = cur.physical !== r.physical || cur.odoo !== r.odoo || cur.name !== r.name || cur.uom !== r.uom;
        await tx.physicalStock.update({ where: { id: cur.id }, data: { ...data, ...(figures ? { updatedBy: by } : {}) } });
        if (figures) updated++; else unchanged++;
      } else unchanged++;
    }
  });
  const gone = existing.filter((r) => !seen.has(r.code.toUpperCase()));
  let removed = 0;
  if (prune && gone.length > 0) removed = (await prisma.physicalStock.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } })).count;
  return { ok: true, added, updated, unchanged, missing: gone.length, removed, issues: parsed.issues };
}
