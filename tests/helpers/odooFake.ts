// A small Odoo in memory for the pull's tests: the MOs, moves, products and
// stock given, and just enough of Odoo's domain language (prefix &, |,
// implicit and; =, in, =like; one dotted path) to answer the reads exactly as
// Odoo would. It answers reads only — a write method throws.
import type { OdooRpc, RawMo } from "../../lib/domain/odooChildren";

type Leaf = [string, string, unknown];
const valueOf = (rec: Record<string, unknown>, field: string): unknown => {
  if (field === "procurement_group_id.name") { const g = rec.procurement_group_id as [number, string] | false; return g ? g[1] : false; }
  const v = rec[field];
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string" ? v[0] : v;
};
const like = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()[\]\\/]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`);
const leafOk = (rec: Record<string, unknown>, [f, op, v]: Leaf) => {
  const x = valueOf(rec, f);
  if (op === "=") return x === v;
  if (op === "in") return (v as unknown[]).includes(x);
  if (op === "=like") return typeof x === "string" && like(String(v)).test(x);
  throw new Error(`op ${op}`);
};
function evalDomain(rec: Record<string, unknown>, domain: unknown[]): boolean {
  let i = 0;
  const term = (): boolean => {
    const t = domain[i++];
    if (t === "&") { const a = term(); const b = term(); return a && b; }
    if (t === "|") { const a = term(); const b = term(); return a || b; }
    return leafOk(rec, t as Leaf);
  };
  let ok = true;
  while (i < domain.length) ok = term() && ok;
  return ok;
}

export const mo = (id: number, name: string, code: string, o: Partial<RawMo> = {}): RawMo => ({
  id, name, origin: false, product_id: [id * 10, `[${code}] ${code}`], product_qty: 1, qty_produced: 0, product_uom_id: [1, "Units"], state: "confirmed",
  move_finished_ids: [], procurement_group_id: [id, name], date_finished: false, ...o,
});

export interface FakeStock {
  locations?: { id: number; complete_name: string }[];
  products?: { id: number; default_code: string }[];
  quants?: { location: number; product: number; quantity: number }[];
}

export function fakeOdoo(
  mos: RawMo[],
  moves: Record<number, { move_dest_ids?: number[]; production_id?: [number, string] | false; raw_material_production_id?: [number, string] | false }> = {},
  stock: FakeStock = {},
): { rpc: OdooRpc; calls: string[] } {
  const calls: string[] = [];
  const rpc: OdooRpc = async (model, method, args) => {
    calls.push(`${model}.${method}`);
    const domain = args[0] as unknown[];
    if (model === "mrp.production" && method === "search_read") return mos.filter((m) => evalDomain(m as unknown as Record<string, unknown>, domain));
    if (model === "stock.move" && method === "read") return (args[0] as number[]).map((id) => ({ id, move_dest_ids: [], production_id: false, raw_material_production_id: false, ...moves[id] }));
    if (model === "stock.location" && method === "search_read") return (stock.locations ?? []).filter((l) => evalDomain(l, domain));
    if (model === "product.product" && method === "search_read") return (stock.products ?? []).filter((p) => evalDomain(p, domain));
    if (model === "stock.quant" && method === "read_group") {
      const [[, , loc], [, , ids]] = domain as [Leaf, Leaf];
      const sum = new Map<number, number>();
      for (const q of stock.quants ?? []) if (q.location === loc && (ids as number[]).includes(q.product)) sum.set(q.product, (sum.get(q.product) ?? 0) + q.quantity);
      return [...sum.entries()].map(([id, quantity]) => ({ product_id: [id, `p${id}`], quantity }));
    }
    throw new Error(`unexpected ${model}.${method}`);
  };
  return { rpc, calls };
}

