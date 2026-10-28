import "server-only";
import { prisma } from "@/lib/db";
import { getBomList, getBomTree, getMaterialNeed, lastBomSync } from "@/lib/server/odooBom";
import { flattenNodes, itemCheckOk, stockAfterPlan } from "@/lib/domain/odooBom";
import { hrefWithLine } from "@/lib/domain/lines";
import type { ReadTool } from "./types";

// Odoo's BoMs for the assistant (Material → BoMs): one code's tree, its raw
// materials and its orders' components against it — or every open code at a
// glance — and what the open plan still needs of each material against SF01.
// The same loaders as the screens, so the two cannot disagree. The mirror's
// own tables (OdooBom, OdooBomLine, OdooBomRoot) can also be read by SQL:
// they are not one screen's (the BoMs, the Material sheet, Physical Material
// and the Orders Registry all show them), so no tab closes them.

interface BomInput { bom?: string; search?: string; maxNodes?: number }

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export const getBomTool: ReadTool<BomInput> = {
  kind: "read",
  name: "get_bom",
  title: "Reading Odoo's BoMs",
  description:
    "Odoo's bills of materials as last read from Odoo (Material → BoMs; the scheduled Odoo sync is off, so `syncedAt` says how old they are). With `bom` (an order's BOM code, e.g. 64022E11M11, or an LV panel code): its Odoo reference, the tree level by level (each line's qty for one unit of its parent and perRoot for ONE finished unit, in the product's stock unit; childCode = the sub-BoM it is built with), the raw materials one unit takes summed through every sub-BoM, the components it carries (CF TC TN CB AR MB) and each open order's required components against it (notInBom = the order needs it, the BoM has none; notRequired = the BoM builds it, the order does not count it). " +
    "Without `bom`: every open order's code — whether Odoo has its BoM, its components and how many of its orders disagree. `search` narrows the tree's lines to a code or name. Odoo is never changed by this; the mirror is as fresh as its last sync (syncedAt).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      bom: { type: "string", minLength: 1, maxLength: 80, description: "An order's BOM code. Leave out for the list of all open codes." },
      search: { type: "string", minLength: 1, maxLength: 80, description: "Only the tree lines whose code or name holds this (with bom)." },
      maxNodes: { type: "integer", minimum: 10, maximum: 400, description: "Tree lines to return (default 150)." },
    },
  },
  tabs: ["bom"],
  cacheable: true,
  status: (i) => (i?.bom ? `Reading the BoM of ${i.bom}` : "Reading the open orders' BoMs"),
  async run(i, ctx) {
    const sync = await lastBomSync();
    if (!i.bom) {
      const rows = await getBomList();
      return {
        ok: true,
        text: JSON.stringify({
          syncedAt: sync?.atISO ?? null,
          codes: rows.map((r) => ({ bom: r.bom, line: r.line, orders: r.orders, units: r.units, odooBom: r.root?.code ?? (r.looked ? "NOT IN ODOO" : "not read from Odoo"), product: r.root?.productName ?? null, components: r.items, ordersDiffering: r.mismatched, levels: r.stats?.depth ?? null, lines: r.stats?.nodes ?? null })),
        }),
        links: [{ label: "BoMs", href: "/bom" }],
      };
    }
    const t = await getBomTree(i.bom, ctx.line ?? "TR");
    if (!t.root) {
      return { ok: true, text: JSON.stringify({ bom: t.bom, syncedAt: sync?.atISO ?? null, found: false, note: t.looked ? "Odoo was searched and has no BoM for this code (its reference FG-/TX-/the code, the product of this code, its orders' MOs)." : "Odoo was never read for this code (it was added after the last Odoo read, and the scheduled sync is off)." }), links: [{ label: `BoM ${t.bom}`, href: hrefWithLine(`/bom?bom=${encodeURIComponent(t.bom)}`, t.line) }] };
    }
    const needle = i.search?.trim().toLowerCase();
    const all = flattenNodes(t.nodes).filter((n) => !needle || `${n.productCode} ${n.productName}`.toLowerCase().includes(needle));
    const max = i.maxNodes ?? 150;
    return {
      ok: true,
      text: JSON.stringify({
        bom: t.bom, line: t.line, odooBom: t.root.code, product: t.root.productName, foundVia: t.root.via, syncedAt: t.root.syncedAtISO,
        stats: t.stats,
        components: t.items,
        orders: t.orders.map((o) => ({ mo: o.mo, units: o.planQty, held: o.held, required: o.required, agrees: o.check ? itemCheckOk(o.check) : null, ...(o.check && !itemCheckOk(o.check) ? o.check : {}) })),
        tree: all.slice(0, max).map((n) => ({ key: n.key, level: n.level, code: n.productCode, name: n.productName, qty: r4(n.qty), uom: n.uom, perRoot: r4(n.perRoot), stockUom: n.stockUom, ...(n.childCode ? { childCode: n.childCode } : {}), ...(n.childMissing ? { childNotSynced: true } : {}), ...(n.item ? { component: n.item } : {}) })),
        treeLinesTotal: all.length,
        ...(all.length > max ? { note: `${all.length - max} more lines — narrow with search or raise maxNodes.` } : {}),
        rawMaterialsPerUnit: t.raw.map((r) => ({ code: r.productCode, name: r.productName, qty: r4(r.qty), uom: r.uom })),
        notSyncedSubBoms: t.incomplete,
      }),
      links: [{ label: `BoM ${t.bom}`, href: hrefWithLine(`/bom?bom=${encodeURIComponent(t.bom)}`, t.line) }],
    };
  },
};

interface NeedInput { codes?: string[]; top?: number }

export const getMaterialNeedTool: ReadTool<NeedInput> = {
  kind: "read",
  name: "get_material_need",
  title: "Reading the plan's material need",
  description:
    "What the open plan still needs of each raw material, by Odoo's BoMs (the Plan need column on Material → Physical Material). Unlike get_material_coverage, which reads the MATERIAL tab's nesting (sheets per piece), this reads Odoo's BoMs and covers every raw material, sections and hardware included: transformers — each required component's units still to cut (plan − cut − outsourced) × what one takes (its own sub-tree); LV panels — the panels still to punch × the whole BoM. Orders on hold are left out. " +
    "Each material comes with its unit, the orders behind it and, where the store tracks the code, SF01's stock in Odoo and what is left after the plan (negative = short). `gaps` names the orders or components that could not be counted (no BoM in Odoo, a component the BoM lacks, a sub-BoM not synced) — never present the totals as complete when there are gaps. `codes` narrows to some materials.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      codes: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 }, description: "Material codes (e.g. C-SHR-005)." },
      top: { type: "integer", minimum: 5, maximum: 300, description: "How many materials to return, the biggest shortages first (default 60)." },
    },
  },
  tabs: ["physical"],
  cacheable: true,
  status: () => "Working out the plan's material need",
  async run(i) {
    const [need, sync] = await Promise.all([getMaterialNeed(), lastBomSync()]);
    const stock = await prisma.physicalStock.findMany({ select: { code: true, name: true, uom: true, odoo: true } });
    const byCode = new Map(stock.map((s) => [s.code.trim().toUpperCase(), s]));
    const want = i.codes?.map((c) => c.trim().toUpperCase());
    const rows = Object.entries(need.byCode)
      .filter(([code]) => !want || want.includes(code))
      .map(([code, n]) => {
        const s = byCode.get(code);
        const a = s ? stockAfterPlan(s, n) : null;
        return { code, name: s?.name ?? null, need: r4(n.qty), uom: n.uom, sf01: s ? s.odoo : null, afterPlan: a?.after ?? null, orders: n.orders.slice(0, 8).map((o) => ({ mo: o.mo, qty: r4(o.qty) })), moreOrders: Math.max(0, n.orders.length - 8) };
      })
      .sort((a, b) => (a.afterPlan ?? Infinity) - (b.afterPlan ?? Infinity) || b.need - a.need);
    return {
      ok: true,
      text: JSON.stringify({
        syncedAt: sync?.atISO ?? null,
        coverage: { ordersWithWorkLeft: need.orders, countedInFull: need.counted, onHoldLeftOut: need.held, gaps: need.gaps.slice(0, 40), gapsTotal: need.gaps.length },
        materials: rows.slice(0, i.top ?? 60),
        materialsTotal: rows.length,
      }),
      links: [{ label: "Physical Material", href: "/physical" }],
    };
  },
};

export const BOM_TOOLS = [getBomTool, getMaterialNeedTool] as const;
