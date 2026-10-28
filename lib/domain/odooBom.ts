import { ITEMS, type Item } from "@/lib/domain/constants";

// ODOO BOMS — the plant's bills of materials as Odoo holds them, mirrored
// read-only (OdooBom / OdooBomLine). Each BoM is stored once with its own
// lines; a line that is built in house names the sub-BoM Odoo builds it with
// (childOdooId), so a transformer is a tree assembled here from its root:
//
//   FG-64022E11M11  (the transformer)
//     FA-64022E11M11        final assembly
//       FB-022-64022E11M11  the tank — HR sheets, angle bars, fins …
//       FB-051-64022E11M11  the top cover
//     FB-024-00009D12       a cable box → FB-024-00009S12 → its sheets
//
// Everything here is pure: the caller brings the BoMs. Quantities follow
// Odoo: a line's qty is for its BoM's qty, so a figure "per unit" divides by
// it; a component's figure in its own stock unit (stockQty) is what the
// store's stock is counted in.

// ---------------------------------------------------------------- records

export interface BomLineRec {
  seq: number;
  productCode: string;
  productName: string;
  /** For the BoM's qty, in `uom`. */
  qty: number;
  uom: string;
  /** The same quantity in the product's stock unit. */
  stockQty: number;
  stockUom: string;
  /** The sub-BoM Odoo builds this component with; null = bought or raw. */
  childOdooId: number | null;
}

export interface BomRec {
  odooId: number;
  code: string;
  productCode: string;
  productName: string;
  qty: number;
  uom: string;
  lines: BomLineRec[];
}

export type BomIndex = ReadonlyMap<number, BomRec>;

/** The deepest a tree is unfolded — Odoo's go five levels; a loop stops here too. */
export const MAX_BOM_DEPTH = 12;

// ---------------------------------------------------------------- the app's codes → Odoo

/** The Odoo references an order's BOM code may go by, in the order they are
 *  tried: transformers are filed as FG-<code> (or TX-<code> for the SEC
 *  types), the panels under the code itself. */
export function rootCodeCandidates(bom: string): string[] {
  const b = normBom(bom);
  if (!b) return [];
  return [...new Set([`FG-${b}`, `TX-${b}`, b])];
}

/** An order's BOM code as the mirror keys it. */
export function normBom(bom: string | null | undefined): string {
  return String(bom ?? "").trim().toUpperCase();
}

/** The part code each component is filed under in Odoo (FB-022-<bom> is the
 *  tank of <bom>). The mono box is FB-052 in Odoo's BoMs. */
export const BOM_ITEM_PART: Record<Item, string> = {
  CF: "FB-058",
  TC: "FB-051",
  TN: "FB-022",
  CB: "FB-024",
  AR: "FB-027",
  MB: "FB-052",
};

/** The component a product code is, by its part prefix — null for anything else. */
export function itemOfCode(code: string): Item | null {
  const c = code.trim().toUpperCase();
  for (const it of ITEMS) if (c.startsWith(`${BOM_ITEM_PART[it]}-`)) return it;
  return null;
}

// ---------------------------------------------------------------- the tree

export interface BomNode {
  /** A key unique within the tree: the seqs from the root, "3.1.4". */
  key: string;
  level: number;
  productCode: string;
  productName: string;
  /** The line as Odoo writes it, for ONE unit of its parent. */
  qty: number;
  uom: string;
  /** How many of it ONE unit of the root takes, in its stock unit. */
  perRoot: number;
  stockUom: string;
  /** The sub-BoM it is built with: its reference and id, null when bought / raw. */
  childCode: string | null;
  childId: number | null;
  /** Built in house but its BoM is not in the mirror (not synced yet). */
  childMissing: boolean;
  /** The component it is (tank, top cover …), by its part code. */
  item: Item | null;
  children: BomNode[];
}

const perUnit = (b: BomRec) => (b.qty > 0 ? b.qty : 1);

/** The tree of one BoM: its lines, each unfolded into its own sub-BoM, with
 *  what ONE unit of the root takes of every node. A BoM met again on its own
 *  path (a loop in Odoo) is not unfolded twice. */
export function expandBom(rootId: number, index: BomIndex, maxDepth = MAX_BOM_DEPTH): BomNode[] {
  const walk = (bomId: number, factor: number, level: number, prefix: string, path: Set<number>): BomNode[] => {
    const b = index.get(bomId);
    if (!b || level > maxDepth) return [];
    const div = perUnit(b);
    return [...b.lines].sort((x, y) => x.seq - y.seq).map((l, i) => {
      const key = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      const perRoot = round6((l.stockQty / div) * factor);
      const child = l.childOdooId !== null ? index.get(l.childOdooId) : undefined;
      const looping = l.childOdooId !== null && path.has(l.childOdooId);
      const children = child && !looping
        ? walk(child.odooId, perRoot, level + 1, key, new Set(path).add(child.odooId))
        : [];
      return {
        key, level, productCode: l.productCode, productName: l.productName,
        qty: round6(l.qty / div), uom: l.uom, perRoot, stockUom: l.stockUom,
        childCode: child ? child.code : null,
        childId: child ? child.odooId : null,
        childMissing: l.childOdooId !== null && !child,
        item: itemOfCode(l.productCode),
        children,
      };
    });
  };
  return walk(rootId, 1, 1, "", new Set([rootId]));
}

/** Every node of a tree, depth first, parents before their children. */
export function flattenNodes(nodes: readonly BomNode[]): BomNode[] {
  const out: BomNode[] = [];
  const go = (ns: readonly BomNode[]) => { for (const n of ns) { out.push(n); go(n.children); } };
  go(nodes);
  return out;
}

/** How many BoMs, lines and levels a tree spans. */
export function treeStats(nodes: readonly BomNode[]): { nodes: number; depth: number; raw: number; missing: number } {
  const all = flattenNodes(nodes);
  return {
    nodes: all.length,
    depth: all.reduce((m, n) => Math.max(m, n.level), 0),
    raw: all.filter((n) => n.childCode === null && !n.childMissing).length,
    missing: all.filter((n) => n.childMissing).length,
  };
}

// ---------------------------------------------------------------- raw materials

export interface RawNeed {
  productCode: string;
  productName: string;
  /** In the product's stock unit. */
  qty: number;
  uom: string;
}

/** The bought / raw lines one unit of a BoM's product takes, summed per code
 *  through every sub-BoM, in their stock units. A component built in house
 *  whose BoM is not in the mirror is left out and named in `incomplete`. */
export function rawMaterials(bomId: number, index: BomIndex): { lines: Map<string, RawNeed>; incomplete: string[] } {
  const memo = new Map<number, { lines: Map<string, RawNeed>; incomplete: string[] }>();
  const go = (id: number, path: Set<number>): { lines: Map<string, RawNeed>; incomplete: string[] } => {
    const hit = memo.get(id);
    if (hit) return hit;
    const b = index.get(id);
    const lines = new Map<string, RawNeed>();
    const incomplete: string[] = [];
    if (!b) return { lines, incomplete };
    const div = perUnit(b);
    for (const l of b.lines) {
      const per = l.stockQty / div;
      if (l.childOdooId === null) { addRaw(lines, l.productCode, l.productName, per, l.stockUom); continue; }
      if (!index.has(l.childOdooId) || path.has(l.childOdooId)) { incomplete.push(l.productCode); continue; }
      const sub = go(l.childOdooId, new Set(path).add(l.childOdooId));
      for (const r of sub.lines.values()) addRaw(lines, r.productCode, r.productName, r.qty * per, r.uom);
      incomplete.push(...sub.incomplete);
    }
    const res = { lines: roundRaw(lines), incomplete: [...new Set(incomplete)] };
    memo.set(id, res);
    return res;
  };
  return go(bomId, new Set([bomId]));
}

function addRaw(m: Map<string, RawNeed>, code: string, name: string, qty: number, uom: string) {
  const cur = m.get(code);
  if (cur) cur.qty += qty;
  else m.set(code, { productCode: code, productName: name, qty, uom });
}

function roundRaw(m: Map<string, RawNeed>): Map<string, RawNeed> {
  for (const r of m.values()) r.qty = round6(r.qty);
  return m;
}

// ---------------------------------------------------------------- components in the BoM

/** The components a transformer's BoM carries and how many of each one unit
 *  takes. A component is not searched for inside another (a cable box's own
 *  sheet BoM is still the cable box). */
export function bomItems(nodes: readonly BomNode[]): Map<Item, number> {
  const out = new Map<Item, number>();
  const go = (ns: readonly BomNode[]) => {
    for (const n of ns) {
      if (n.item) out.set(n.item, round6((out.get(n.item) ?? 0) + n.perRoot));
      else go(n.children);
    }
  };
  go(nodes);
  return out;
}

/** The component nodes of one kind, outermost only. */
export function itemNodes(nodes: readonly BomNode[], item: Item): BomNode[] {
  const out: BomNode[] = [];
  const go = (ns: readonly BomNode[]) => {
    for (const n of ns) {
      if (n.item === item) out.push(n);
      else if (!n.item) go(n.children);
    }
  };
  go(nodes);
  return out;
}

export interface ItemCheck {
  /** The order needs it (by the rules and the planner's N/A), Odoo's BoM has none. */
  notInBom: Item[];
  /** Odoo's BoM builds it, the order does not count it. */
  notRequired: Item[];
}

/** The order's components against its BoM's. Empty lists = they agree. */
export function checkItems(required: readonly Item[], inBom: ReadonlySet<Item> | ReadonlyMap<Item, number>): ItemCheck {
  const req = new Set(required);
  return {
    notInBom: ITEMS.filter((it) => req.has(it) && !inBom.has(it)),
    notRequired: ITEMS.filter((it) => !req.has(it) && inBom.has(it)),
  };
}

export const itemCheckOk = (c: ItemCheck) => c.notInBom.length === 0 && c.notRequired.length === 0;

// ---------------------------------------------------------------- BOM rate of a part

/** Where the mirror finds a part of a BoM code: its own BoM when Odoo files
 *  one under <part>-<code> (FB-022-14003E11M11, FB-024-00005S12), else the
 *  part's node in the transformer's tree. */
export interface PartLookup {
  /** odooId of the BoM building a product, by product code. */
  bomOfProduct: ReadonlyMap<string, number>;
  /** odooId of the root BoM of an order's BOM code. */
  rootOf: ReadonlyMap<string, number>;
  index: BomIndex;
}

/** The odooId of the BoM that builds part `partCode` of `bom`, or null when
 *  the mirror cannot say which. */
export function partBomId(partCode: string, bom: string, lk: PartLookup): number | null {
  const part = partCode.trim().toUpperCase();
  const b = normBom(bom);
  if (!part || !b) return null;
  const own = lk.bomOfProduct.get(`${part}-${b}`);
  if (own !== undefined && lk.index.has(own)) return own;
  const root = lk.rootOf.get(b);
  if (root === undefined) return null;
  // the part's sub-BoM in the tree — only when there is one: a transformer
  // with two cable boxes (LV and HV) cannot say which one a line means
  const ids = new Set(flattenNodes(expandBom(root, lk.index)).flatMap((n) => (n.productCode.toUpperCase().startsWith(`${part}-`) && n.childId !== null ? [n.childId] : [])));
  return ids.size === 1 ? [...ids][0] : null;
}

/** What one unit of a part takes of each material, per Odoo — null when the
 *  mirror has no BoM for the part. */
export function partRates(partCode: string, bom: string, lk: PartLookup): Map<string, RawNeed> | null {
  const id = partBomId(partCode, bom, lk);
  return id === null ? null : rawMaterials(id, lk.index).lines;
}

// ---------------------------------------------------------------- Odoo's figure beside the material sheet's

/** Odoo's BOM figure per part, keyed "PART|BOM" → material code (upper) → per unit. */
export type OdooRates = Record<string, Record<string, { qty: number; uom: string; name?: string }> | null>;

export const odooRateKey = (partCode: string, bom: string) => `${partCode.trim().toUpperCase()}|${normBom(bom)}`;

/** A sheet is counted in pieces: only a figure in pieces compares with the
 *  material sheet's sheets per unit. */
export const isPieceUnit = (uom: string) => /^(PC|PCS|UNITS?)$/i.test(uom.trim());

export type OdooRate =
  | { kind: "unknown"; why: string }
  | { kind: "absent" }
  | { kind: "value"; qty: number; uom: string; /** in pieces, so it compares with the sheet */ comparable: boolean; differs: boolean };

/** What Odoo's BoM says one part takes of a sheet line's material. */
export function odooRateOf(rates: OdooRates, line: { partCode: string; bom: string; materialCode: string; sheetsPerUnit: number }): OdooRate {
  if (!line.partCode.trim()) return { kind: "unknown", why: "The line has no part code to look up" };
  const part = rates[odooRateKey(line.partCode, line.bom)];
  if (!part) return { kind: "unknown", why: "No Odoo BoM synced for this part" };
  const code = line.materialCode.trim().toUpperCase();
  if (!code) return { kind: "unknown", why: "The line has no material code to look up" };
  const v = part[code];
  if (!v) return { kind: "absent" };
  const comparable = isPieceUnit(v.uom);
  return { kind: "value", qty: v.qty, uom: v.uom, comparable, differs: comparable && Math.abs(v.qty - line.sheetsPerUnit) > 0.0005 };
}

// ---------------------------------------------------------------- the open plan's material need

export interface CutRow { mo: string | null; bom: string; item: string; qty: number }

/** Fabrication's logged pieces per order and component ("MO|ITEM"). A row
 *  logged without an MO (the Daily log's form records none) counts for its
 *  code's order when the code has exactly one open order; with several it
 *  cannot be split and is returned apart, per code. */
export function cutByOrder(orders: readonly { mo: string; bom: string }[], rows: readonly CutRow[]): { done: Map<string, number>; loose: { bom: string; orders: number; qty: number }[] } {
  const mos = new Set(orders.map((o) => o.mo));
  const byBom = new Map<string, string[]>();
  for (const o of orders) { const b = normBom(o.bom); const l = byBom.get(b); if (l) l.push(o.mo); else byBom.set(b, [o.mo]); }
  const done = new Map<string, number>();
  const loose = new Map<string, { bom: string; orders: number; qty: number }>();
  const add = (mo: string, item: string, qty: number) => done.set(`${mo}|${item}`, (done.get(`${mo}|${item}`) ?? 0) + qty);
  for (const r of rows) {
    const mo = (r.mo ?? "").trim();
    if (mo) { if (mos.has(mo)) add(mo, r.item, r.qty); continue; }
    const b = normBom(r.bom);
    const of = byBom.get(b) ?? [];
    if (of.length === 1) add(of[0], r.item, r.qty);
    else if (of.length > 1) { const l = loose.get(b) ?? { bom: b, orders: of.length, qty: 0 }; l.qty += r.qty; loose.set(b, l); }
  }
  return { done, loose: [...loose.values()] };
}

export interface NeedOrder {
  mo: string;
  bom: string;
  line: "TR" | "LV";
  /** TR: units of each component still to cut. LV: panels still to punch. */
  remaining: Partial<Record<Item, number>> | number;
}

export interface NeedLine extends RawNeed {
  /** The orders it is needed for, biggest first. */
  orders: { mo: string; qty: number }[];
}

export interface NeedGap {
  mo: string;
  bom: string;
  /** What could not be counted, said plainly. */
  reason: string;
}

export interface MaterialNeed {
  lines: Map<string, NeedLine>;
  /** Orders, or components of orders, whose material is not counted. */
  gaps: NeedGap[];
  /** Orders whose need was counted in full. */
  counted: number;
}

/** The raw material the open plan still needs: per transformer, each
 *  component's units still to cut × what one takes (the component's own
 *  sub-tree); per panel order, the panels still to punch × the whole BoM. */
export function materialNeed(orders: readonly NeedOrder[], rootOf: ReadonlyMap<string, number>, index: BomIndex): MaterialNeed {
  const lines = new Map<string, NeedLine>();
  const gaps: NeedGap[] = [];
  let counted = 0;
  const add = (mo: string, r: RawNeed, times: number) => {
    const q = r.qty * times;
    if (!(q > 0)) return;
    let cur = lines.get(r.productCode);
    if (!cur) { cur = { ...r, qty: 0, orders: [] }; lines.set(r.productCode, cur); }
    cur.qty += q;
    const o = cur.orders.find((x) => x.mo === mo);
    if (o) o.qty += q; else cur.orders.push({ mo, qty: q });
  };
  const rawOf = new Map<number, ReturnType<typeof rawMaterials>>();
  const raw = (id: number) => { let r = rawOf.get(id); if (!r) { r = rawMaterials(id, index); rawOf.set(id, r); } return r; };

  for (const o of orders) {
    const root = rootOf.get(normBom(o.bom));
    if (root === undefined || !index.has(root)) {
      gaps.push({ mo: o.mo, bom: o.bom, reason: "no Odoo BoM for this code" });
      continue;
    }
    let whole = true;
    if (typeof o.remaining === "number") {
      if (o.remaining <= 0) continue;
      const r = raw(root);
      for (const l of r.lines.values()) add(o.mo, l, o.remaining);
      if (r.incomplete.length) { whole = false; gaps.push({ mo: o.mo, bom: o.bom, reason: `sub-BoM not synced: ${r.incomplete.slice(0, 3).join(", ")}` }); }
    } else {
      const tree = expandBom(root, index);
      const left = o.remaining;
      let any = false;
      for (const it of ITEMS) {
        const units = left[it] ?? 0;
        if (!(units > 0)) continue;
        any = true;
        const ns = itemNodes(tree, it);
        if (ns.length === 0) { whole = false; gaps.push({ mo: o.mo, bom: o.bom, reason: `no ${it} in the BoM` }); continue; }
        for (const n of ns) {
          const childId = n.childId;
          if (childId === null) {
            // bought finished (no BoM of its own): no raw material to count
            if (n.childMissing) { whole = false; gaps.push({ mo: o.mo, bom: o.bom, reason: `${n.productCode}'s BoM not synced` }); }
            continue;
          }
          const r = raw(childId);
          for (const l of r.lines.values()) add(o.mo, l, units * n.perRoot);
          if (r.incomplete.length) { whole = false; gaps.push({ mo: o.mo, bom: o.bom, reason: `sub-BoM not synced: ${r.incomplete.slice(0, 3).join(", ")}` }); }
        }
      }
      if (!any) continue;
    }
    if (whole) counted++;
  }
  for (const l of lines.values()) {
    l.qty = round6(l.qty);
    for (const x of l.orders) x.qty = round6(x.qty);
    l.orders.sort((a, b) => b.qty - a.qty || a.mo.localeCompare(b.mo));
  }
  return { lines, gaps, counted };
}

/** A transformer order's units still to cut, per required component: the
 *  plan less what Fabrication logged and what is outsourced (never below 0).
 *  Components with nothing left are left out. */
export function remainingToCut(
  o: { planQty: number; required: readonly Item[]; osp: Partial<Record<Item, number>> },
  cut: (item: Item) => number,
): Partial<Record<Item, number>> {
  const out: Partial<Record<Item, number>> = {};
  for (const it of o.required) {
    const left = round6(o.planQty - cut(it) - (o.osp[it] ?? 0));
    if (left > 0) out[it] = left;
  }
  return out;
}

/** A panel order's panels still to punch (never below 0). */
export function panelsToPunch(planQty: number, punched: number): number {
  return Math.max(0, round6(planQty - punched));
}

export interface StockAfterPlan {
  need: number;
  /** The unit Odoo's BoMs count the need in. */
  uom: string;
  /** The store counts it in the same unit (or one side names none). */
  sameUnit: boolean;
  /** SF01 − need, to the hundredth; null when the units differ. */
  after: number | null;
}

/** One stock code against the open plan's need of it — null when the plan
 *  needs none. A code counted in another unit by Odoo than by the store gets
 *  no After plan: pieces and kilos are never subtracted. */
export function stockAfterPlan(stock: { uom: string; odoo: number }, need: { qty: number; uom: string } | undefined): StockAfterPlan | null {
  if (!need) return null;
  const a = stock.uom.trim().toUpperCase(), b = need.uom.trim().toUpperCase();
  const sameUnit = !a || !b || a === b;
  return { need: need.qty, uom: need.uom, sameUnit, after: sameUnit ? Math.round((stock.odoo - need.qty) * 100) / 100 : null };
}

// ---------------------------------------------------------------- how a code was found

/** How the Odoo pull tied an order code to its BoM (lib/domain/odooBomPull.ts). */
export const ROOT_VIA = ["code", "product", "mo", "missing"] as const;
export type RootVia = (typeof ROOT_VIA)[number];

// ---------------------------------------------------------------- helpers

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
