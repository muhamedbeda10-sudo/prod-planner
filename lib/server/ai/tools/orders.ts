import "server-only";
import type { MasterOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { orderDeletePreview } from "@/lib/server/orderDelete";
import { restoreOrderMonths } from "@/lib/server/rowSnapshots";
import { deleteOrders, removeOrderMonth, setGroupFins, updateOrder } from "@/app/orders/actions";
import { finsGroup, spreadOverGroup } from "@/lib/domain/groupSpread";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import { formOf, type ToolCtx, type WriteTool } from "./types";
import { ORDER_TEXT_FIELDS as TEXT_FIELDS, ORDER_TEXT_KEYS as TEXTS, type OrderTextField as TextField } from "@/lib/domain/orderFields";

// The Orders Registry for the assistant, beside the tracker's own tools: an
// admin's edit of an order's plan fields, a plan month taken off an order,
// orders deleted out of the registry, and a merged BOM row's Fins spread
// over its MOs. Each runs the registry's (or the tracker's) own action as
// the person; the edits are undone by putting the old values back, a
// deletion is not — as on the registry, closing an order is the way back.

const MO = { type: "string", minLength: 1, maxLength: 60, description: "The MO number exactly as on the plan." } as const;
const ADMIN_ONLY = "Only an admin edits the orders registry.";
const NO_RIGHT = "You do not have the permission for this on the tracker — the owner ticks it on Users & Permissions.";

function adminDenied(ctx: ToolCtx): string | null {
  if (ctx.hidden.has("orders")) return "That screen is not opened for you, so the assistant cannot work on it for you.";
  return ctx.user.isAdmin ? null : ADMIN_ONLY;
}

// ------------------------------------------------------------- the edit

interface OrderEditInput {
  mo: string;
  bom?: string;
  planQty?: number;
  urgent?: boolean;
  ospEncloser?: number;
  soi?: string;
  customer?: string;
  fgCode?: string;
  kva?: string;
  rating?: string;
  colorRal?: string;
  remarks?: string;
  product?: string;
  secItem?: string;
  materialsRemarks?: string;
}

/** The fields plus the row's `updatedAt` as read (ISO): the action writes only
 *  while the order still reads so, as the registry's own form does. */
type OrderForm = Required<Omit<OrderEditInput, TextField>> & Record<TextField, string> & { updatedAt: string };

/** The whole form the registry posts: what is given, the order's own values for the rest. */
function formFor(o: MasterOrder, i: OrderEditInput): OrderForm {
  const out = {
    mo: o.mo, bom: i.bom ?? o.bom, planQty: i.planQty ?? o.planQty, urgent: i.urgent ?? o.urgent, ospEncloser: i.ospEncloser ?? o.ospEncloser,
    updatedAt: o.updatedAt.toISOString(),
  } as OrderForm;
  for (const k of TEXTS) out[k] = i[k] !== undefined ? i[k]! : (o[k] ?? "");
  return out;
}

/** What the order reads now, field by field, as the form would post it back. */
const asForm = (o: MasterOrder): OrderForm => formFor(o, { mo: o.mo });

const FIELD_LABEL: Record<keyof Omit<OrderForm, "mo" | "updatedAt">, string> = {
  bom: "BOM", planQty: "Plan qty", urgent: "Urgent", ospEncloser: "OSP enclosures",
  ...Object.fromEntries(TEXTS.map((k) => [k, TEXT_FIELDS[k].label])) as Record<TextField, string>,
};

export const updateOrderTool: WriteTool<OrderEditInput> = {
  kind: "write",
  name: "update_order",
  title: "Edit an order on the registry",
  description:
    "An admin's edit of one order on the Orders Registry: its BOM, plan qty (it may go down here — the registry is planning's word), urgent flag, OSP enclosures, SOI, customer, FG code, kVA, rating, colour (RAL), remarks, product, secondary item, materials remarks — only the fields given change (\"\" clears a text). Fins, CRC and SFM are the tracker's (set_order_specs). Undo puts the order back.",
  area: "tracker",
  risk: (i) => (i.bom !== undefined || i.planQty !== undefined ? "high" : "low"),
  tabs: ["orders"],
  schema: {
    type: "object",
    properties: {
      mo: MO,
      bom: { type: "string", minLength: 1, maxLength: 60 },
      planQty: { type: "integer", minimum: 0, maximum: 1000000 },
      urgent: { type: "boolean" },
      ospEncloser: { type: "integer", minimum: 0, maximum: 1000000 },
      ...Object.fromEntries(TEXTS.map((k) => [k, { type: "string", maxLength: TEXT_FIELDS[k].max }])),
    },
    required: ["mo"],
    additionalProperties: false,
  },
  parse(r) {
    const i = { ...(r as unknown as OrderEditInput), mo: String(r.mo).trim() };
    if (i.bom !== undefined) i.bom = i.bom.replace(/[\r\n]/g, "").trim().toUpperCase();
    for (const k of TEXTS) if (i[k] !== undefined) i[k] = i[k]!.trim();
    if (Object.keys(i).length === 1) return "Say what changes on the order.";
    return i;
  },
  async describe(i, ctx) {
    const denied = adminDenied(ctx);
    if (denied) return { error: denied };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { error: `${i.mo} is not in the registry.` };
    const now = asForm(o);
    const next = formFor(o, i);
    const changes: AiChange[] = (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[])
      .filter((k) => String(now[k]) !== String(next[k]))
      .map((k) => ({ label: `${o.mo} ${FIELD_LABEL[k]}`, before: cell(now[k]), after: cell(next[k]) }));
    if (changes.length === 0) return { error: `${o.mo} reads so already.` };
    return {
      title: `Edit ${o.mo} on the registry`,
      summary: `Edit ${o.mo} on the Orders Registry: ${changes.map((c) => `${c.label.slice(o.mo.length + 1)} ${c.before} → ${c.after}`).join("; ")}.`,
      changes,
      snapshot: now,
    };
  },
  async execute(i) {
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { ok: false, error: `${i.mo} is not in the registry.` };
    const before = asForm(o);
    const next = formFor(o, i);
    const r = await updateOrder(formOf({ ...next, urgent: next.urgent ? "true" : "false" }));
    if (!r.ok) return { ok: false, error: r.error };
    // put back exactly the fields this edit moved
    const back = Object.fromEntries((Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).filter((k) => String(before[k]) !== String(next[k])).map((k) => [k, before[k]]));
    return { ok: true, message: `${i.mo} is edited.`, undo: { tool: "update_order", input: { mo: i.mo, ...back } } };
  },
};

// ------------------------------------------------------------- plan months

const monthsOf = (o: Pick<MasterOrder, "months" | "source">) => (o.months || o.source || "").split(",").map((s) => s.trim()).filter(Boolean);

export const removeOrderMonthTool: WriteTool<{ mo: string; month: string }> = {
  kind: "write",
  name: "remove_order_month",
  title: "Take a plan month off an order",
  description: "An admin's removal of a plan month an order was wrongly tagged with (the tracker's 🔁 badge), e.g. \"July 2026\" — an order keeps at least one month. Undo puts the months back.",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { mo: MO, month: { type: "string", minLength: 3, maxLength: 30, description: "The month as the badge shows it, e.g. July 2026." } },
    required: ["mo", "month"],
    additionalProperties: false,
  },
  parse: (r) => ({ mo: String(r.mo).trim(), month: String(r.month).trim() }),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { error: `${i.mo} is not in the registry.` };
    const months = monthsOf(o);
    if (!months.includes(i.month)) return { error: `${i.mo} is not tagged with ${i.month} — it has ${months.join(", ") || "no month"}.` };
    if (months.length <= 1) return { error: "An order keeps at least one plan month." };
    return {
      title: `Take ${i.month} off ${i.mo}`,
      summary: `Take the plan month ${i.month} off ${i.mo} — it stays tagged ${months.filter((m) => m !== i.month).join(", ")}.`,
      changes: [{ label: `${i.mo} months`, before: months.join(", "), after: months.filter((m) => m !== i.month).join(", ") }],
      snapshot: { months: o.months, source: o.source },
    };
  },
  async execute(i) {
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { months: true } });
    if (!o) return { ok: false, error: `${i.mo} is not in the registry.` };
    const r = await removeOrderMonth(formOf({ mo: i.mo, month: i.month }));
    return r.ok ? { ok: true, message: `${i.month} is off ${i.mo}.`, undo: { tool: "restore_order_months", input: { mo: i.mo, months: o.months } } } : { ok: false, error: r.error };
  },
};

/** The undo of a month taken off — never offered to the model. */
export const restoreOrderMonthsTool: WriteTool<{ mo: string; months: string }> = {
  kind: "write",
  name: "restore_order_months",
  internal: true,
  title: "Put an order's months back",
  description: "Put an order's plan months back as they were (the undo of remove_order_month).",
  area: "tracker",
  risk: "low",
  schema: { type: "object", properties: { mo: MO, months: { type: "string", maxLength: 2000 } }, required: ["mo", "months"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { months: true, source: true } });
    if (!o) return { error: `${i.mo} is not in the registry any more.` };
    return {
      title: `Put ${i.mo}'s months back`,
      summary: `Put ${i.mo}'s plan months back: ${i.months || o.source || "—"}.`,
      changes: [{ label: `${i.mo} months`, before: monthsOf(o).join(", "), after: monthsOf({ months: i.months, source: o.source }).join(", ") }],
      snapshot: { months: o.months, source: o.source },
    };
  },
  async execute(i) {
    const r = await restoreOrderMonths(i.mo, i.months);
    return r.ok ? { ok: true, message: `${i.mo}'s months are back.` } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------------ fins

interface FinsInput {
  bom: string;
  mos: string[];
  total: number;
}

async function finsOf(i: FinsInput): Promise<{ rows: { mo: string; required: number; fins: string | null }[] } | { error: string }> {
  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: i.mos } }, select: { mo: true, bom: true, planQty: true, fins: true } });
  const byMo = new Map(orders.map((o) => [o.mo, o]));
  const off = i.mos.find((mo) => byMo.get(mo)?.bom !== i.bom);
  if (off) return { error: `${off} is not on BOM ${i.bom}.` };
  return { rows: i.mos.map((mo) => ({ mo, required: byMo.get(mo)!.planQty, fins: byMo.get(mo)!.fins })) };
}

export const setBomFinsTool: WriteTool<FinsInput> = {
  kind: "write",
  name: "set_bom_fins",
  title: "Spread a BOM's Fins over its orders",
  description:
    "Type a merged BOM row's whole Fins count (how many of its tanks carry fins), as the tracker's group row does: spread over the MOs in the order given — the first filled to its tanks before the next, a reduction off the last ones first — and refused whole when it does not fit. One order's Fins is set_order_specs. Undo puts each MO's Fins back.",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      bom: { type: "string", minLength: 1, maxLength: 60 },
      mos: { type: "array", items: MO, minItems: 1, maxItems: 60, description: "The BOM's MOs in the order they should be filled." },
      total: { type: "integer", minimum: 0, maximum: 1000000, description: "The BOM's whole Fins count." },
    },
    required: ["bom", "mos", "total"],
    additionalProperties: false,
  },
  parse: (r) => ({ bom: String(r.bom).trim().toUpperCase(), mos: [...new Set((r.mos as string[]).map((m) => m.trim()).filter(Boolean))], total: r.total as number }),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.qty")) return { error: NO_RIGHT };
    const f = await finsOf(i);
    if ("error" in f) return f;
    const group = finsGroup(f.rows);
    if (!group) return { error: "One of these MOs has Fins written as text, not a number — set those one at a time (set_order_specs)." };
    const spread = spreadOverGroup(group.members, i.total - group.current);
    if (spread.left > 0) return { error: `Only ${group.current + spread.fits} fit — the ${f.rows.length} MOs carry ${f.rows.reduce((s, r) => s + r.required, 0)} tanks in all.` };
    if (spread.alloc.length === 0) return { error: `The BOM's Fins is ${group.current} already.` };
    const was = (mo: string) => Number((f.rows.find((r) => r.mo === mo)!.fins ?? "").trim() || 0);
    return {
      title: `${i.bom} Fins: ${group.current} → ${i.total}`,
      summary: `Spread ${i.bom}'s Fins ${group.current} → ${i.total}: ${spread.alloc.map((a) => `${a.mo} ${a.qty > 0 ? "+" : ""}${a.qty}`).join(", ")}.`,
      changes: spread.alloc.map((a) => ({ label: `${a.mo} Fins`, before: cell(was(a.mo)), after: cell(was(a.mo) + a.qty) })),
      snapshot: f.rows,
    };
  },
  async execute(i) {
    const f = await finsOf(i);
    if ("error" in f) return { ok: false, error: f.error };
    const r = await setGroupFins(formOf({ bom: i.bom, mos: i.mos.join(","), total: i.total }));
    if (!r.ok) return { ok: false, error: r.error };
    const after = await prisma.masterOrder.findMany({ where: { mo: { in: i.mos } }, select: { mo: true, fins: true } });
    const moved = f.rows.filter((row) => (after.find((a) => a.mo === row.mo)?.fins ?? null) !== row.fins);
    return {
      ok: true,
      message: `${i.bom}'s Fins is ${i.total}.`,
      undo: moved.length ? { tool: "set_order_specs", input: { changes: moved.map((row) => ({ mo: row.mo, field: "fins", value: row.fins ?? "" })) } } : undefined,
    };
  },
};

// ---------------------------------------------------------------- delete

export const deleteOrdersTool: WriteTool<{ mos: string[]; force?: boolean }> = {
  kind: "write",
  name: "delete_orders",
  title: "Delete orders from the registry",
  description:
    "An admin's deletion of orders out of the registry — the way back from an import that brought orders in by mistake: each order and its planning rows (worklist dates, hidden lines, pushes, machine places, run order, queue notes) go; the history (Daily log, returns, tanks, MATERIAL, ODOO) stays. An order with work recorded on it is refused unless force — then that history stays behind without its order. It cannot be undone; closing an order (set_order_status) is the usual way.",
  area: "tracker",
  risk: "destructive",
  tabs: ["orders"],
  schema: {
    type: "object",
    properties: {
      mos: { type: "array", items: MO, minItems: 1, maxItems: 100 },
      force: { type: "boolean", description: "Delete even orders with work recorded on them — only when the person says so, knowing the history stays." },
    },
    required: ["mos"],
    additionalProperties: false,
  },
  parse: (r) => ({ mos: [...new Set((r.mos as string[]).map((m) => m.trim()).filter(Boolean))], ...(r.force ? { force: true } : {}) }),
  async describe(i, ctx) {
    const denied = adminDenied(ctx);
    if (denied) return { error: denied };
    const rows = await orderDeletePreview(i.mos);
    const missing = i.mos.filter((mo) => !rows.some((r) => r.mo === mo));
    if (missing.length > 0) return { error: `Not in the registry: ${missing.join(", ")}.` };
    const worked = rows.filter((r) => r.loggedRows > 0 || r.tanks > 0);
    if (worked.length > 0 && !i.force) {
      return { error: `Work is recorded on ${worked.map((r) => `${r.mo} (${r.loggedRows} Daily log row(s)${r.tanks ? `, ${r.tanks} tank(s)` : ""})`).join(", ")} — close those orders instead, or delete anyway only if the person says so (force).` };
    }
    return {
      title: `Delete ${rows.length} order(s) from the registry`,
      summary: `Delete ${rows.map((r) => r.mo).join(", ")} from the registry with their planning rows${worked.length ? ` — the work recorded on ${worked.map((r) => r.mo).join(", ")} stays in the history without its order` : ""}. It cannot be undone.`,
      changes: rows.map((r): AiChange => ({
        label: `${r.mo} (${r.bom})`,
        before: `qty ${cell(r.planQty)}${r.loggedRows ? ` · ${cell(r.loggedQty)} pcs logged` : ""}${r.tanks ? ` · ${r.tanks} tank(s)` : ""}${r.planningRows ? ` · ${r.planningRows} planning row(s)` : ""}`,
        after: "deleted",
      })),
      snapshot: rows,
    };
  },
  async execute(i) {
    const r = await deleteOrders(formOf({ mos: i.mos.join(","), force: i.force ? "true" : "" }));
    return r.ok ? { ok: true, message: `Deleted ${r.deleted ?? i.mos.length} order(s) from the registry.` } : { ok: false, error: r.error };
  },
};

export const ORDER_TOOLS = [updateOrderTool, removeOrderMonthTool, restoreOrderMonthsTool, setBomFinsTool, deleteOrdersTool] as const;
