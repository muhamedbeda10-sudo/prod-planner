// The sub-assembly MOs under a transformer's PF01 MO, walked down Odoo the
// way the monthly child-MO sheet has always been built (the
// atc-plan-child-mos workflow): its tank, top cover, core frame, cable box,
// arrester bracket and monobloc box, and the fins directly under a tank —
// never the final assembly, never below those. Only the shop floor's own MOs
// (SF01/…) count: a component assembled on another floor (a PF01 cable box)
// is walked through to the SF01 MO the departments actually make and close.
//
// Odoo does not link the plant's MOs one way only, so each child is tied to
// its parent by the first rule that holds:
//   direct    — the child's finished move feeds the parent's components (exact batch);
//   origin    — the child's origin names the parent;
//   qty_match — the origin is the parent's family or procurement group, and
//               exactly one of that family's batches has the child's qty;
//   shared    — the child's qty is the family's in-plan batches together;
//   batch     — done child batches split differently from the parent's, whose
//               quantities add up to one parent batch (or the whole family);
//   unresolved— several batches fit: listed under each, marked.
// Reads only (search_read / read through `rpc`); the I/O is the caller's.

import { batchBase, hasBatchSuffix, itemOfCode, productCodeOf } from "./odooSync";

/** One read call against Odoo: model, method, positional args, keyword args. */
export type OdooRpc = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>;

type M2O = [number, string] | false;
export interface RawMo {
  id: number;
  name: string;
  origin: string | false;
  product_id: M2O;
  product_qty: number;
  qty_produced?: number;
  product_uom_id: M2O;
  state: string;
  move_finished_ids: number[];
  procurement_group_id: M2O;
  date_finished?: string | false;
}

export const MO_FIELDS = [
  "name", "origin", "product_id", "product_qty", "qty_produced", "product_uom_id", "state", "move_finished_ids", "procurement_group_id", "date_finished",
] as const;

/** A child as found: under which of the app's orders, and how it was tied. */
export interface FoundChild {
  orderMo: string;
  odooId: number;
  name: string;
  item: string;
  productCode: string;
  qty: number;
  qtyProduced: number;
  uom: string;
  state: string;
  /** Odoo's date_finished ("YYYY-MM-DD HH:MM:SS", UTC), when done. */
  doneAt: string | null;
  linkHow: string;
  /** The other orders the same child is under. */
  sharedWith: string[];
}

export interface WalkResult {
  children: FoundChild[];
  /** The order's MO → the Odoo FG MO batch(es) it was read from. */
  planMap: Record<string, string[]>;
  /** Orders Odoo has no MO for (by name, or as batches of it). */
  notFound: string[];
  unresolved: number;
}

/** The shop floor's own MOs — the ones the app's departments make and close. */
export const SHOP_FLOOR_PREFIX = "SF01/";
const isShopFloor = (name: string) => name.toUpperCase().startsWith(SHOP_FLOOR_PREFIX);

const FINS = "FN";
const TANK = "TN";
const chunk = <T,>(a: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const groupName = (m: RawMo) => (m.procurement_group_id ? m.procurement_group_id[1] : null);
const codeOf = (m: RawMo) => productCodeOf(m.product_id ? m.product_id[1] : "");
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;

interface Node {
  mo: RawMo;
  roots: Set<string>;
  finsOnly: boolean;
  parents: string[];
  how: string;
}

interface Skipped {
  mo: RawMo;
  origin: string;
  candidates: { name: string; qty: number }[];
  others: { name: string; qty: number; state: string }[];
  finsCtx: boolean;
}

async function searchRead(rpc: OdooRpc, domain: unknown[], fields: readonly string[] = MO_FIELDS): Promise<RawMo[]> {
  return (await rpc("mrp.production", "search_read", [domain], { fields: [...fields], context: { lang: "en_US", active_test: false } })) as RawMo[];
}

/** Walk Odoo from the orders' PF01 MOs down to their tracked sub-assemblies. */
export async function walkChildMos(rpc: OdooRpc, orderMos: readonly string[], maxLevels = 9): Promise<WalkResult> {
  const planMap: Record<string, string[]> = {};
  const notFound: string[] = [];
  const nodes = new Map<number, Node>();
  const top: Node[] = [];
  const addTop = (mo: RawMo, order: string) => {
    let n = nodes.get(mo.id);
    if (!n) { n = { mo, roots: new Set(), finsOnly: false, parents: [], how: "top" }; nodes.set(mo.id, n); top.push(n); }
    n.roots.add(order);
  };

  // the orders' own MOs: by name, or — an order named without its batch
  // suffix — its open batches (all of them, when none is open any more)
  const names = [...new Set(orderMos.map((m) => m.trim().toUpperCase()).filter(Boolean))];
  const exact: RawMo[] = [];
  for (const c of chunk(names, 200)) exact.push(...(await searchRead(rpc, [["name", "in", c]])));
  const byExact = new Map(exact.map((m) => [m.name.toUpperCase(), m]));
  for (const order of names) {
    const hit = byExact.get(order);
    if (hit) { planMap[order] = [hit.name]; addTop(hit, order); continue; }
    if (hasBatchSuffix(order)) { notFound.push(order); planMap[order] = []; continue; }
    const batches = (await searchRead(rpc, [["name", "=like", `${order}-___`]])).filter((b) => b.state !== "cancel");
    const open = batches.filter((b) => b.state !== "done");
    const use = open.length ? open : batches;
    planMap[order] = use.map((b) => b.name);
    if (use.length === 0) notFound.push(order);
    for (const b of use) addTop(b, order);
  }

  const out: Node[] = [];
  const skipped: Skipped[] = [];
  let frontier = top;
  for (let level = 1; level <= maxLevels && frontier.length; level++) {
    const byName = new Map(frontier.map((f) => [f.mo.name, f]));
    const keyMembers = new Map<string, Node[]>();
    for (const f of frontier) {
      for (const k of new Set([batchBase(f.mo.name), groupName(f.mo)].filter((x): x is string => !!x))) {
        const list = keyMembers.get(k) ?? [];
        list.push(f);
        keyMembers.set(k, list);
      }
    }
    const origins = [...new Set([...byName.keys(), ...keyMembers.keys()])];
    const seen = new Set<number>();
    let kids: RawMo[] = [];
    for (const c of chunk(origins, 80)) kids.push(...(await searchRead(rpc, [["origin", "in", c]])));
    kids = kids.filter((k) => !nodes.has(k.id) && !seen.has(k.id) && (seen.add(k.id), true));

    // where each kid's finished pieces go: the MOs they feed
    const finished: { id: number; move_dest_ids: number[]; production_id: M2O }[] = [];
    for (const c of chunk(kids.flatMap((k) => k.move_finished_ids ?? []), 400)) {
      finished.push(...((await rpc("stock.move", "read", [c, ["move_dest_ids", "production_id"]], { context: { lang: "en_US" } })) as typeof finished));
    }
    const destMo = new Map<number, M2O>();
    for (const c of chunk([...new Set(finished.flatMap((m) => m.move_dest_ids ?? []))], 400)) {
      const ds = (await rpc("stock.move", "read", [c, ["raw_material_production_id"]], { context: { lang: "en_US" } })) as { id: number; raw_material_production_id: M2O }[];
      for (const d of ds) destMo.set(d.id, d.raw_material_production_id);
    }
    const kidDest = new Map<number, Set<string>>();
    for (const m of finished) {
      const pid = m.production_id ? m.production_id[0] : null;
      if (pid === null) continue;
      for (const d of m.move_dest_ids ?? []) {
        const to = destMo.get(d);
        if (!to) continue;
        const set = kidDest.get(pid) ?? new Set<string>();
        set.add(to[1]);
        kidDest.set(pid, set);
      }
    }

    // the whole family of each origin the kids name without naming a batch
    const siblings = new Map<string, { name: string; product_qty: number; state: string }[]>();
    for (const o of [...new Set(kids.filter((k) => k.origin && !byName.has(k.origin) && keyMembers.has(k.origin)).map((k) => k.origin as string))]) {
      const prods = [...new Set(keyMembers.get(o)!.map((m) => (m.mo.product_id ? m.mo.product_id[0] : 0)))];
      siblings.set(o, (await searchRead(rpc, [
        "&", ["product_id", "in", prods], "|", ["name", "=like", `${o}-%`], "|", ["name", "=", o], ["procurement_group_id.name", "=", o],
      ], ["name", "product_qty", "state"])) as unknown as { name: string; product_qty: number; state: string }[]);
    }

    const next: Node[] = [];
    for (const k of kids) {
      let parents: Node[] = [];
      let how = "";
      const dests = [...(kidDest.get(k.id) ?? [])];
      const inFrontier = dests.filter((n) => byName.has(n));
      const origin = k.origin || "";
      if (inFrontier.length) { parents = inFrontier.map((n) => byName.get(n)!); how = "direct"; }
      else if (dests.length) continue; // it feeds an MO outside these orders
      else if (byName.has(origin)) { parents = [byName.get(origin)!]; how = "origin"; }
      else if (keyMembers.has(origin)) {
        const all = (siblings.get(origin) ?? []).filter((s) => s.state !== "cancel");
        const cands = keyMembers.get(origin)!;
        if (cands.length === 1 && all.length <= 1) { parents = cands; how = "origin"; }
        else {
          const sum = cands.reduce((a, c) => a + c.mo.product_qty, 0);
          let qm = all.filter((s) => eq(s.product_qty, k.product_qty));
          if (qm.length > 1) { const q2 = qm.filter((s) => (s.state === "done") === (k.state === "done")); if (q2.length) qm = q2; }
          if (qm.length === 1) {
            if (!byName.has(qm[0].name)) continue;
            parents = [byName.get(qm[0].name)!]; how = "qty_match";
          } else if (cands.length > 1 && eq(sum, k.product_qty)) { parents = cands; how = "shared"; }
          else if (qm.length > 1 && qm.some((s) => byName.has(s.name))) { parents = qm.filter((s) => byName.has(s.name)).map((s) => byName.get(s.name)!); how = "unresolved"; }
          else {
            const finsCtx = cands.some((c) => c.finsOnly);
            skipped.push({
              mo: k, origin, finsCtx,
              candidates: cands.map((c) => ({ name: c.mo.name, qty: c.mo.product_qty })),
              others: all.filter((s) => !byName.has(s.name)).map((s) => ({ name: s.name, qty: s.product_qty, state: s.state })),
            });
            // a tank that could not be tied yet still has fins to find
            if (isShopFloor(k.name) && itemOfCode(codeOf(k)) === TANK && k.state !== "cancel" && !finsCtx) {
              const n: Node = { mo: k, roots: new Set(), finsOnly: true, parents: [], how: "" };
              nodes.set(k.id, n); next.push(n);
            }
            continue;
          }
        }
      } else continue;

      const finsCtx = parents.some((p) => p.finsOnly);
      const node: Node = { mo: k, roots: new Set(parents.flatMap((p) => [...p.roots])), finsOnly: false, parents: parents.map((p) => p.mo.name), how };
      nodes.set(k.id, node);
      // a component assembled on another floor (PF01/MO/… FB-024-…D11) is not
      // the MO the shop floor closes: its SF01 MO sits below it — walk through
      const item = isShopFloor(k.name) ? itemOfCode(codeOf(k)) : null;
      if (finsCtx) { if (item === FINS) out.push(node); continue; } // under a tank: its fins only, nothing deeper
      if (item && item !== FINS) {
        out.push(node);
        if (item === TANK && k.state !== "cancel") { node.finsOnly = true; next.push(node); }
      } else if (!item && k.state !== "cancel") next.push(node);
    }
    frontier = next;
  }

  // done batches split differently from their parent's: tied by their sum
  const rootsOf = (names: readonly string[]) => {
    const s = new Set<string>();
    for (const n of nodes.values()) if (names.includes(n.mo.name)) n.roots.forEach((r) => s.add(r));
    return s;
  };
  const groups = new Map<string, Skipped[]>();
  for (const s of skipped) {
    const item = isShopFloor(s.mo.name) ? itemOfCode(codeOf(s.mo)) : null;
    if (s.mo.state === "cancel" || !item || (s.finsCtx && item !== FINS) || (!s.finsCtx && item === FINS)) continue;
    const key = `${s.origin}|${batchBase(s.mo.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  let unresolved = 0;
  for (const g of groups.values()) {
    const { candidates, others } = g[0];
    const total = g.reduce((a, s) => a + s.mo.product_qty, 0);
    const single = candidates.filter((c) => eq(c.qty, total));
    const sumC = candidates.reduce((a, c) => a + c.qty, 0);
    const sumO = others.filter((o) => o.state !== "cancel").reduce((a, o) => a + o.qty, 0);
    let how: string, roots: Set<string>;
    if (single.length === 1 && rootsOf([single[0].name]).size) { how = "batch"; roots = rootsOf([single[0].name]); }
    else if (eq(total, sumC) || eq(total, sumC + sumO)) { how = "batch"; roots = rootsOf(candidates.map((c) => c.name)); }
    else { how = "unresolved"; roots = rootsOf(candidates.map((c) => c.name)); }
    for (const s of g) {
      const existing = nodes.get(s.mo.id);
      const node: Node = existing ?? { mo: s.mo, roots: new Set(), finsOnly: false, parents: [], how };
      roots.forEach((r) => node.roots.add(r));
      node.how = how;
      node.parents = [s.origin];
      nodes.set(s.mo.id, node);
      out.push(node);
    }
  }
  // fins found under a tank tied only now take that tank's orders
  for (const n of out) {
    if (itemOfCode(codeOf(n.mo)) !== FINS || n.roots.size) continue;
    for (const p of n.parents) {
      for (const t of nodes.values()) if (t.mo.name === p) t.roots.forEach((r) => n.roots.add(r));
    }
  }

  const children: FoundChild[] = [];
  const done = new Set<string>();
  for (const n of out) {
    if (n.mo.state === "cancel") continue;
    if (n.how === "unresolved") unresolved++;
    const roots = [...n.roots].sort();
    for (const order of roots) {
      const key = `${order}|${n.mo.id}`;
      if (done.has(key)) continue;
      done.add(key);
      children.push({
        orderMo: order,
        odooId: n.mo.id,
        name: n.mo.name,
        item: itemOfCode(codeOf(n.mo)) ?? "",
        productCode: codeOf(n.mo),
        qty: n.mo.product_qty,
        qtyProduced: n.mo.qty_produced ?? 0,
        uom: n.mo.product_uom_id ? n.mo.product_uom_id[1] : "",
        state: n.mo.state,
        doneAt: n.mo.state === "done" && n.mo.date_finished ? n.mo.date_finished : null,
        linkHow: n.how,
        sharedWith: roots.filter((r) => r !== order),
      });
    }
  }
  return { children, planMap, notFound, unresolved };
}

/** Odoo's "YYYY-MM-DD HH:MM:SS" (UTC, no zone) → a Date; null when empty. */
export function odooDateTime(v: string | false | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}
