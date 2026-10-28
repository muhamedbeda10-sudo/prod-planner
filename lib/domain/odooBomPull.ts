import type { OdooRpc } from "./odooChildren";
import { normBom, rootCodeCandidates, type RootVia } from "./odooBom";

// The BoM part of the Odoo pull (lib/domain/odooPull.ts): run INSIDE an Odoo
// page with the user's own login, reads only. From the open orders' BOM codes
// it finds each code's BoM — Odoo's reference FG-<code> / TX-<code> / the code
// itself, else the product with that code, else the BoM of one of the code's
// MOs — and walks every sub-BoM below it, level by level. Only the BoMs whose
// fingerprint differs from what the database holds are sent; every code's
// root always is. odoo_ingest writes them into OdooBom / OdooBomLine /
// OdooBomRoot.

/** [seq, productCode, productName, qty, uom, stockQty, stockUom, childOdooId] */
export type BomLineRow = [number, string, string, number, string, number, string, number | null];
/** [odooId, code, productCode, productName, qty, uom, sig, lines] */
export type BomRow = [number, string, string, string, number, string, string, BomLineRow[]];
/** [bom, odooId, via] — odooId null with via "missing" when Odoo has no BoM for the code. */
export type BomRootRow = [string, number | null, RootVia];

export interface BomPull {
  roots: BomRootRow[];
  /** The BoMs that changed (or are new) since the database's fingerprints. */
  boms: BomRow[];
  /** Every BoM the walk reached, changed or not. */
  reached: number;
}

/** The deepest a walk goes — Odoo's trees are five or six levels. */
export const BOM_WALK_DEPTH = 12;

type M2O = [number, string] | false;
const chunk = <T,>(a: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const codeOf = (p: M2O) => { const m = /^\[([^\]]+)\]/.exec(p ? p[1] : ""); return m ? m[1] : ""; };
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** A short, stable fingerprint of a BoM as the pull reads it (FNV-1a, hex),
 *  with Odoo's last change of it in front. */
export function bomSig(writeDate: string | false | null | undefined, row: readonly unknown[]): string {
  const text = JSON.stringify(row);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${writeDate || ""}|${h.toString(16)}`;
}

/** A line's quantity in its product's stock unit: Odoo's factor is units of
 *  the reference unit per unit, so qty / lineFactor × stockFactor — only
 *  within one category; otherwise the line's own figure stands. */
export function toStockQty(qty: number, line: { factor: number; cat: number } | undefined, stock: { factor: number; cat: number } | undefined): number {
  if (!line || !stock || line.cat !== stock.cat || !(line.factor > 0)) return qty;
  return r6((qty / line.factor) * stock.factor);
}

const ctx = { context: { lang: "en_US" } };
const all = { context: { lang: "en_US", active_test: false } };

/** Find each wanted code's BoM and read every BoM below them. */
export async function pullBoms(rpc: OdooRpc, wanted: readonly { bom: string; mos: readonly string[] }[], sigs: Readonly<Record<string, string>>): Promise<BomPull> {
  const codes = [...new Map(wanted.map((w) => [normBom(w.bom), { bom: normBom(w.bom), mos: w.mos }])).values()].filter((w) => w.bom);
  const found = new Map<string, { odooId: number; via: RootVia }>();

  // 1. each code's root: its reference …
  const byRef = new Map<string, number>();
  for (const c of chunk([...new Set(codes.flatMap((w) => rootCodeCandidates(w.bom)))], 300)) {
    const rows = (await rpc("mrp.bom", "search_read", [[["code", "in", c]]], { fields: ["id", "code"], order: "sequence, id", ...ctx })) as { id: number; code: string | false }[];
    for (const b of rows) if (b.code && !byRef.has(b.code.toUpperCase())) byRef.set(b.code.toUpperCase(), b.id);
  }
  for (const w of codes) { const hit = rootCodeCandidates(w.bom).find((c) => byRef.has(c)); if (hit) found.set(w.bom, { odooId: byRef.get(hit)!, via: "code" }); }
  // … else the product with that code …
  let left = codes.filter((w) => !found.has(w.bom));
  if (left.length) {
    const tm = (await rpc("product.template", "search_read", [[["default_code", "in", left.map((w) => w.bom)]]], { fields: ["id", "default_code"], ...all })) as { id: number; default_code: string | false }[];
    if (tm.length) {
      const first = new Map<number, number>();
      const bs = (await rpc("mrp.bom", "search_read", [[["product_tmpl_id", "in", tm.map((t) => t.id)]]], { fields: ["id", "product_tmpl_id"], order: "sequence, id", ...ctx })) as { id: number; product_tmpl_id: M2O }[];
      for (const b of bs) if (b.product_tmpl_id && !first.has(b.product_tmpl_id[0])) first.set(b.product_tmpl_id[0], b.id);
      for (const t of tm) { const k = normBom(t.default_code || ""); const id = first.get(t.id); if (k && id !== undefined && !found.has(k)) found.set(k, { odooId: id, via: "product" }); }
    }
    left = codes.filter((w) => !found.has(w.bom));
  }
  // … else the BoM one of its MOs is built with
  if (left.length) {
    const bomOfMo = new Map<string, number>();
    for (const c of chunk(left.flatMap((w) => w.mos), 300)) {
      const ps = (await rpc("mrp.production", "search_read", [[["name", "in", c], ["bom_id", "!=", false]]], { fields: ["name", "bom_id"], ...all })) as { name: string; bom_id: M2O }[];
      for (const p of ps) if (p.bom_id) bomOfMo.set(p.name, p.bom_id[0]);
    }
    for (const w of left) { const mo = w.mos.find((m) => bomOfMo.has(m)); if (mo) found.set(w.bom, { odooId: bomOfMo.get(mo)!, via: "mo" }); }
  }

  // 2. every BoM below them, level by level
  const rows = new Map<number, BomRow>();
  const prod = new Map<number, { code: string; name: string; uom: M2O }>();
  const uom = new Map<number, { factor: number; cat: number; name: string }>();
  const tmplBoms = new Map<number, { id: number; pid: number | null }[]>();
  let frontier = [...new Set([...found.values()].map((r) => r.odooId))];
  for (let d = 0; d < BOM_WALK_DEPTH && frontier.length; d++) {
    const heads: { id: number; code: string | false; product_tmpl_id: M2O; product_qty: number; product_uom_id: M2O; write_date: string | false }[] = [];
    const lines: { id: number; bom_id: M2O; product_id: M2O; product_tmpl_id: M2O; product_qty: number; product_uom_id: M2O; sequence: number }[] = [];
    for (const c of chunk(frontier, 200)) {
      heads.push(...((await rpc("mrp.bom", "read", [c, ["code", "product_tmpl_id", "product_qty", "product_uom_id", "write_date"]], ctx)) as typeof heads));
      lines.push(...((await rpc("mrp.bom.line", "search_read", [[["bom_id", "in", c]]], { fields: ["bom_id", "product_id", "product_tmpl_id", "product_qty", "product_uom_id", "sequence"], ...ctx })) as typeof lines));
    }
    const pids = [...new Set(lines.flatMap((l) => (l.product_id ? [l.product_id[0]] : [])))].filter((id) => !prod.has(id));
    for (const c of chunk(pids, 300)) {
      for (const p of (await rpc("product.product", "read", [c, ["default_code", "name", "uom_id"]], all)) as { id: number; default_code: string | false; name: string | false; uom_id: M2O }[]) {
        prod.set(p.id, { code: p.default_code || "", name: p.name || "", uom: p.uom_id });
      }
    }
    const tinfo = new Map<number, { default_code: string | false; name: string | false }>();
    for (const c of chunk([...new Set(heads.flatMap((h) => (h.product_tmpl_id ? [h.product_tmpl_id[0]] : [])))], 300)) {
      for (const t of (await rpc("product.template", "read", [c, ["default_code", "name"]], all)) as { id: number; default_code: string | false; name: string | false }[]) tinfo.set(t.id, t);
    }
    const uids = [...new Set([...lines.flatMap((l) => (l.product_uom_id ? [l.product_uom_id[0]] : [])), ...[...prod.values()].flatMap((p) => (p.uom ? [p.uom[0]] : []))])].filter((id) => !uom.has(id));
    for (const c of chunk(uids, 300)) {
      for (const u of (await rpc("uom.uom", "read", [c, ["factor", "category_id", "name"]], all)) as { id: number; factor: number; category_id: M2O; name: string }[]) {
        uom.set(u.id, { factor: u.factor, cat: u.category_id ? u.category_id[0] : 0, name: u.name });
      }
    }
    const tids = [...new Set(lines.flatMap((l) => (l.product_tmpl_id ? [l.product_tmpl_id[0]] : [])))].filter((t) => !tmplBoms.has(t));
    for (const c of chunk(tids, 300)) {
      for (const t of c) tmplBoms.set(t, []);
      const bs = (await rpc("mrp.bom", "search_read", [[["product_tmpl_id", "in", c], ["type", "in", ["normal", "phantom"]]]], { fields: ["id", "product_tmpl_id", "product_id"], order: "sequence, id", ...ctx })) as { id: number; product_tmpl_id: M2O; product_id: M2O }[];
      for (const b of bs) if (b.product_tmpl_id) tmplBoms.get(b.product_tmpl_id[0])?.push({ id: b.id, pid: b.product_id ? b.product_id[0] : null });
    }
    // Odoo's own choice of a component's BoM: the variant's, else the template's first
    const subOf = (l: (typeof lines)[number]) => {
      const list = (l.product_tmpl_id && tmplBoms.get(l.product_tmpl_id[0])) || [];
      const v = list.find((b) => l.product_id && b.pid === l.product_id[0]) ?? list.find((b) => b.pid === null);
      return v ? v.id : null;
    };
    const byBom = new Map<number, typeof lines>();
    for (const l of lines) if (l.bom_id) { const k = l.bom_id[0]; const list = byBom.get(k); if (list) list.push(l); else byBom.set(k, [l]); }
    const next: number[] = [];
    for (const h of heads) {
      const t = (h.product_tmpl_id && tinfo.get(h.product_tmpl_id[0])) || { default_code: false, name: false };
      const ls: BomLineRow[] = (byBom.get(h.id) ?? []).sort((a, b) => a.sequence - b.sequence || a.id - b.id).map((l, i) => {
        const p = (l.product_id && prod.get(l.product_id[0])) || { code: "", name: "", uom: l.product_uom_id };
        const lu = l.product_uom_id ? uom.get(l.product_uom_id[0]) : undefined;
        const pu = p.uom ? uom.get(p.uom[0]) : undefined;
        const child = subOf(l);
        const sub = child !== null && child !== h.id ? child : null;
        if (sub !== null && !rows.has(sub)) next.push(sub);
        return [i + 1, p.code || codeOf(l.product_id) || `#${l.product_id ? l.product_id[0] : 0}`, p.name, l.product_qty, lu ? lu.name : (l.product_uom_id ? l.product_uom_id[1] : ""), toStockQty(l.product_qty, lu, pu), pu ? pu.name : "", sub];
      });
      const base = [h.id, h.code || t.default_code || `BOM-${h.id}`, t.default_code || codeOf(h.product_tmpl_id), t.name || "", h.product_qty > 0 ? h.product_qty : 1, h.product_uom_id ? h.product_uom_id[1] : "", ls] as const;
      const sig = bomSig(h.write_date, base);
      rows.set(h.id, [base[0], base[1], base[2], base[3], base[4], base[5], sig, ls]);
    }
    frontier = [...new Set(next)].filter((id) => !rows.has(id));
  }

  const roots: BomRootRow[] = codes.map((w) => {
    const r = found.get(w.bom);
    return r && rows.has(r.odooId) ? [w.bom, r.odooId, r.via] : [w.bom, null, "missing"];
  });
  const boms = [...rows.values()].filter((b) => sigs[String(b[0])] !== b[6]);
  return { roots, boms, reached: rows.size };
}
