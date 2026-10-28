import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { ITEMS, applicableItems, ospOf, type Item } from "@/lib/domain/constants";
import { LV_ITEM } from "@/lib/domain/lv";
import type { ProductLine } from "@/lib/domain/lines";
import {
  bomItems, checkItems, cutByOrder, expandBom, itemCheckOk, materialNeed, normBom, odooRateKey, panelsToPunch, partBomId, rawMaterials, remainingToCut, treeStats,
  type BomIndex, type BomNode, type BomRec, type ItemCheck, type NeedGap, type NeedOrder, type OdooRates, type PartLookup,
} from "@/lib/domain/odooBom";

// The Odoo BoM mirror's reads. The Odoo sync wrote it until it was removed
// (2026-10-28); the tables keep what it last read and the app only reads. The BoMs
// are loaded from the roots a screen needs down through their sub-BoMs, level
// by level, never the whole table for one tree.

// ---------------------------------------------------------------- loading

/** The BoMs reachable from these ids, each with its lines. */
export async function loadBomIndex(seed: Iterable<number>): Promise<Map<number, BomRec>> {
  const index = new Map<number, BomRec>();
  let next = [...new Set(seed)];
  for (let depth = 0; next.length > 0 && depth < 12; depth++) {
    const rows = await prisma.odooBom.findMany({ where: { odooId: { in: next } }, include: { lines: { orderBy: { seq: "asc" } } } });
    const found: number[] = [];
    for (const r of rows) {
      index.set(r.odooId, {
        odooId: r.odooId, code: r.code, productCode: r.productCode, productName: r.productName, qty: r.qty, uom: r.uom,
        lines: r.lines.map((l) => ({ seq: l.seq, productCode: l.productCode, productName: l.productName, qty: l.qty, uom: l.uom, stockQty: l.stockQty, stockUom: l.stockUom, childOdooId: l.childOdooId })),
      });
      for (const l of r.lines) if (l.childOdooId !== null && !index.has(l.childOdooId)) found.push(l.childOdooId);
    }
    next = [...new Set(found)].filter((id) => !index.has(id));
  }
  return index;
}

export interface RootInfo { odooId: number | null; via: string; syncedAtISO: string }

/** Every order code the sync has looked up, keyed upper case. */
export const loadRoots = cache(async (): Promise<Map<string, RootInfo>> => {
  const rows = await prisma.odooBomRoot.findMany();
  return new Map(rows.map((r) => [r.bom, { odooId: r.odooId, via: r.via, syncedAtISO: r.syncedAt.toISOString() }]));
});

const foundRoots = (roots: ReadonlyMap<string, RootInfo>) =>
  new Map([...roots].flatMap(([bom, r]) => (r.odooId === null ? [] : [[bom, r.odooId] as const])));

export interface SyncView {
  /** When the Odoo sync last read the codes' BoMs. */
  atISO: string;
  /** BoMs and lines the mirror holds. */
  boms: number;
  lines: number;
  /** Codes tied to a BoM, and those Odoo has none for. */
  roots: number;
  missing: number;
}

/** What the mirror holds and when the Odoo sync last read it; null before any. */
export async function lastBomSync(): Promise<SyncView | null> {
  const [last, boms, lines, roots, missing] = await Promise.all([
    prisma.odooBomRoot.aggregate({ _max: { syncedAt: true } }),
    prisma.odooBom.count(),
    prisma.odooBomLine.count(),
    prisma.odooBomRoot.count({ where: { odooId: { not: null } } }),
    prisma.odooBomRoot.count({ where: { odooId: null } }),
  ]);
  const at = last._max.syncedAt;
  return at ? { atISO: at.toISOString(), boms, lines, roots, missing } : null;
}

// ---------------------------------------------------------------- the open orders

interface OpenOrder {
  mo: string;
  bom: string;
  line: ProductLine;
  planQty: number;
  held: boolean;
  required: Item[];
  osp: Record<Item, number>;
}

const openOrders = cache(async (): Promise<OpenOrder[]> => {
  const rows = await prisma.masterOrder.findMany({ where: { status: "open" }, orderBy: [{ bom: "asc" }, { mo: "asc" }] });
  return rows.filter((o) => normBom(o.bom)).map((o) => ({
    mo: o.mo,
    bom: normBom(o.bom),
    line: o.line === "LV" ? "LV" : "TR",
    planQty: o.planQty,
    held: o.holdAt !== null,
    required: o.line === "LV" ? [] : applicableItems(o),
    osp: Object.fromEntries(ITEMS.map((it) => [it, ospOf(o, it)])) as Record<Item, number>,
  }));
});

// ---------------------------------------------------------------- the BoMs page

export interface BomListRow {
  bom: string;
  line: ProductLine;
  orders: number;
  /** Planned units over the open orders. */
  units: number;
  root: { odooId: number; via: string; code: string; productName: string } | null;
  /** Looked up by a sync at all (null = no sync has seen this code yet). */
  looked: boolean;
  stats: ReturnType<typeof treeStats> | null;
  /** The components the BoM carries (transformers). */
  items: Item[];
  /** Orders whose components disagree with the BoM. */
  mismatched: number;
}

export interface BomOrderCheck {
  mo: string;
  planQty: number;
  held: boolean;
  required: Item[];
  check: ItemCheck | null;
}

export interface BomTreeData {
  bom: string;
  line: ProductLine;
  root: { odooId: number; via: string; code: string; productCode: string; productName: string; syncedAtISO: string } | null;
  looked: boolean;
  nodes: BomNode[];
  stats: ReturnType<typeof treeStats> | null;
  items: { item: Item; perUnit: number }[];
  orders: BomOrderCheck[];
  /** One unit's raw materials, summed through the tree. */
  raw: { productCode: string; productName: string; qty: number; uom: string }[];
  incomplete: string[];
}

/** Every code the open orders are built with, one row each. */
export async function getBomList(): Promise<BomListRow[]> {
  const [orders, roots] = await Promise.all([openOrders(), loadRoots()]);
  // per line and code: a code is one line's, but nothing stops the registry
  // from carrying it on both, and each line's orders are checked on their own
  const byBom = new Map<string, OpenOrder[]>();
  for (const o of orders) { const k = `${o.line}|${o.bom}`; const l = byBom.get(k); if (l) l.push(o); else byBom.set(k, [o]); }
  const ids = [...byBom.values()].flatMap((os) => { const r = roots.get(os[0].bom); return r?.odooId ? [r.odooId] : []; });
  const index = await loadBomIndex(ids);
  const rows: BomListRow[] = [];
  for (const os of byBom.values()) {
    const bom = os[0].bom;
    const r = roots.get(bom);
    const rec = r?.odooId ? index.get(r.odooId) : undefined;
    const tree = rec ? expandBom(rec.odooId, index) : null;
    const items = tree ? bomItems(tree) : null;
    const line = os[0].line;
    rows.push({
      bom, line, orders: os.length, units: os.reduce((a, o) => a + o.planQty, 0),
      root: rec && r ? { odooId: rec.odooId, via: r.via, code: rec.code, productName: rec.productName } : null,
      looked: !!r,
      stats: tree ? treeStats(tree) : null,
      items: items ? ITEMS.filter((it) => items.has(it)) : [],
      mismatched: items && line === "TR" ? os.filter((o) => !itemCheckOk(checkItems(o.required, items))).length : 0,
    });
  }
  return rows.sort((a, b) => a.line.localeCompare(b.line) || a.bom.localeCompare(b.bom));
}

/** One code's tree, its components against its open orders', and the raw
 *  materials one unit takes. */
export async function getBomTree(bomIn: string, lineAsked: ProductLine): Promise<BomTreeData> {
  const bom = normBom(bomIn);
  const [orders, roots] = await Promise.all([openOrders(), loadRoots()]);
  // the line is the orders' own — a closed order's when no open one carries
  // the code, else the line the address names; never guessed from the code
  const open = orders.filter((o) => o.bom === bom);
  let line: ProductLine = lineAsked;
  if (!open.some((o) => o.line === lineAsked)) {
    const any = open[0] ?? await prisma.masterOrder.findFirst({ where: { bom: { equals: bom, mode: "insensitive" } }, select: { line: true }, orderBy: { updatedAt: "desc" } });
    if (any) line = any.line === "LV" ? "LV" : "TR";
  }
  const mine = open.filter((o) => o.line === line);
  const r = roots.get(bom);
  const index = r?.odooId ? await loadBomIndex([r.odooId]) : new Map<number, BomRec>();
  const rec = r?.odooId ? index.get(r.odooId) : undefined;
  if (!rec || !r) {
    return { bom, line, root: null, looked: !!r, nodes: [], stats: null, items: [], orders: mine.map((o) => ({ mo: o.mo, planQty: o.planQty, held: o.held, required: o.required, check: null })), raw: [], incomplete: [] };
  }
  const nodes = expandBom(rec.odooId, index);
  const items = bomItems(nodes);
  const raw = rawMaterials(rec.odooId, index);
  return {
    bom, line,
    root: { odooId: rec.odooId, via: r.via, code: rec.code, productCode: rec.productCode, productName: rec.productName, syncedAtISO: r.syncedAtISO },
    looked: true,
    nodes,
    stats: treeStats(nodes),
    items: ITEMS.filter((it) => items.has(it)).map((it) => ({ item: it, perUnit: items.get(it) ?? 0 })),
    orders: mine.map((o) => ({ mo: o.mo, planQty: o.planQty, held: o.held, required: o.required, check: o.line === "TR" ? checkItems(o.required, items) : null })),
    raw: [...raw.lines.values()].sort((a, b) => a.productCode.localeCompare(b.productCode)),
    incomplete: raw.incomplete,
  };
}

/** The open transformer orders whose components disagree with their
 *  code's Odoo BoM, by MO — the Orders Registry flags them. */
export async function getOrderBomChecks(): Promise<Record<string, ItemCheck>> {
  const [orders, roots] = await Promise.all([openOrders(), loadRoots()]);
  const tr = orders.filter((o) => o.line === "TR");
  const rootOf = foundRoots(roots);
  const index = await loadBomIndex(tr.flatMap((o) => { const id = rootOf.get(o.bom); return id === undefined ? [] : [id]; }));
  const itemsOf = new Map<string, ReturnType<typeof bomItems>>();
  const out: Record<string, ItemCheck> = {};
  for (const o of tr) {
    const id = rootOf.get(o.bom);
    if (id === undefined || !index.has(id)) continue;
    let items = itemsOf.get(o.bom);
    if (!items) { items = bomItems(expandBom(id, index)); itemsOf.set(o.bom, items); }
    const c = checkItems(o.required, items);
    if (!itemCheckOk(c)) out[o.mo] = c;
  }
  return out;
}

// ---------------------------------------------------------------- BOM rates for the material sheet

/** What Odoo's BoM says one unit of each part takes of each material, keyed
 *  "PART|BOM" → material code → qty and unit; null where the mirror has no
 *  BoM for the part. An empty part code reads the code's whole BoM. */
export async function getPartRates(keys: readonly { partCode: string; bom: string }[]): Promise<OdooRates> {
  const wanted = [...new Map(keys.map((k) => [odooRateKey(k.partCode, k.bom), k])).entries()].filter(([, k]) => normBom(k.bom));
  if (wanted.length === 0) return {};
  const roots = await loadRoots();
  const rootOf = foundRoots(roots);
  const ownCodes = wanted.flatMap(([, k]) => (k.partCode.trim() ? [`${k.partCode.trim().toUpperCase()}-${normBom(k.bom)}`] : []));
  const own = ownCodes.length ? await prisma.odooBom.findMany({ where: { productCode: { in: ownCodes, mode: "insensitive" } }, select: { odooId: true, productCode: true } }) : [];
  const seed = [...own.map((o) => o.odooId), ...wanted.flatMap(([, k]) => { const id = rootOf.get(normBom(k.bom)); return id === undefined ? [] : [id]; })];
  const index: BomIndex = await loadBomIndex(seed);
  const lk: PartLookup = { index, rootOf, bomOfProduct: new Map(own.map((o) => [o.productCode.toUpperCase(), o.odooId])) };
  const out: OdooRates = {};
  for (const [key, k] of wanted) {
    const id = k.partCode.trim() ? partBomId(k.partCode, k.bom, lk) : (rootOf.get(normBom(k.bom)) ?? null);
    if (id === null || !index.has(id)) { out[key] = null; continue; }
    out[key] = Object.fromEntries([...rawMaterials(id, index).lines.values()].map((r) => [r.productCode.toUpperCase(), { qty: r.qty, uom: r.uom, name: r.productName }]));
  }
  return out;
}

// ---------------------------------------------------------------- the open plan's material need

export interface NeedView {
  /** Material code (upper case) → the need and the orders behind it. */
  byCode: Record<string, { qty: number; uom: string; orders: { mo: string; qty: number }[] }>;
  gaps: NeedGap[];
  /** Orders with something left to cut / punch, and how many were counted in full. */
  orders: number;
  counted: number;
  /** Orders on hold are left out — they are out of every queue. */
  held: number;
}

/** The raw material the open, unheld orders still need: each transformer
 *  component's units still to cut (plan − cut − outsourced) and each panel
 *  order's panels still to punch, through Odoo's BoMs. */
export const getMaterialNeed = cache(async (): Promise<NeedView> => {
  const [orders, roots] = await Promise.all([openOrders(), loadRoots()]);
  const live = orders.filter((o) => !o.held);
  const mos = live.map((o) => o.mo);
  const boms = [...new Set(live.filter((o) => o.line === "TR").map((o) => o.bom))];
  // what Fabrication cut per order — rows logged without an MO count for their
  // code's only open order (cutByOrder); the panels' punching always has its MO
  const [cutRows, punched] = mos.length ? await Promise.all([
    prisma.handoverEntry.groupBy({
      by: ["mo", "bom", "item"],
      where: { dept: "Cut", OR: [{ mo: { in: mos } }, { OR: [{ mo: null }, { mo: "" }], bom: { in: boms, mode: "insensitive" } }] },
      _sum: { qty: true },
    }),
    prisma.handoverEntry.groupBy({ by: ["mo"], where: { dept: "Punching", item: LV_ITEM, mo: { in: mos } }, _sum: { qty: true } }),
  ]) : [[], []];
  const cut = cutByOrder(live.filter((o) => o.line === "TR"), cutRows.map((r) => ({ mo: r.mo, bom: r.bom, item: r.item, qty: r._sum.qty ?? 0 })));
  const punchedOf = new Map(punched.map((p) => [p.mo ?? "", p._sum.qty ?? 0]));
  const needOrders: NeedOrder[] = [];
  for (const o of live) {
    if (o.line === "LV") {
      const left = panelsToPunch(o.planQty, punchedOf.get(o.mo) ?? 0);
      if (left > 0) needOrders.push({ mo: o.mo, bom: o.bom, line: "LV", remaining: left });
      continue;
    }
    const remaining = remainingToCut(o, (it) => cut.done.get(`${o.mo}|${it}`) ?? 0);
    if (Object.keys(remaining).length > 0) needOrders.push({ mo: o.mo, bom: o.bom, line: "TR", remaining });
  }
  const rootOf = foundRoots(roots);
  const index = await loadBomIndex(needOrders.flatMap((o) => { const id = rootOf.get(o.bom); return id === undefined ? [] : [id]; }));
  const need = materialNeed(needOrders, rootOf, index);
  // cut logged without an MO on a code with several open orders cannot be
  // taken off any one of them: the need is that much high, and says so
  const loose: NeedGap[] = cut.loose.map((l) => ({ mo: "", bom: l.bom, reason: `${l.qty} pieces cut without an MO cannot be split between its ${l.orders} open orders` }));
  return {
    byCode: Object.fromEntries([...need.lines.values()].map((l) => [l.productCode.toUpperCase(), { qty: l.qty, uom: l.uom, orders: l.orders }])),
    gaps: [...need.gaps, ...loose],
    orders: needOrders.length,
    counted: need.counted,
    held: orders.length - live.length,
  };
});
