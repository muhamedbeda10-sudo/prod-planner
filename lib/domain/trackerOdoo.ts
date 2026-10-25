import { ITEMS, isItem, type Item } from "./constants";
import { isDoneStatus, odooRowBom } from "./odoo";
import { ITEM_PRODUCT, sameProduct } from "./odooMirror";

export interface OdooSharedQuantity { key: string; item: Item; qty: number; mos: string[] }
interface Order { mo: string; bom: string; soi: string | null; line?: string }
interface Entry { id: number; line: string; ledgerId: number | null; soi: string | null; fgCode: string; product: string; qty: number; status: string }
interface Ledger { id: number; mo: string | null; bom: string; item: string }
const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** Each Odoo log quantity is read once. The planner's MO comes from its linked ledger,
 * never from Odoo's different MO numbering. Ambiguous imports remain a project pool. */
export function trackerOdooQuantities(orders: readonly Order[], entries: readonly Entry[], ledgers: readonly Ledger[]) {
  const byMo = new Map(orders.filter((o) => !o.line || o.line === "TR").map((o) => [norm(o.mo), o]));
  const byBom = new Map<string, Order[]>(), bySoi = new Map<string, Order[]>();
  for (const order of byMo.values()) {
    const bom = norm(order.bom), soi = norm(order.soi);
    byBom.set(bom, [...(byBom.get(bom) ?? []), order]);
    if (soi) bySoi.set(soi, [...(bySoi.get(soi) ?? []), order]);
  }
  const linked = new Map(ledgers.map((l) => [l.id, l]));
  const counts = new Map<string, Partial<Record<Item, number>>>();
  const pools = new Map<string, OdooSharedQuantity>();
  const add = (mo: string, item: Item, qty: number) => { const row = counts.get(mo) ?? {}; row[item] = (row[item] ?? 0) + qty; counts.set(mo, row); };
  for (const entry of entries) {
    if (entry.line !== "TR" || !isDoneStatus(entry.status) || !Number.isFinite(entry.qty) || entry.qty <= 0) continue;
    const ledger = entry.ledgerId === null ? undefined : linked.get(entry.ledgerId);
    const code = norm(entry.product);
    const item = isItem(code) ? code : ITEMS.find((it) => sameProduct(entry.product, ITEM_PRODUCT[it].product));
    if (!item) continue;
    if (ledger?.mo) {
      const order = byMo.get(norm(ledger.mo));
      if (order) add(order.mo, item, entry.qty);
      continue;
    }
    const soi = norm(entry.soi), sameSoi = bySoi.get(soi) ?? [];
    const bom = odooRowBom(entry.fgCode, ledger?.bom, sameSoi.map((o) => o.bom));
    if (bom.boms.length !== 1) continue;
    let candidates = byBom.get(norm(bom.boms[0])) ?? [];
    const withinSoi = candidates.filter((o) => norm(o.soi) === soi && !!soi);
    if (withinSoi.length) candidates = withinSoi;
    if (candidates.length === 1) { add(candidates[0].mo, item, entry.qty); continue; }
    if (!candidates.length) continue;
    const mos = candidates.map((o) => o.mo).sort(), key = JSON.stringify([item, mos]);
    const pool = pools.get(key) ?? { key, item, qty: 0, mos };
    pool.qty += entry.qty; pools.set(key, pool);
  }
  return { counts, pools: [...pools.values()] };
}

/** A shared project import counts once only when all candidate MOs are in this visible group.
 * Partial/expanded MO views expose the uncertainty instead of repeating the project's qty. */
export function trackerOdooTotal(rows: readonly { mo: string; items: Record<Item, { odooClosed?: number }>; odooShared?: readonly OdooSharedQuantity[] }[], item: Item) {
  const mos = new Set(rows.map((r) => r.mo)), pools = new Map(rows.flatMap((r) => (r.odooShared ?? []).filter((p) => p.item === item).map((p) => [p.key, p] as const)));
  let qty = rows.reduce((sum, row) => sum + (row.items[item].odooClosed ?? 0), 0), unallocated = 0;
  for (const pool of pools.values()) {
    if (pool.mos.every((mo) => mos.has(mo))) qty += pool.qty;
    else unallocated += pool.qty;
  }
  return { qty, unallocated };
}
