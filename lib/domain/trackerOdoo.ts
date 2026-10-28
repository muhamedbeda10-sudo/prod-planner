import { ITEMS, isItem, type Item } from "./constants";
import { isDoneStatus, odooRowBom } from "./odoo";
import { ITEM_PRODUCT, sameProduct } from "./odooMirror";
import { parseISODate, toISODate } from "./dates";
import { isFullyDelivered } from "./groupSpread";

/** Closed quantities exceeding the matching plans stay visible as unallocated. */
export interface OdooUnallocatedQuantity { key: string; item: Item; qty: number; mos: string[] }
interface Order {
  mo: string; bom: string; soi: string | null; line?: string; planQty: number;
  source?: string | null; months?: string | readonly string[]; eligibleItems?: readonly Item[];
}
interface Entry { id: number; date: Date | string; line: string; ledgerId: number | null; soi: string | null; fgCode: string; product: string; qty: number; status: string }
interface Ledger { id: number; mo: string | null; bom: string; item: string }
const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
/** How odooClosedByLedger keys an MO or item code. */
export const odooKey = norm;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Older saved month settings still mean the first day of that month. */
export function normalizeOdooTrackingStart(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  const date = /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : text;
  return parseISODate(date) ? date : null;
}
function monthRank(month: string) {
  const iso = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (iso) return Number(iso[1]) * 12 + Number(iso[2]) - 1;
  const m = /^(\w+)\s+(\d{4})$/.exec(month.trim());
  const index = m ? MONTHS.findIndex((name) => norm(name) === norm(m[1])) : -1;
  return m && index >= 0 ? Number(m[2]) * 12 + index : Infinity;
}

/** A carried MO is the same demand, owned by the plan that first introduced it. */
export function odooPlanMonth(order: Pick<Order, "source" | "months">): string | null {
  const months = typeof order.months === "string" ? order.months.split(",").map((m) => m.trim()).filter(Boolean) : [...(order.months ?? [])];
  const source = order.source?.trim();
  if (source && (!months.length || months.includes(source))) return source;
  return months.sort((a, b) => monthRank(a) - monthRank(b) || a.localeCompare(b))[0] ?? null;
}

/** The first monthly plan whose orders count Odoo's closings exactly: every
 *  Done row is credited to the one MO it was recorded against, never spread
 *  by BOM. Older plans keep the earlier allocation and show no Odoo column. */
export const ODOO_EXACT_FROM = "2026-10";
/** ODOO_EXACT_FROM as the plans name their month ("October 2026"). */
export const ODOO_EXACT_FROM_LABEL = `${MONTHS[Number(ODOO_EXACT_FROM.slice(5)) - 1]} ${ODOO_EXACT_FROM.slice(0, 4)}`;

/** An order planned in or after `from` (ODOO_EXACT_FROM; by the plan that first brought it). */
export function isOdooExactOrder(order: Pick<Order, "source" | "months">, from = ODOO_EXACT_FROM): boolean {
  const month = odooPlanMonth(order);
  return !!month && Number.isFinite(monthRank(month)) && monthRank(month) >= monthRank(from);
}

/** A closing the ODOO log counts: a Done / Closed row with a quantity — a transformer's, for the allocation. */
const isClosedQty = (entry: Pick<Entry, "status" | "qty">) => isDoneStatus(entry.status) && Number.isFinite(entry.qty) && entry.qty > 0;
const isClosingRow = (entry: Entry) => entry.line === "TR" && isClosedQty(entry);

/**
 * The Done / Closed rows of the ODOO log born from a daily-log closing, summed
 * by that closing's MO and item code (both upper case) — on any line: a
 * panel's painting is born into the log the same way a tank's is. Not capped
 * at the plan qty: a closing over the plan shows as one. The ledger's MO is
 * the record — its BOM is not checked against the order's.
 */
export function odooClosedByLedger(
  entries: readonly Pick<Entry, "ledgerId" | "status" | "qty">[],
  ledgers: readonly Pick<Ledger, "id" | "mo" | "item">[],
): Map<string, Map<string, number>> {
  const linked = new Map(ledgers.map((l) => [l.id, l]));
  const out = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    if (entry.ledgerId === null || !isClosedQty(entry)) continue;
    const ledger = linked.get(entry.ledgerId);
    if (!ledger?.mo) continue;
    const mo = norm(ledger.mo), item = norm(ledger.item);
    const row = out.get(mo) ?? new Map<string, number>();
    row.set(item, (row.get(item) ?? 0) + entry.qty);
    out.set(mo, row);
  }
  return out;
}

/** The exact closings of the given transformer orders, by MO and component
 *  (odooClosedByLedger), leaving the components an order does not need. */
export function exactOdooClosings(
  orders: readonly Pick<Order, "mo" | "eligibleItems">[],
  entries: readonly Entry[],
  ledgers: readonly Ledger[],
): Map<string, Partial<Record<Item, number>>> {
  const closed = odooClosedByLedger(entries.filter((e) => e.line === "TR"), ledgers);
  const counts = new Map<string, Partial<Record<Item, number>>>();
  for (const order of orders) {
    const row: Partial<Record<Item, number>> = {};
    for (const [it, qty] of closed.get(norm(order.mo)) ?? []) {
      if (isItem(it) && (!order.eligibleItems || order.eligibleItems.includes(it))) row[it] = qty;
    }
    if (Object.keys(row).length) counts.set(order.mo, row);
  }
  return counts;
}

function inTrackingWindow(order: Order, trackingFrom: string | null): boolean {
  const month = odooPlanMonth(order);
  const start = normalizeOdooTrackingStart(trackingFrom)?.slice(0, 7);
  return !!start && !!month && Number.isFinite(monthRank(month)) && monthRank(month) >= monthRank(start);
}

/** Each Odoo log quantity is read once. The planner's MO comes from its linked ledger,
 * never from Odoo's different MO numbering. Project imports fill the oldest plan
 * first, once per MO/component, up to that MO's requirement. Allocation happens
 * against the whole registry BEFORE any month, search or status filter. */
export function trackerOdooQuantities(
  orders: readonly Order[], entries: readonly Entry[], ledgers: readonly Ledger[], trackingFrom: string | null = null,
  { exactFrom = ODOO_EXACT_FROM }: { exactFrom?: string } = {},
) {
  const startDate = normalizeOdooTrackingStart(trackingFrom);
  // an order's plan month and tracking window, worked out once each — the
  // allocation below asks for them again for every entry it places
  const rankCache = new Map<Order, number>(), windowCache = new Map<Order, boolean>();
  const rankOf = (o: Order) => { let r = rankCache.get(o); if (r === undefined) { r = monthRank(odooPlanMonth(o) ?? ""); rankCache.set(o, r); } return r; };
  const inWindow = (o: Order) => { let w = windowCache.get(o); if (w === undefined) { w = inTrackingWindow(o, trackingFrom); windowCache.set(o, w); } return w; };
  const byMo = new Map(orders.filter((o) => !o.line || o.line === "TR").map((o) => [norm(o.mo), o]));
  const byBom = new Map<string, Order[]>(), bySoi = new Map<string, Order[]>();
  const push = (map: Map<string, Order[]>, key: string, order: Order) => { const list = map.get(key); if (list) list.push(order); else map.set(key, [order]); };
  for (const order of byMo.values()) {
    const bom = norm(order.bom), soi = norm(order.soi);
    push(byBom, bom, order);
    if (soi) push(bySoi, soi, order);
  }
  // each BOM's orders in the order they are filled — the oldest plan first —
  // sorted once here: every candidate list below is this list or a filter of
  // it, and a filter keeps the order
  const fifoOrder = (a: Order, b: Order) => rankOf(a) - rankOf(b) || a.mo.localeCompare(b.mo, undefined, { numeric: true });
  for (const list of byBom.values()) list.sort(fifoOrder);
  const linked = new Map(ledgers.map((l) => [l.id, l]));
  const tracked = new Set<string>();
  // the orders from ODOO_EXACT_FROM on are counted exactly, apart from the
  // allocation below: nothing is spread onto them and nothing of theirs is
  // capped or pooled
  const exactRank = monthRank(exactFrom);
  const exactOrders = [...byMo.values()].filter((o) => Number.isFinite(rankOf(o)) && rankOf(o) >= exactRank);
  const isExact = new Set(exactOrders);
  for (const order of byMo.values()) {
    if (inWindow(order) || isExact.has(order)) for (const item of ITEMS) tracked.add(JSON.stringify([order.mo, item]));
  }
  const itemOf = (entry: Entry, ledger?: Ledger): Item | undefined => {
    // The BOM trace identifies the part through the production record, even
    // when an office row's freely typed product/FG code names something else.
    if (ledger && isItem(norm(ledger.item))) return norm(ledger.item) as Item;
    const code = norm(entry.product);
    return isItem(code) ? code : ITEMS.find((it) => sameProduct(entry.product, ITEM_PRODUCT[it].product));
  };
  // The existing BOM → On Odoo table is the primary record for a component.
  // Do not add separately imported/typed project rows on top of its closings.
  // Even an open linked row establishes this source: an import must not turn
  // a still-open production closing into a closed one on the tracker.
  const linkedProjects = new Set(entries.flatMap((entry) => {
    const ledger = entry.ledgerId === null ? undefined : linked.get(entry.ledgerId);
    const item = itemOf(entry, ledger);
    const order = ledger?.mo ? byMo.get(norm(ledger.mo)) : undefined;
    if (entry.line === "TR" && ledger && order && item && norm(order.bom) === norm(ledger.bom)) tracked.add(JSON.stringify([order.mo, item]));
    return entry.line === "TR" && ledger && item ? [JSON.stringify([norm(ledger.bom), item])] : [];
  }));
  const counts = exactOdooClosings(exactOrders, entries, ledgers);
  const pools = new Map<string, OdooUnallocatedQuantity>();
  const pending: { item: Item; qty: number; candidates: Order[]; id: number; exact: boolean }[] = [];
  const add = (mo: string, item: Item, qty: number) => { const row = counts.get(mo) ?? {}; row[item] = (row[item] ?? 0) + qty; counts.set(mo, row); };
  for (const entry of entries) {
    if (!isClosingRow(entry)) continue;
    const ledger = entry.ledgerId === null ? undefined : linked.get(entry.ledgerId);
    const item = itemOf(entry, ledger);
    if (!item) continue;
    if (ledger?.mo) {
      const order = byMo.get(norm(ledger.mo));
      if (order && !isExact.has(order) && norm(order.bom) === norm(ledger.bom)) pending.push({ item, qty: entry.qty, candidates: [order], id: entry.id, exact: true });
      continue;
    }
    // A recording start within a month must not pull in earlier project
    // imports from that same month. Explicitly linked historical MOs above
    // remain evidence for their own orders.
    const recordDate = entry.date instanceof Date ? toISODate(entry.date) : entry.date.slice(0, 10);
    if (startDate && (!parseISODate(recordDate) || recordDate < startDate)) continue;
    const soi = norm(entry.soi), sameSoi = bySoi.get(soi) ?? [];
    const bom = odooRowBom(entry.fgCode, ledger?.bom, sameSoi.map((o) => o.bom));
    if (bom.boms.length !== 1) continue;
    if (!ledger && linkedProjects.has(JSON.stringify([norm(bom.boms[0]), item]))) continue;
    let candidates = byBom.get(norm(bom.boms[0])) ?? [];
    const withinSoi = candidates.filter((o) => norm(o.soi) === soi && !!soi);
    if (withinSoi.length) candidates = withinSoi;
    else if (soi) candidates = candidates.filter((o) => !norm(o.soi)); // never credit a different customer's SOI
    if (!candidates.length) continue;
    pending.push({ item, qty: entry.qty, candidates, id: entry.id, exact: false });
  }
  // Reserve explicitly attributed quantities before distributing broader imports.
  pending.sort((a, b) => Number(b.exact) - Number(a.exact) || a.candidates.length - b.candidates.length || a.id - b.id);
  for (const { item, qty, candidates, exact } of pending) {
    let left = qty;
    // already the oldest plan first (byBom is sorted above; one exact order needs none)
    for (const order of candidates) {
      if (order.eligibleItems && !order.eligibleItems.includes(item)) continue;
      // Linked production MOs are evidence even before tracking began. A
      // project-only quantity cannot be spent on the untracked old backlog.
      if (!exact && !inWindow(order)) continue;
      if (isExact.has(order)) continue; // counted exactly above
      const room = Math.max(0, order.planQty - (counts.get(order.mo)?.[item] ?? 0));
      const allocated = Math.min(left, room);
      if (allocated > 0) { add(order.mo, item, allocated); left -= allocated; }
      if (left <= 0) break;
    }
    if (left > 0) {
      const mos = candidates.map((o) => o.mo).sort(), key = JSON.stringify([item, mos]);
      const pool = pools.get(key) ?? { key, item, qty: 0, mos };
      pool.qty += left; pools.set(key, pool);
    }
  }
  return { counts, unallocated: [...pools.values()], tracked };
}

/** Display a fixed allocation; filtering must never reassign old quantities to a new month. */
export function trackerOdooTotal(rows: readonly { mo: string; odooPlanMonth?: string | null; items: Record<Item, { odooClosed?: number }>; odooUnallocated?: readonly OdooUnallocatedQuantity[] }[], item: Item, month = "") {
  const pools = new Map(rows.flatMap((r) => (r.odooUnallocated ?? []).filter((p) => p.item === item).map((p) => [p.key, p] as const)));
  let qty = 0, unallocated = [...pools.values()].reduce((sum, pool) => sum + pool.qty, 0);
  for (const row of rows) {
    const value = row.items[item].odooClosed ?? 0;
    if (!month || (month === "—" ? !row.odooPlanMonth : row.odooPlanMonth === month)) qty += value;
    else if (!row.odooPlanMonth) unallocated += value;
  }
  return { qty, unallocated };
}

/** What the auto-close reads off a Plan Tracker row. */
export interface TrackerCloseRow {
  status: string;
  required: number;
  complete: number;
  hold: { onHold: boolean };
  pendingQty: unknown;
  items: Record<Item, { osp: number; eligible: boolean; excluded: boolean; odooClosed?: number }>;
}

/** Finished on the tracker, and every needed component closed in Odoo for
 *  its whole plan quantity — whatever its status. Odoo's closings judged as
 *  "Close N delivered" judges deliveries: outsourced pieces never pass the
 *  paint shop, so no Odoo row is born for them and they are not owed; an
 *  order wholly outsourced is never "closed in Odoo" by that alone. */
export function finishedAndClosedInOdoo(r: TrackerCloseRow): boolean {
  if (r.complete < r.required) return false;
  return isFullyDelivered(r.required, ITEMS.map((it) => ({ counts: r.items[it].eligible && !r.items[it].excluded, delivered: r.items[it].odooClosed ?? 0, osp: r.items[it].osp })));
}

/** An open order that closes by itself now: finished and closed in full in
 *  Odoo, and nobody still deciding about it (on hold, a plan qty waiting). */
export function closesByItself(r: TrackerCloseRow): boolean {
  return r.status === "open" && !r.hold.onHold && r.pendingQty == null && finishedAndClosedInOdoo(r);
}
