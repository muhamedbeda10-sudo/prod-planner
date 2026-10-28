import { describe, expect, it } from "vitest";
import { bomSig, pullBoms, toStockQty } from "./odooBomPull";
import { pullOdoo, splitPayload, type OdooPullPayload } from "./odooPull";
import { expandBom, rawMaterials, type BomIndex } from "./odooBom";
import type { OdooRpc } from "./odooChildren";

// The BoM part of the Odoo pull, against a small Odoo in memory: the reads it
// makes are answered as Odoo would, and anything else (a write) throws.

type M2O = [number, string] | false;
interface FakeBom { id: number; code: string | false; tmpl: number; pid?: number; qty?: number; uom?: number; type?: string; seq?: number; write?: string }
interface FakeLine { id: number; bom: number; pid: number; qty: number; uom?: number; seq?: number }
interface FakeProduct { id: number; tmpl: number; code: string; name?: string; uom?: number }

const UOM: Record<number, { name: string; factor: number; cat: number }> = {
  1: { name: "PC", factor: 1, cat: 1 },
  2: { name: "KG", factor: 1, cat: 2 },
  3: { name: "Dozens", factor: 1 / 12, cat: 1 },
  4: { name: "g", factor: 1000, cat: 2 },
};

function fakeOdoo(boms: FakeBom[], lines: FakeLine[], products: FakeProduct[], mos: { name: string; bom: number | false }[] = []) {
  const calls: string[] = [];
  const m2o = (id: number | undefined, name: string): M2O => (id ? [id, name] : false);
  const prod = (id: number) => products.find((p) => p.id === id)!;
  const tmplCode = (t: number) => products.find((p) => p.tmpl === t)?.code ?? `T${t}`;
  const bomRec = (b: FakeBom) => ({
    id: b.id, code: b.code, product_tmpl_id: m2o(b.tmpl, `[${tmplCode(b.tmpl)}] x`), product_id: b.pid ? m2o(b.pid, "v") : false,
    product_qty: b.qty ?? 1, product_uom_id: m2o(b.uom ?? 1, UOM[b.uom ?? 1].name), write_date: b.write ?? "2026-10-01 00:00:00", sequence: b.seq ?? 0, type: b.type ?? "normal",
  });
  const lineRec = (l: FakeLine) => {
    const p = prod(l.pid);
    return { id: l.id, bom_id: [l.bom, "b"], product_id: [p.id, `[${p.code}] ${p.name ?? p.code}`], product_tmpl_id: [p.tmpl, "t"], product_qty: l.qty, product_uom_id: [l.uom ?? 1, UOM[l.uom ?? 1].name], sequence: l.seq ?? 0 };
  };
  const leaf = (d: unknown[]) => d as [string, string, unknown][];
  const rpc: OdooRpc = async (model, method, args) => {
    calls.push(`${model}.${method}`);
    if (method !== "search_read" && method !== "read") throw new Error(`write ${model}.${method}`);
    const dom = method === "search_read" ? leaf(args[0] as unknown[]) : [];
    const ids = method === "read" ? (args[0] as number[]) : [];
    const has = (f: string, v: unknown) => dom.some(([k, op, x]) => k === f && op === "in" && (x as unknown[]).includes(v));
    if (model === "mrp.bom" && method === "search_read") {
      const byCode = dom.find(([k]) => k === "code");
      const list = boms.filter((b) => (byCode ? b.code && has("code", b.code) : has("product_tmpl_id", b.tmpl))).filter((b) => !dom.some(([k]) => k === "type") || ["normal", "phantom"].includes(b.type ?? "normal"));
      return list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id).map(bomRec);
    }
    if (model === "mrp.bom" && method === "read") return boms.filter((b) => ids.includes(b.id)).map(bomRec);
    if (model === "mrp.bom.line") return lines.filter((l) => has("bom_id", l.bom)).map(lineRec);
    if (model === "product.product") return products.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, default_code: p.code, name: p.name ?? p.code, uom_id: [p.uom ?? 1, UOM[p.uom ?? 1].name] }));
    if (model === "product.template" && method === "read") return [...new Set(products.map((p) => p.tmpl))].filter((t) => ids.includes(t)).map((t) => ({ id: t, default_code: tmplCode(t), name: `${tmplCode(t)} name` }));
    if (model === "product.template") return [...new Set(products.map((p) => p.tmpl))].filter((t) => has("default_code", tmplCode(t))).map((t) => ({ id: t, default_code: tmplCode(t) }));
    if (model === "uom.uom") return ids.map((id) => ({ id, factor: UOM[id].factor, category_id: [UOM[id].cat, "c"], name: UOM[id].name }));
    if (model === "mrp.production") return mos.filter((m) => m.bom && has("name", m.name)).map((m) => ({ name: m.name, bom_id: [m.bom, "b"] }));
    throw new Error(`unexpected ${model}.${method}`);
  };
  return { rpc, calls };
}

// a transformer (FG-64022E11M11) → final assembly → tank → fins; a cable box with a variant BoM;
// an LV panel found by its product; a code whose BoM is reached through its MO only
const products: FakeProduct[] = [
  { id: 1, tmpl: 101, code: "FG-64022" }, { id: 2, tmpl: 102, code: "FA-64022E11M11" }, { id: 3, tmpl: 103, code: "FB-022-64022E11M11" },
  { id: 4, tmpl: 104, code: "FB-036-64022E11M11" }, { id: 5, tmpl: 105, code: "C-SHR-004" }, { id: 6, tmpl: 106, code: "T-CRC-1.5X1100", uom: 2 },
  { id: 7, tmpl: 107, code: "FB-024-00009D12" }, { id: 8, tmpl: 107, code: "FB-024-00009D12-B" }, { id: 9, tmpl: 109, code: "C-CON-NUT", name: "Hex Nut" },
  { id: 10, tmpl: 110, code: "FG-RPR-DMB" }, { id: 11, tmpl: 111, code: "TX-14003" },
];
const boms: FakeBom[] = [
  { id: 1, code: "FG-64022E11M11", tmpl: 101 }, { id: 2, code: "FA-64022E11M11", tmpl: 102 },
  { id: 3, code: "FB-022-64022E11M11", tmpl: 103, qty: 2 }, { id: 4, code: false, tmpl: 104 },
  { id: 5, code: "CB-GENERIC", tmpl: 107, seq: 5 }, { id: 6, code: "CB-VARIANT-B", tmpl: 107, pid: 8, seq: 1 },
  { id: 7, code: "PANEL", tmpl: 110 }, { id: 8, code: "TX-T15S2-E1-2(Copy)", tmpl: 111 },
];
const lines: FakeLine[] = [
  { id: 1, bom: 1, pid: 2, qty: 1, seq: 2 }, { id: 2, bom: 1, pid: 9, qty: 2, uom: 3, seq: 1 }, { id: 3, bom: 1, pid: 8, qty: 1, seq: 3 },
  { id: 4, bom: 2, pid: 3, qty: 1 },
  { id: 5, bom: 3, pid: 5, qty: 4.46 }, { id: 6, bom: 3, pid: 4, qty: 2 },
  { id: 7, bom: 4, pid: 6, qty: 377530, uom: 4 },
  { id: 8, bom: 6, pid: 5, qty: 0.68 }, { id: 9, bom: 5, pid: 5, qty: 99 },
  { id: 10, bom: 7, pid: 5, qty: 1.5 }, { id: 11, bom: 8, pid: 9, qty: 1 },
];
const wanted = [
  { bom: "64022e11m11", mos: ["PF01/MO/1"] },
  { bom: "FG-RPR-DMB", mos: ["SF01/MO/9"] },
  { bom: "T15S2-E1-2", mos: ["PF01/MO/31992"] },
  { bom: "99999E11M11", mos: ["PF01/MO/7"] },
];
const mos = [{ name: "PF01/MO/31992", bom: 8 }];

/** The pull's rows as the BoM index the screens read. */
const asIndex = (rows: Awaited<ReturnType<typeof pullBoms>>["boms"]): BomIndex => new Map(rows.map((b) => [b[0], {
  odooId: b[0], code: b[1], productCode: b[2], productName: b[3], qty: b[4], uom: b[5],
  lines: b[7].map((l) => ({ seq: l[0], productCode: l[1], productName: l[2], qty: l[3], uom: l[4], stockQty: l[5], stockUom: l[6], childOdooId: l[7] })),
}]));

describe("the BoM pull", () => {
  it("finds each code by its reference, its product or its MO, and names the ones Odoo lacks", async () => {
    const { rpc } = fakeOdoo(boms, lines, products, mos);
    const r = await pullBoms(rpc, wanted, {});
    expect(r.roots).toEqual([
      ["64022E11M11", 1, "code"],
      ["FG-RPR-DMB", 7, "product"],
      ["T15S2-E1-2", 8, "mo"],
      ["99999E11M11", null, "missing"],
    ]);
    expect(r.reached).toBe(7); // 1, 2, 3, 4, 6, 7, 8 — the generic cable box BoM is not the variant's
  });

  it("walks every level, Odoo's own choice of a component's BoM, quantities in the stock unit", async () => {
    const { rpc } = fakeOdoo(boms, lines, products, mos);
    const r = await pullBoms(rpc, wanted.slice(0, 1), {});
    const idx = asIndex(r.boms);
    const fg = idx.get(1)!;
    expect(fg.lines.map((l) => [l.seq, l.productCode, l.childOdooId])).toEqual([[1, "C-CON-NUT", null], [2, "FA-64022E11M11", 2], [3, "FB-024-00009D12-B", 6]]);
    expect(fg.lines[0]).toMatchObject({ qty: 2, uom: "Dozens", stockQty: 24, stockUom: "PC" });
    expect(idx.get(4)!.lines[0]).toMatchObject({ qty: 377530, uom: "g", stockQty: 377.53, stockUom: "KG" });
    expect(idx.get(4)!.code).toBe("FB-036-64022E11M11"); // no reference: the product's code
    // what the screens make of it: per transformer, the tank's sheets (its BoM is for 2)
    const raw = rawMaterials(1, idx).lines;
    expect(raw.get("C-SHR-004")!.qty).toBe(2.91); // 4.46 / 2 + 0.68 of the cable box
    expect(raw.get("T-CRC-1.5X1100")!.qty).toBe(377.53);
    expect(expandBom(1, idx).length).toBe(3);
  });

  it("sends only the BoMs that changed, every root always", async () => {
    const { rpc } = fakeOdoo(boms, lines, products, mos);
    const first = await pullBoms(rpc, wanted, {});
    const sigs = Object.fromEntries(first.boms.map((b) => [String(b[0]), b[6]]));
    const again = await pullBoms(rpc, wanted, sigs);
    expect(again.boms).toEqual([]);
    expect(again.roots).toEqual(first.roots);
    const edited = lines.map((l) => (l.id === 5 ? { ...l, qty: 5 } : l));
    const changed = await pullBoms(fakeOdoo(boms, edited, products, mos).rpc, wanted, sigs);
    expect(changed.boms.map((b) => b[0])).toEqual([3]);
  });

  it("only ever reads", async () => {
    const { rpc, calls } = fakeOdoo(boms, lines, products, mos);
    await pullBoms(rpc, wanted, {});
    expect(calls.every((c) => c.endsWith(".search_read") || c.endsWith(".read"))).toBe(true);
  });

  it("survives a BoM that names itself", async () => {
    const loop = [...lines, { id: 99, bom: 4, pid: 4, qty: 1 }];
    const r = await pullBoms(fakeOdoo(boms, loop, products, mos).rpc, wanted.slice(0, 1), {});
    expect(asIndex(r.boms).get(4)!.lines.find((l) => l.productCode === "FB-036-64022E11M11")!.childOdooId).toBeNull();
  });

  it("converts only within a unit's category", () => {
    expect(toStockQty(2, { factor: 1 / 12, cat: 1 }, { factor: 1, cat: 1 })).toBe(24);
    expect(toStockQty(2, { factor: 1, cat: 1 }, { factor: 1, cat: 2 })).toBe(2);
    expect(toStockQty(2, undefined, { factor: 1, cat: 1 })).toBe(2);
    expect(bomSig("2026-10-01", [1, "a"])).toMatch(/^2026-10-01\|[0-9a-f]+$/);
    expect(bomSig(false, [1, "a"])).not.toBe(bomSig(false, [1, "b"]));
  });
});

describe("the BoMs in the whole pull", () => {
  it("rides with the rest of the pull, and a failure is an issue, not a stop", async () => {
    const { rpc } = fakeOdoo(boms, lines, products, mos);
    const plan = { logNames: [], tr: [], lv: [], codes: [], hashes: {}, boms: wanted.slice(0, 1), bomSigs: {} };
    const silent: typeof rpc = async (model, method, args, kw) => {
      if (model === "stock.location") return [{ id: 1 }];
      if (model === "product.product" && method === "search_read") return [];
      if (model === "stock.quant") return [];
      if (model === "mrp.production" && method === "search_read") return [];
      return rpc(model, method, args, kw);
    };
    const p = await pullOdoo(silent, plan);
    expect(p.bomRoots).toEqual([["64022E11M11", 1, "code"]]);
    expect(p.boms!.length).toBe(5);
    const broken: typeof rpc = async (model, method, args, kw) => (model === "mrp.bom.line" ? Promise.reject(new Error("Access Denied")) : silent(model, method, args, kw));
    const q = await pullOdoo(broken, plan);
    expect(q.bomRoots).toBeNull();
    expect(q.issues).toEqual(["BoMs: Access Denied"]);
    // a plan from before BoMs reads none
    expect((await pullOdoo(silent, { ...plan, boms: undefined })).bomRoots).toBeNull();
  });

  it("splits the BoMs across pieces, each whole, the roots on the first", async () => {
    const { rpc } = fakeOdoo(boms, lines, products, mos);
    const b = await pullBoms(rpc, wanted, {});
    const p: OdooPullPayload = { v: 1, at: "2026-10-28T06:00:00.000Z", ms: 1, log: [], orders: [], children: [], unchanged: 0, stock: null, issues: [], bomRoots: b.roots, boms: b.boms };
    const parts = splitPayload(p, 700);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((x) => x.boms ?? [])).toEqual(b.boms);
    expect(parts[0].bomRoots).toEqual(b.roots);
    expect(parts.slice(1).every((x) => x.bomRoots === null)).toBe(true);
  });
});
