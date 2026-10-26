import "server-only";
import { traceHref } from "@/lib/domain/links";
import type { MasterOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { withLine } from "@/lib/server/line";
import { getMasterTracker } from "@/lib/server/masterTracker";
import { getLvTracker } from "@/lib/server/lvTracker";
import { getSettings } from "@/lib/server/data";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { groupTotal, loadGroupMembers, spreadGroupChange } from "@/lib/server/groupRecord";
import { readWorklistPush, restoreWorklistPush, type WorklistPushSnapshot } from "@/lib/server/rowSnapshots";
import { fullyDeliveredOpenOrders } from "@/lib/server/deliveredOrders";
import {
  closeDeliveredOrders, decidePlanQty, pushOrderToWorklist, setExcludedItems, setGroupOrderSpec,
  setOrderHold, setOrderPriority, setOrderQty, setOrderSpec, setOrderStatus,
} from "@/app/orders/actions";
import { recordGroupOutput, recordTrackerTotal } from "@/app/worklist/actions";
import { recordLvGroupTotal, recordLvTotal } from "@/app/lv/actions";
import { DELIVERED_STAGE, ITEMS, SHOTBLAST_STAGE, applicableItems, isItem, isPaintExempt, ospOf, stageItemError, type Item } from "@/lib/domain/constants";
import { linePermKey, trackerPermKey } from "@/lib/domain/permissions";
import { LV_CHAIN, LV_ITEM, lvChainError, lvGroupMembers, lvPermKey, lvStageOf, type LvChainStage, type LvState } from "@/lib/domain/lv";
import { spreadOverGroup } from "@/lib/domain/groupSpread";
import { TANK_ITEM } from "@/lib/domain/tanks";
import { cell, type AiChange } from "@/lib/domain/aiActions";
import type { NumberSchema, ObjectSchema } from "@/lib/domain/aiInput";
import { formOf, type ActionAnswer, type ReadTool, type WriteOutcome, type WriteTool } from "./types";

// The Plan Tracker for the assistant: the orders as the tracker computes
// them, and every change the tracker's own cells and buttons make — closing,
// holding, flagging, quantities, specs, components, a push to a worklist,
// recorded totals. Each write runs the tracker's own server action, as the
// person (their tracker permission decides), and says before → after.

const MO = { type: "string", minLength: 1, maxLength: 60, description: "The MO number exactly as on the plan (e.g. PF01/MO/12345)." } as const;
const MOS = (max: number) => ({ type: "array", items: MO, minItems: 1, maxItems: max, description: "MO numbers exactly as on the plan." }) as const;
const ITEM = { type: "string", enum: ITEMS, description: "The component: CF core frame, TC top cover, TN tank, CB cable box, AR arrester bracket, MB mono box." } as const;

const uniq = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
const NO_RIGHT = "You do not have the permission for this on the tracker — the owner ticks it on Users & Permissions.";

async function ordersOf(mos: readonly string[]): Promise<{ orders: MasterOrder[] } | { error: string }> {
  const orders = await prisma.masterOrder.findMany({ where: { mo: { in: [...mos] } } });
  const found = new Set(orders.map((o) => o.mo));
  const missing = mos.filter((m) => !found.has(m));
  if (missing.length > 0) return { error: `Not in the orders registry: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}. Check the MO numbers.` };
  return { orders: [...orders].sort((a, b) => a.mo.localeCompare(b.mo)) };
}

/** The several calls of one change, each through its action: done if any went
 *  through (what did not is said), refused if none did. */
function summed(done: string[], failed: string[], verb: string): WriteOutcome {
  if (done.length === 0) return { ok: false, error: failed.join(" · ") || "Nothing changed." };
  return { ok: true, message: `${verb} ${done.length === 1 ? done[0] : `${done.length} orders`}.${failed.length ? ` Not done: ${failed.join(" · ")}` : ""}` };
}

// ---------------------------------------------------------------- reading

interface GetOrdersInput {
  mos?: string[];
  bom?: string;
  line?: "TR" | "LV";
}

export const getOrders: ReadTool<GetOrdersInput> = {
  kind: "read",
  name: "get_orders",
  cacheable: true,
  title: "Reading the orders on the tracker",
  description:
    "The orders exactly as the Plan Tracker computes them: status, hold, priority, required quantity, the qty a plan import is holding back, plan months, the spec columns, and per component what is cut, welded, painted / shot blasted and delivered, what is made outside (OSP), which components the order does not need, and how many complete sets are done and left. Give MO numbers or a BOM. Read this before recording totals or changing an order.",
  schema: {
    type: "object",
    properties: {
      mos: { ...MOS(60) },
      bom: { type: "string", minLength: 1, maxLength: 60, description: "A BOM — every order on it." },
      line: { type: "string", enum: ["TR", "LV"], description: "TR transformers or LV panels; defaults to the line selected beside this chat." },
    },
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as GetOrdersInput;
    if (!i.mos?.length && !i.bom) return "Give the MO numbers or a BOM.";
    return { mos: i.mos ? uniq(i.mos) : undefined, bom: i.bom?.trim().toUpperCase(), line: i.line };
  },
  async run(i, ctx) {
    const want = (mo: string, bom: string) => (i.mos ? i.mos.includes(mo) : true) && (i.bom ? bom.toUpperCase() === i.bom : true);
    if ((i.line ?? ctx.line ?? "TR") === "LV") {
      const rows = (await withLine("LV", () => getLvTracker())).filter((r) => want(r.mo, r.bom));
      if (rows.length === 0) return { ok: true, text: "No LV order matches." };
      return {
        ok: true,
        links: rows.slice(0, 20).map((r) => ({ label: `${r.mo} · ${r.bom}`, href: traceHref({ mo: r.mo, line: "LV" }) })),
        text: JSON.stringify(rows.slice(0, 60).map((r) => ({
          mo: r.mo, bom: r.bom, soi: r.soi, product: r.product, status: r.status,
          onHold: r.hold.onHold ? { note: r.hold.holdNote, by: r.hold.holdBy, since: r.hold.holdSinceISO } : null,
          priority: r.priority, required: r.state.required,
          done: { punching: r.state.punch, bending: r.state.bend, welding: r.state.weld, painting: r.state.paint, delivered: r.state.delivered },
          complete: r.complete, remaining: r.remaining, months: r.months,
        }))),
      };
    }
    const rows = (await withLine("TR", () => getMasterTracker())).filter((r) => want(r.mo, r.bom));
    if (rows.length === 0) return { ok: true, text: "No transformer order matches (for panels, ask with line LV)." };
    return {
      ok: true,
      links: rows.slice(0, 20).map((r) => ({ label: `${r.mo} · ${r.bom}`, href: traceHref({ mo: r.mo, line: "TR" }) })),
      text: JSON.stringify(rows.slice(0, 60).map((r) => {
        const items: Record<string, Record<string, number>> = {};
        const notNeeded: string[] = [];
        for (const it of ITEMS) {
          const c = r.items[it];
          if (!c.eligible || c.excluded) {
            notNeeded.push(it);
            continue;
          }
          items[it] = {
            cut: c.cut, welded: c.weld,
            ...(isPaintExempt(it) ? { shotBlasted: c.shp } : { painted: c.paint }),
            delivered: c.delivered,
            ...(c.osp ? { madeOutside: c.osp } : {}),
          };
        }
        return {
          mo: r.mo, bom: r.bom, soi: r.soi, kva: r.kva, status: r.status,
          onHold: r.hold.onHold ? { note: r.hold.holdNote, by: r.hold.holdBy, since: r.hold.holdSinceISO } : null,
          priority: r.priority, urgent: r.urgent, required: r.required,
          ...(r.pendingQty ? { pendingQty: r.pendingQty } : {}),
          months: r.months,
          specs: { fins: r.fins, colorRal: r.colorRal, crcSize: r.crcSize, sfm: r.sfm },
          items, notNeeded, completeSets: r.complete, setsLeft: r.remaining,
        };
      })),
    };
  },
};

// ---------------------------------------------------------- order status

interface StatusInput {
  mos: string[];
  status: "open" | "closed";
}

export const setOrderStatusTool: WriteTool<StatusInput> = {
  kind: "write",
  name: "set_order_status",
  title: "Close or reopen orders",
  description:
    "Close finished orders (they leave the daily screens; their logs stay) or reopen closed ones. Runs the tracker's own Close / Reopen, needing the person's close/reopen permission for the order's line. A transformer order also closes by itself once it is finished and Odoo has closed all it needs (never one on hold or with a plan qty waiting); it never reopens by itself. One reopened by hand after it closed by itself stays open (it no longer closes by itself) until it is closed again.",
  area: "tracker",
  risk: (i) => (i.status === "closed" || i.mos.length > 1 ? "high" : "low"),
  schema: {
    type: "object",
    properties: { mos: { ...MOS(50) }, status: { type: "string", enum: ["open", "closed"], description: "closed = close them, open = reopen them." } },
    required: ["mos", "status"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...(r as unknown as StatusInput), mos: uniq((r as unknown as StatusInput).mos) }),
  async describe(i, ctx) {
    const o = await ordersOf(i.mos);
    if ("error" in o) return o;
    if (o.orders.some((x) => !hasPerm(ctx.user, linePermKey(x.line, "status")))) return { error: NO_RIGHT };
    const moving = o.orders.filter((x) => x.status !== i.status);
    if (moving.length === 0) return { error: `${i.mos.length === 1 ? "It is" : "They are all"} ${i.status} already.` };
    const verb = i.status === "closed" ? "Close" : "Reopen";
    return {
      title: `${verb} ${moving.length === 1 ? moving[0].mo : `${moving.length} orders`}`,
      summary: `${verb} ${moving.map((x) => x.mo).join(", ")}${i.status === "closed" ? " — they leave the daily screens; their logs stay." : "."}`,
      changes: moving.map((x) => ({ label: x.mo, before: x.status, after: i.status })),
      snapshot: o.orders.map((x) => ({ mo: x.mo, status: x.status })),
    };
  },
  async execute(i) {
    const o = await ordersOf(i.mos);
    if ("error" in o) return { ok: false, error: o.error };
    const moving = o.orders.filter((x) => x.status !== i.status).map((x) => x.mo);
    const done: string[] = [];
    const failed: string[] = [];
    for (const mo of moving) {
      const r: ActionAnswer = await setOrderStatus(formOf({ mo, status: i.status }));
      (r.ok ? done : failed).push(r.ok ? mo : `${mo}: ${r.error}`);
    }
    const out = summed(done, failed, i.status === "closed" ? "Closed" : "Reopened");
    return out.ok ? { ...out, undo: { tool: "set_order_status", input: { mos: done, status: i.status === "closed" ? "open" : "closed" } } } : out;
  },
};

// ------------------------------------------------------------------- hold

interface HoldInput {
  mos: string[];
  hold: boolean;
  note?: string;
}

export const setOrderHoldTool: WriteTool<HoldInput> = {
  kind: "write",
  name: "set_order_hold",
  title: "Put orders on hold or release them",
  description:
    "Put open orders ON HOLD (they stay on the tracker, tinted with the reason, and leave every worklist queue and the ETA) or release them. Closed orders are skipped. Give the reason as the note when holding.",
  area: "tracker",
  risk: (i) => (i.mos.length > 1 ? "high" : "low"),
  schema: {
    type: "object",
    properties: {
      mos: { ...MOS(100) },
      hold: { type: "boolean", description: "true = put on hold, false = release." },
      note: { type: "string", maxLength: 200, description: "The reason for the hold (e.g. \"waiting for material\")." },
    },
    required: ["mos", "hold"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as HoldInput;
    return { mos: uniq(i.mos), hold: i.hold, note: i.note?.trim() || undefined };
  },
  async describe(i, ctx) {
    const o = await ordersOf(i.mos);
    if ("error" in o) return o;
    if (o.orders.some((x) => !hasPerm(ctx.user, linePermKey(x.line, "status")))) return { error: NO_RIGHT };
    const open = o.orders.filter((x) => x.status === "open");
    const moving = i.hold ? open.filter((x) => !x.holdAt || (x.holdNote ?? "") !== (i.note ?? "")) : open.filter((x) => x.holdAt);
    if (moving.length === 0) return { error: i.hold ? (open.length === 0 ? "They are closed — a closed order cannot be put on hold." : "They are on hold already, with that note.") : "None of them is on hold." };
    const skipped = o.orders.length - open.length;
    return {
      title: `${i.hold ? "Hold" : "Release"} ${moving.length === 1 ? moving[0].mo : `${moving.length} orders`}`,
      summary: i.hold
        ? `Put ${moving.map((x) => x.mo).join(", ")} on hold${i.note ? ` — "${i.note}"` : ""}: they leave every worklist queue until released.${skipped ? ` ${skipped} closed order(s) skipped.` : ""}`
        : `Release ${moving.map((x) => x.mo).join(", ")} from hold: they come back to the worklists.`,
      changes: moving.map((x) => ({ label: x.mo, before: x.holdAt ? `on hold${x.holdNote ? ` — ${x.holdNote}` : ""}` : "running", after: i.hold ? `on hold${i.note ? ` — ${i.note}` : ""}` : "running" })),
      snapshot: o.orders.map((x) => ({ mo: x.mo, status: x.status, held: !!x.holdAt, note: x.holdNote })),
    };
  },
  async execute(i) {
    const o = await ordersOf(i.mos);
    if ("error" in o) return { ok: false, error: o.error };
    const open = o.orders.filter((x) => x.status === "open");
    const moving = i.hold ? open.filter((x) => !x.holdAt || (x.holdNote ?? "") !== (i.note ?? "")) : open.filter((x) => x.holdAt);
    const r: ActionAnswer = await setOrderHold(formOf({ mos: moving.map((x) => x.mo).join(","), hold: i.hold, note: i.note ?? "" }));
    if (!r.ok) return { ok: false, error: r.error };
    const mos = moving.map((x) => x.mo);
    // the undo puts each order back as it WAS: one that was running is
    // released, one that was already on hold (its note changed) is re-held
    // with its earlier note — one set_order_hold call can say only one of
    // those, so a mixed set has no undo; a release is undone only when every
    // order had the same reason
    const notes = new Set(moving.map((x) => x.holdNote ?? ""));
    const note = [...notes][0];
    const reHold = notes.size === 1 && moving.every((x) => x.holdAt)
      ? { tool: "set_order_hold", input: { mos, hold: true, ...(note ? { note } : {}) } }
      : undefined;
    const undo = i.hold && moving.every((x) => !x.holdAt) ? { tool: "set_order_hold", input: { mos, hold: false } } : reHold;
    return { ok: true, message: `${i.hold ? "Put on hold" : "Released"}: ${mos.join(", ")}.`, undo };
  },
};

// --------------------------------------------------------------- priority

interface PriorityInput {
  mo: string;
  priority: boolean;
}

export const setOrderPriorityTool: WriteTool<PriorityInput> = {
  kind: "write",
  name: "set_order_priority",
  title: "Flag an order as priority",
  description: "Flag an order as PRIORITY ⭐ (it shows in the priority table on top of every department's worklist until its work is done) or take the flag off.",
  area: "tracker",
  risk: "low",
  schema: { type: "object", properties: { mo: MO, priority: { type: "boolean", description: "true = flag, false = unflag." } }, required: ["mo", "priority"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.priority")) return { error: NO_RIGHT };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { error: `${i.mo} is not in the orders registry.` };
    if (o.priority === i.priority) return { error: `${i.mo} is ${i.priority ? "flagged" : "not flagged"} already.` };
    return {
      title: `${i.priority ? "Flag" : "Unflag"} ${i.mo} as priority`,
      summary: i.priority ? `Flag ${i.mo} as priority ⭐ — it goes to the priority table on top of every worklist.` : `Take the priority flag off ${i.mo}.`,
      changes: [{ label: `${i.mo} ⭐`, before: cell(o.priority), after: cell(i.priority) }],
      snapshot: { mo: o.mo, priority: o.priority },
    };
  },
  async execute(i) {
    const r: ActionAnswer = await setOrderPriority(formOf({ mo: i.mo, priority: i.priority }));
    return r.ok ? { ok: true, message: `${i.mo} ${i.priority ? "flagged" : "unflagged"}.`, undo: { tool: "set_order_priority", input: { mo: i.mo, priority: !i.priority } } } : { ok: false, error: r.error };
  },
};

// ---------------------------------------------------------------- quantity

interface QtyInput {
  mo: string;
  qty: number;
}

export const setOrderQtyTool: WriteTool<QtyInput> = {
  kind: "write",
  name: "set_order_qty",
  title: "Change an order's required quantity",
  description: "Set an order's REQUIRED quantity (planQty) by hand — e.g. a confirmed decrease from a monthly revision. The card warns when it would fall below what is already made.",
  area: "tracker",
  risk: "high",
  schema: { type: "object", properties: { mo: MO, qty: { type: "number", minimum: 0.001, maximum: 1000000, description: "The new required quantity, > 0." } }, required: ["mo", "qty"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.qty")) return { error: NO_RIGHT };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { error: `${i.mo} is not in the orders registry.` };
    if (o.planQty === i.qty) return { error: `${i.mo} is ${i.qty} already.` };
    // the most recorded of ONE component at one stage — the figure the order's
    // quantity is compared against (a sum over all components would warn on
    // every order with two components recorded)
    const sums = await prisma.handoverEntry.groupBy({ by: ["dept", "item"], where: { mo: i.mo }, _sum: { qty: true } });
    const most = Math.max(0, ...sums.map((s) => s._sum.qty ?? 0));
    const changes: AiChange[] = [{ label: `${i.mo} required`, before: cell(o.planQty), after: cell(i.qty) }];
    if (i.qty < most) changes.push({ label: "⚠ already recorded at a stage", before: cell(most), after: "more than the order" });
    return {
      title: `${i.mo}: required ${cell(o.planQty)} → ${cell(i.qty)}`,
      summary: `Set ${i.mo}'s required quantity from ${cell(o.planQty)} to ${cell(i.qty)}.${i.qty < most ? ` ${most} pieces are already recorded at one stage — that work would be beyond the order.` : ""}`,
      changes,
      snapshot: { mo: o.mo, planQty: o.planQty },
    };
  },
  async execute(i) {
    const before = (await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { planQty: true } }))?.planQty;
    const r: ActionAnswer = await setOrderQty(formOf({ mo: i.mo, qty: i.qty }));
    return r.ok ? { ok: true, message: `${i.mo} now requires ${cell(i.qty)}.`, undo: before ? { tool: "set_order_qty", input: { mo: i.mo, qty: before } } : undefined } : { ok: false, error: r.error };
  },
};

interface PendingInput {
  mos: string[];
  decision: "use" | "keep";
}

export const decidePendingQtyTool: WriteTool<PendingInput> = {
  kind: "write",
  name: "decide_pending_qty",
  title: "Answer the quantities a plan import held back",
  description:
    "When a plan import brings a different quantity for an order already in the registry, it is held back (pendingQty on get_orders). use = take the sheet's figure as the required quantity, keep = keep the old one. Either way the question is closed.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: { mos: { ...MOS(100) }, decision: { type: "string", enum: ["use", "keep"], description: "use the sheet's quantity, or keep the current one." } },
    required: ["mos", "decision"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...(r as unknown as PendingInput), mos: uniq((r as unknown as PendingInput).mos) }),
  async describe(i, ctx) {
    const o = await ordersOf(i.mos);
    if ("error" in o) return o;
    const waiting = o.orders.filter((x) => x.pendingPlanQty !== null);
    if (waiting.length === 0) return { error: "Nothing is waiting on these orders." };
    if (waiting.some((x) => !hasPerm(ctx.user, "tracker.qty") && !hasPerm(ctx.user, linePermKey(x.line, "import")))) return { error: NO_RIGHT };
    return {
      title: `${i.decision === "use" ? "Use" : "Keep"} — ${waiting.length === 1 ? waiting[0].mo : `${waiting.length} held quantities`}`,
      summary: i.decision === "use" ? `Take the plan sheet's quantity for ${waiting.map((x) => x.mo).join(", ")}.` : `Keep the current quantity for ${waiting.map((x) => x.mo).join(", ")} and drop the sheet's figure.`,
      changes: waiting.map((x) => ({
        label: `${x.mo}${x.pendingQtyMonth ? ` (${x.pendingQtyMonth})` : ""}`,
        before: `${cell(x.planQty)} · sheet says ${cell(x.pendingPlanQty)}`,
        after: i.decision === "use" && x.pendingPlanQty! > 0 ? cell(x.pendingPlanQty) : cell(x.planQty),
      })),
      snapshot: waiting.map((x) => ({ mo: x.mo, planQty: x.planQty, pending: x.pendingPlanQty })),
    };
  },
  async execute(i) {
    const o = await ordersOf(i.mos);
    if ("error" in o) return { ok: false, error: o.error };
    const byLine = new Map<string, string[]>();
    for (const x of o.orders.filter((y) => y.pendingPlanQty !== null)) byLine.set(x.line, [...(byLine.get(x.line) ?? []), x.mo]);
    const done: string[] = [];
    const failed: string[] = [];
    for (const [line, mos] of byLine) {
      // the action reads the line it may import for from the line on screen
      const r: ActionAnswer = await withLine(line === "LV" ? "LV" : "TR", () => decidePlanQty(formOf({ decision: i.decision, mos: mos.join(",") })));
      if (r.ok) done.push(...mos);
      else failed.push(`${mos.join(", ")}: ${r.error}`);
    }
    return summed(done, failed, i.decision === "use" ? "Took the sheet's quantity for" : "Kept the quantity of");
  },
};

// ------------------------------------------------------------------- specs

const SPEC = { type: "string", enum: ["fins", "colorRal", "crcSize", "sfm"], description: "fins = Fins, colorRal = Colour (RAL), crcSize = CRC size, sfm = SFM." } as const;
const SPEC_LABEL: Record<string, string> = { fins: "Fins", colorRal: "Colour", crcSize: "CRC size", sfm: "SFM" };
type SpecField = "fins" | "colorRal" | "crcSize" | "sfm";

interface SpecsInput {
  changes: { mo: string; field: SpecField; value: string }[];
}

export const setOrderSpecsTool: WriteTool<SpecsInput> = {
  kind: "write",
  name: "set_order_specs",
  title: "Set spec columns on orders",
  description: "Type the tracker's spec columns — Fins, Colour (RAL), CRC size, SFM — on one or several orders. An empty value clears the cell. Typed values are kept as typed.",
  area: "tracker",
  risk: (i) => (i.changes.length > 1 ? "high" : "low"),
  schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: { mo: MO, field: SPEC, value: { type: "string", maxLength: 40, description: "The value; empty clears it." } },
          required: ["mo", "field", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.qty")) return { error: NO_RIGHT };
    const o = await ordersOf(uniq(i.changes.map((c) => c.mo)));
    if ("error" in o) return o;
    const byMo = new Map(o.orders.map((x) => [x.mo, x]));
    const real = i.changes.filter((c) => (byMo.get(c.mo)![c.field] ?? "") !== c.value);
    if (real.length === 0) return { error: "Every one of them reads so already." };
    return {
      title: real.length === 1 ? `${real[0].mo}: ${SPEC_LABEL[real[0].field]} → ${cell(real[0].value)}` : `${real.length} spec cells`,
      summary: `Set ${real.map((c) => `${SPEC_LABEL[c.field]} of ${c.mo} to ${c.value ? `"${c.value}"` : "empty"}`).join("; ")}.`,
      changes: real.map((c) => ({ label: `${c.mo} ${SPEC_LABEL[c.field]}`, before: cell(byMo.get(c.mo)![c.field]), after: cell(c.value) })),
      snapshot: real.map((c) => ({ mo: c.mo, field: c.field, value: byMo.get(c.mo)![c.field] ?? "" })),
    };
  },
  async execute(i) {
    const o = await ordersOf(uniq(i.changes.map((c) => c.mo)));
    if ("error" in o) return { ok: false, error: o.error };
    const byMo = new Map(o.orders.map((x) => [x.mo, x]));
    const done: string[] = [];
    const failed: string[] = [];
    const undo: SpecsInput["changes"] = [];
    for (const c of i.changes) {
      const before = byMo.get(c.mo)![c.field] ?? "";
      if (before === c.value) continue;
      const r: ActionAnswer = await setOrderSpec(formOf({ mo: c.mo, field: c.field, value: c.value }));
      if (r.ok) {
        done.push(`${c.mo} ${SPEC_LABEL[c.field]}`);
        undo.push({ mo: c.mo, field: c.field, value: before });
      } else failed.push(`${c.mo} ${SPEC_LABEL[c.field]}: ${r.error}`);
    }
    if (done.length === 0) return { ok: false, error: failed.join(" · ") || "Nothing changed." };
    return { ok: true, message: `Set ${done.join(", ")}.${failed.length ? ` Not done: ${failed.join(" · ")}` : ""}`, undo: { tool: "set_order_specs", input: { changes: undo } } };
  },
};

interface BomSpecInput {
  bom: string;
  field: "colorRal" | "crcSize" | "sfm";
  value: string;
}

export const setBomSpecTool: WriteTool<BomSpecInput> = {
  kind: "write",
  name: "set_bom_spec",
  title: "Set a spec on every order of a BOM",
  description: "Type Colour (RAL), CRC size or SFM once for a whole BOM: every order carrying the BOM gets that value (the tracker's merged-row edit). Fins is a count per order — use set_order_specs for it.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      bom: { type: "string", minLength: 1, maxLength: 60, description: "The BOM." },
      field: { type: "string", enum: ["colorRal", "crcSize", "sfm"], description: "colorRal = Colour (RAL), crcSize = CRC size, sfm = SFM." },
      value: { type: "string", maxLength: 40, description: "The value; empty clears it." },
    },
    required: ["bom", "field", "value"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...(r as unknown as BomSpecInput), bom: String(r.bom).trim().toUpperCase() }),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.qty")) return { error: NO_RIGHT };
    const orders = await prisma.masterOrder.findMany({ where: { bom: i.bom }, orderBy: { mo: "asc" } });
    if (orders.length === 0) return { error: `No order carries BOM ${i.bom}.` };
    const moving = orders.filter((x) => (x[i.field] ?? "") !== i.value);
    if (moving.length === 0) return { error: `Every order of ${i.bom} reads so already.` };
    return {
      title: `${i.bom}: ${SPEC_LABEL[i.field]} → ${cell(i.value)} on ${moving.length} order${moving.length === 1 ? "" : "s"}`,
      summary: `Set ${SPEC_LABEL[i.field]} to ${i.value ? `"${i.value}"` : "empty"} on every order of BOM ${i.bom} (${orders.length}).`,
      changes: moving.map((x) => ({ label: `${x.mo} ${SPEC_LABEL[i.field]}`, before: cell(x[i.field]), after: cell(i.value) })),
      snapshot: orders.map((x) => ({ mo: x.mo, value: x[i.field] ?? "" })),
    };
  },
  async execute(i) {
    const before = await prisma.masterOrder.findMany({ where: { bom: i.bom }, select: { mo: true, colorRal: true, crcSize: true, sfm: true } });
    const r: ActionAnswer = await setGroupOrderSpec(formOf({ bom: i.bom, field: i.field, value: i.value }));
    if (!r.ok) return { ok: false, error: r.error };
    const undo = before
      .map((b) => ({ mo: b.mo, field: i.field, value: b[i.field] ?? "" }))
      .filter((b) => b.value !== i.value);
    return { ok: true, message: `${SPEC_LABEL[i.field]} set on BOM ${i.bom}.`, undo: undo.length ? { tool: "set_order_specs", input: { changes: undo } } : undefined };
  },
};

// -------------------------------------------------------------- components

interface ComponentsInput {
  mo: string;
  items: Item[];
}

export const setRequiredComponentsTool: WriteTool<ComponentsInput> = {
  kind: "write",
  name: "set_required_components",
  title: "Set which components an order needs",
  description:
    "Say which of the six components an order needs, whatever the KVA/rating rule says: list every component it DOES need. Components left out become N/A — they leave the worklists and stop gating completion; AR/MB listed are forced on.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: { mo: MO, items: { type: "array", items: ITEM, minItems: 1, maxItems: 6, description: "Every component the order needs." } },
    required: ["mo", "items"],
    additionalProperties: false,
  },
  parse: (r) => {
    const items = uniq((r.items as string[]).map((x) => x.toUpperCase()));
    if (items.some((x) => !isItem(x))) return "items: unknown component.";
    return { mo: String(r.mo).trim(), items: items as Item[] };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.components")) return { error: NO_RIGHT };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { error: `${i.mo} is not in the orders registry.` };
    const now = applicableItems(o);
    const changes = ITEMS.filter((it) => now.includes(it) !== i.items.includes(it)).map((it) => ({ label: `${i.mo} ${it}`, before: now.includes(it) ? "needed" : "N/A", after: i.items.includes(it) ? "needed" : "N/A" }));
    if (changes.length === 0) return { error: `${i.mo} needs exactly those already.` };
    return {
      title: `${i.mo}: components ${now.join(", ")} → ${i.items.join(", ")}`,
      summary: `${i.mo} will need ${i.items.join(", ")} — the rest are N/A and leave the worklists.`,
      changes,
      snapshot: { mo: o.mo, needed: now },
    };
  },
  async execute(i) {
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    const before = o ? applicableItems(o) : null;
    const r: ActionAnswer = await setExcludedItems(formOf({ mo: i.mo, required: i.items.join(",") }));
    return r.ok ? { ok: true, message: `${i.mo} now needs ${i.items.join(", ")}.`, undo: before ? { tool: "set_required_components", input: { mo: i.mo, items: before } } : undefined } : { ok: false, error: r.error };
  },
};

// ----------------------------------------------------------------- pushes

type PushQty = Partial<Record<Item, number>>;

interface PushInput {
  mo: string;
  dept: "Cut" | "Welding" | "Painting";
  qty: PushQty;
}

const pushQtySchema: ObjectSchema = {
  type: "object",
  properties: Object.fromEntries(ITEMS.map((it) => [it, { type: "integer", minimum: 0, maximum: 100000 } satisfies NumberSchema])),
  additionalProperties: false,
  description: "Pieces per component to send; 0 or left out sends none. All zero clears the push.",
};

export const pushToWorklistTool: WriteTool<PushInput> = {
  kind: "write",
  name: "push_to_worklist",
  title: "Send an order down to a worklist",
  description:
    "Send an order DOWN from the Plan Tracker to a department's worklist with a chosen quantity per component (at most what that department still owes). It replaces any earlier push of the same order to that department; all-zero quantities clear it.",
  area: "tracker",
  // pieces sent down are a quantity — they wait for the person's click;
  // clearing a push is not
  risk: (i) => (ITEMS.some((it) => (i.qty[it] ?? 0) > 0) ? "high" : "low"),
  schema: {
    type: "object",
    properties: { mo: MO, dept: { type: "string", enum: ["Cut", "Welding", "Painting"], description: "The worklist." }, qty: pushQtySchema },
    required: ["mo", "dept", "qty"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.push")) return { error: NO_RIGHT };
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo } });
    if (!o) return { error: `${i.mo} is not in the orders registry.` };
    if (o.status !== "open") return { error: `${i.mo} is closed.` };
    if (o.line === "LV") return { error: `${i.mo} is an LV panel order — panels are not pushed to the transformer worklists.` };
    const [current, sums] = await Promise.all([
      prisma.worklistPush.findMany({ where: { dept: i.dept, mo: i.mo } }),
      prisma.handoverEntry.groupBy({ by: ["item"], where: { mo: i.mo, dept: i.dept }, _sum: { qty: true } }),
    ]);
    const cur = new Map(current.map((p) => [p.item, p.qty]));
    const done = new Map(sums.map((s) => [s.item, s._sum.qty ?? 0]));
    const changes: AiChange[] = [];
    for (const it of ITEMS) {
      const want = i.qty[it] ?? 0;
      const had = cur.get(it) ?? 0;
      if (want === had) continue;
      if (want > 0 && !applicableItems(o).includes(it)) return { error: `${i.mo} does not need ${it}.` };
      if (want > 0 && i.dept === "Painting" && isPaintExempt(it)) return { error: `${it} is never painted.` };
      const left = Math.max(0, o.planQty - ospOf(o, it) - (done.get(it) ?? 0));
      if (want > left) return { error: `${it}: only ${left} still owed by ${i.dept} — cannot send ${want}.` };
      changes.push({ label: `${i.mo} ${it} → ${i.dept}`, before: had ? `${had} pushed` : "—", after: want ? `${want} pushed` : "—" });
    }
    if (changes.length === 0) return { error: "That is what is pushed already." };
    const clearing = ITEMS.every((it) => !(i.qty[it] ?? 0));
    return {
      title: clearing ? `Clear the push of ${i.mo} to ${i.dept}` : `Push ${i.mo} to ${i.dept}`,
      summary: clearing ? `Take ${i.mo} off the ${i.dept} worklist's pushed lines.` : `Send ${ITEMS.filter((it) => i.qty[it]).map((it) => `${i.qty[it]} ${it}`).join(", ")} of ${i.mo} down to the ${i.dept} worklist.`,
      changes,
      snapshot: { mo: i.mo, dept: i.dept, status: o.status, pushed: Object.fromEntries(cur), done: Object.fromEntries(done) },
    };
  },
  async execute(i) {
    // the undo writes the rows back AS THEY WERE — quantity and the output
    // already counted against them (baseDone); pushing the old quantity again
    // would count the output consumed since from zero
    const before = await readWorklistPush(i.dept, i.mo);
    const r: ActionAnswer = await pushOrderToWorklist(formOf({ mo: i.mo, dept: i.dept, ...Object.fromEntries(ITEMS.map((it) => [`qty${it}`, i.qty[it] ?? 0])) }));
    const undo = { tool: "restore_worklist_push", input: { mo: i.mo, dept: i.dept, rows: JSON.stringify(before) } };
    if (r.ok) return { ok: true, message: `Pushed ${i.mo} to ${i.dept}.`, undo };
    // all zero: the action clears the push and answers "nothing sent" — what
    // was asked for, so read the table rather than the words
    if (ITEMS.every((it) => !(i.qty[it] ?? 0)) && (await prisma.worklistPush.count({ where: { dept: i.dept, mo: i.mo } })) === 0) {
      return { ok: true, message: `Cleared the push of ${i.mo} to ${i.dept}.`, undo };
    }
    return { ok: false, error: r.error };
  },
};

/** The undo of a push — never offered to the model. */
export const restoreWorklistPushTool: WriteTool<{ mo: string; dept: "Cut" | "Welding" | "Painting"; rows: string }> = {
  kind: "write",
  name: "restore_worklist_push",
  internal: true,
  title: "Put a push back",
  description: "Put an order's pushed lines on one worklist back exactly as they were (the undo of a push).",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { mo: MO, dept: { type: "string", enum: ["Cut", "Welding", "Painting"] }, rows: { type: "string", minLength: 2, maxLength: 100_000 } },
    required: ["mo", "dept", "rows"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as { mo: string; dept: "Cut" | "Welding" | "Painting"; rows: string };
    const state = pushState(i.rows);
    return typeof state === "string" ? state : i;
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "tracker.push")) return { error: NO_RIGHT };
    const then = pushState(i.rows) as WorklistPushSnapshot[];
    const now = await readWorklistPush(i.dept, i.mo);
    const text = (rows: WorklistPushSnapshot[]) => (rows.length ? rows.map((p) => `${p.qty} ${p.item}`).join(", ") : "—");
    return {
      title: `Put ${i.mo}'s push to ${i.dept} back`,
      summary: `Put ${i.mo}'s pushed lines on the ${i.dept} worklist back as they were.`,
      changes: [{ label: `${i.mo} → ${i.dept}`, before: text(now), after: text(then) }],
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreWorklistPush(i.dept, i.mo, pushState(i.rows) as WorklistPushSnapshot[]);
    return r.ok ? { ok: true, message: `${i.mo}'s push to ${i.dept} is back as it was.` } : { ok: false, error: r.error };
  },
};

function pushState(text: string): WorklistPushSnapshot[] | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "The earlier push could not be read.";
  }
  const ok = Array.isArray(v) && v.every((r) => r && typeof r === "object" && isItem(r.item) && typeof r.qty === "number" && r.qty >= 0 && typeof r.baseDone === "number" && r.baseDone >= 0 && typeof r.createdAt === "string");
  return ok ? (v as WorklistPushSnapshot[]) : "The earlier push is not whole.";
}

// ------------------------------------------------------- close delivered

interface CloseDeliveredInput {
  line: "TR" | "LV";
}

export const closeDeliveredTool: WriteTool<CloseDeliveredInput> = {
  kind: "write",
  name: "close_delivered_orders",
  title: "Close every fully delivered order",
  description: "Close every OPEN order of a line whose components have all reached the customer — the tracker's \"Close N delivered\". The app recomputes the list from the ledger itself.",
  area: "tracker",
  risk: "high",
  schema: { type: "object", properties: { line: { type: "string", enum: ["TR", "LV"], description: "TR transformers or LV panels." } }, required: ["line"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, linePermKey(i.line, "status"))) return { error: NO_RIGHT };
    const done = await fullyDeliveredOpenOrders(i.line);
    if (done.length === 0) return { error: "No open order of that line is fully delivered." };
    return {
      title: `Close ${done.length} delivered order${done.length === 1 ? "" : "s"}`,
      summary: `Close the ${done.length} ${i.line} order(s) fully delivered to the customer: ${done.map((o) => o.mo).join(", ")}.`,
      changes: done.map((o) => ({ label: o.mo, before: "open", after: "closed" })),
      snapshot: done.map((o) => o.mo).sort(),
    };
  },
  async execute(i) {
    const r = await withLine(i.line, () => closeDeliveredOrders());
    if (!r.ok) return { ok: false, error: r.error };
    const mos = r.mos ?? [];
    return { ok: true, message: `Closed ${mos.length} order(s).`, undo: mos.length ? { tool: "set_order_status", input: { mos, status: "open" } } : undefined };
  },
};

// --------------------------------------------------------- recorded totals

type TrackerDept = "Cut" | "Welding" | "Painting" | "ShotBlast" | "Delivered";
const DEPT = { type: "string", enum: ["Cut", "Welding", "Painting", "ShotBlast", "Delivered"], description: "The tracker column: Cut (Fab), Welding, Painting, ShotBlast (the core frame's final stage, CF only), Delivered." } as const;

interface TotalsInput {
  dept: TrackerDept;
  item: Item;
  totals: { mo: string; total: number }[];
}

async function stageTotals(dept: string, item: string, mos: readonly string[]): Promise<Map<string, number>> {
  const sums = await prisma.handoverEntry.groupBy({ by: ["mo"], where: { dept, item, mo: { in: [...mos] } }, _sum: { qty: true } });
  return new Map(sums.map((s) => [s.mo ?? "", s._sum.qty ?? 0]));
}

async function stageRuleError(dept: string, item: string): Promise<string | null> {
  const pair = stageItemError(dept, item);
  if (pair) return pair;
  if (dept === "Painting" && item === TANK_ITEM && (await getSettings()).tankTracking) return "Tanks are painted from the Painting worklist, tank by tank — not as a total.";
  return null;
}

export const recordStageTotalsTool: WriteTool<TotalsInput> = {
  kind: "write",
  name: "record_stage_totals",
  title: "Record totals on the tracker",
  description:
    "Type the NEW cumulative total of one tracker column (a stage) for one component on one or several orders, as the tracker's cells do: the difference lands in today's Daily log (a lower total is a correction). The chain is re-checked (delivered ≤ finished ≤ welded ≤ cut ≤ order). Read get_orders first for the current totals.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      item: ITEM,
      totals: {
        type: "array",
        minItems: 1,
        maxItems: 60,
        items: { type: "object", properties: { mo: MO, total: { type: "integer", minimum: 0, maximum: 1000000, description: "The new total at that stage." } }, required: ["mo", "total"], additionalProperties: false },
      },
    },
    required: ["dept", "item", "totals"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as TotalsInput;
    const mos = i.totals.map((t) => t.mo.trim());
    if (new Set(mos).size !== mos.length) return "totals: an MO is listed twice.";
    return { dept: i.dept, item: String(i.item).toUpperCase() as Item, totals: i.totals.map((t) => ({ mo: t.mo.trim(), total: t.total })) };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, trackerPermKey(i.dept))) return { error: NO_RIGHT };
    const rule = await stageRuleError(i.dept, i.item);
    if (rule) return { error: rule };
    const o = await ordersOf(i.totals.map((t) => t.mo));
    if ("error" in o) return o;
    const byMo = new Map(o.orders.map((x) => [x.mo, x]));
    const cur = await stageTotals(i.dept, i.item, i.totals.map((t) => t.mo));
    const changes: AiChange[] = [];
    const moving: TotalsInput["totals"] = [];
    for (const t of i.totals) {
      const was = cur.get(t.mo) ?? 0;
      if (was === t.total) continue;
      const ord = byMo.get(t.mo)!;
      if (ord.line === "LV") return { error: `${t.mo} is an LV panel order — use record_lv_totals.` };
      const chain = await checkOutputChain({ dept: i.dept, bom: ord.bom, mo: t.mo, item: i.item, qty: t.total - was });
      if (chain) return { error: chain };
      changes.push({ label: `${t.mo} ${i.item} ${i.dept}`, before: cell(was), after: `${cell(t.total)} (${t.total > was ? "+" : ""}${t.total - was} today)` });
      moving.push(t);
    }
    if (changes.length === 0) return { error: "Every total reads so already." };
    return {
      // the headline names the order that changes, not the first one listed
      title: changes.length === 1 ? `${moving[0].mo} ${i.item} ${i.dept}: ${changes[0].before} → ${moving[0].total}` : `${i.item} ${i.dept} on ${changes.length} orders`,
      summary: `Record the ${i.dept} totals of ${i.item}: ${moving.map((t) => `${t.mo} ${cur.get(t.mo) ?? 0} → ${t.total}`).join(", ")} — the differences go into today's Daily log.`,
      changes,
      snapshot: i.totals.map((t) => ({ mo: t.mo, total: cur.get(t.mo) ?? 0 })),
    };
  },
  async execute(i) {
    const o = await ordersOf(i.totals.map((t) => t.mo));
    if ("error" in o) return { ok: false, error: o.error };
    const byMo = new Map(o.orders.map((x) => [x.mo, x]));
    const cur = await stageTotals(i.dept, i.item, i.totals.map((t) => t.mo));
    const done: string[] = [];
    const failed: string[] = [];
    const undo: { mo: string; total: number }[] = [];
    for (const t of i.totals) {
      const was = cur.get(t.mo) ?? 0;
      if (was === t.total) continue;
      const r: ActionAnswer = await recordTrackerTotal(formOf({ dept: i.dept, bom: byMo.get(t.mo)!.bom, mo: t.mo, item: i.item, total: t.total }));
      if (r.ok) {
        done.push(`${t.mo} → ${t.total}`);
        undo.push({ mo: t.mo, total: was });
      } else failed.push(`${t.mo}: ${r.error}`);
    }
    if (done.length === 0) return { ok: false, error: failed.join(" · ") || "Nothing changed." };
    return {
      ok: true,
      message: `Recorded ${i.item} ${i.dept}: ${done.join(", ")}.${failed.length ? ` Not done: ${failed.join(" · ")}` : ""}`,
      undo: { tool: "record_stage_totals", input: { dept: i.dept, item: i.item, totals: undo } },
    };
  },
};

interface BomTotalInput {
  dept: TrackerDept;
  bom: string;
  item: Item;
  mos: string[];
  total: number;
}

export const recordBomTotalTool: WriteTool<BomTotalInput> = {
  kind: "write",
  name: "record_bom_total",
  title: "Record a BOM's total over its orders",
  description:
    "Type the NEW total of a merged BOM row for one stage and component, as the tracker's group row does: the change is spread over the MOs in the order given — the first filled to its limit before the next is touched, a reduction taken off the LAST ones first. The card shows exactly which MO gets what.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      bom: { type: "string", minLength: 1, maxLength: 60, description: "The BOM." },
      item: ITEM,
      mos: { ...MOS(60), description: "The BOM's MOs in the order they should be filled (the tracker lists them in MO order)." },
      total: { type: "integer", minimum: 0, maximum: 1000000, description: "The new total of the group at that stage." },
    },
    required: ["dept", "bom", "item", "mos", "total"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as BomTotalInput;
    return { ...i, bom: i.bom.trim().toUpperCase(), item: String(i.item).toUpperCase() as Item, mos: uniq(i.mos) };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, trackerPermKey(i.dept))) return { error: NO_RIGHT };
    const rule = await stageRuleError(i.dept, i.item);
    if (rule) return { error: rule };
    const members = await loadGroupMembers(i.bom, i.item, i.mos);
    if (!members) return { error: `An MO listed is not on BOM ${i.bom}, or is in no plan or log.` };
    // the tracker's group row lists registry orders only; a typed MO outside it
    // has no quantity to bound it and would take every piece the others cannot
    const ghost = members.filter((m) => !m.o).map((m) => m.mo);
    if (ghost.length) return { error: `Not in the orders registry: ${ghost.join(", ")}. Check the MO numbers.` };
    const panel = members.find((m) => m.o?.line === "LV");
    if (panel) return { error: `${panel.mo} is an LV panel order — use record_lv_bom_total.` };
    const current = groupTotal(members, i.dept);
    const delta = i.total - current;
    if (delta === 0) return { error: `The group total is ${current} already.` };
    const spread = spreadGroupChange(members, i.dept, i.item, delta);
    if (spread.left > 0) return { error: delta > 0 ? `Only ${spread.fits} more pieces fit on these orders (the chain and the order quantities).` : `Only ${spread.fits} can be taken off (later stages already used the rest).` };
    return {
      title: `${i.bom} ${i.item} ${i.dept}: ${current} → ${i.total}`,
      summary: `Record ${i.bom}'s ${i.item} ${i.dept} total ${current} → ${i.total}: ${spread.alloc.map((a) => `${a.mo} ${a.qty > 0 ? "+" : ""}${a.qty}`).join(", ")} in today's Daily log.`,
      changes: spread.alloc.map((a) => {
        const was = stageOfMember(members.find((m) => m.mo === a.mo)!, i.dept);
        return { label: `${a.mo} ${i.item} ${i.dept}`, before: cell(was), after: `${was + a.qty} (${a.qty > 0 ? "+" : ""}${a.qty} today)` };
      }),
      // everything the spread reads: the stage figures, each order's quantity,
      // its outsourced share and whether it needs the component at all
      snapshot: members.map((m) => ({ mo: m.mo, cut: m.cut, weld: m.weld, paint: m.paint, shp: m.shp, delivered: m.delivered, planQty: m.o?.planQty ?? null, osp: m.o ? ospOf(m.o, i.item) : 0, eligible: m.eligible })),
    };
  },
  async execute(i) {
    const members = await loadGroupMembers(i.bom, i.item, i.mos);
    if (!members) return { ok: false, error: `An MO listed is not on BOM ${i.bom}, or is in no plan or log.` };
    if (members.some((m) => !m.o)) return { ok: false, error: `Not in the orders registry: ${members.filter((m) => !m.o).map((m) => m.mo).join(", ")}.` };
    const before = new Map(members.map((m) => [m.mo, stageOfMember(m, i.dept)]));
    const r: ActionAnswer = await recordGroupOutput(formOf({ source: "tracker", dept: i.dept, bom: i.bom, item: i.item, mos: i.mos.join(","), total: i.total }));
    if (!r.ok) return { ok: false, error: r.error };
    const after = await stageTotals(i.dept, i.item, i.mos);
    const moved = i.mos.filter((mo) => (after.get(mo) ?? 0) !== before.get(mo));
    return {
      ok: true,
      message: `Recorded ${i.bom} ${i.item} ${i.dept} total ${i.total}.`,
      // put back MO by MO: a group reduction would come off the last MOs, not the ones that took it
      undo: moved.length ? { tool: "record_stage_totals", input: { dept: i.dept, item: i.item, totals: moved.map((mo) => ({ mo, total: before.get(mo) ?? 0 })) } } : undefined,
    };
  },
};

function stageOfMember(m: { cut: number; weld: number; paint: number; shp: number; delivered: number }, dept: string): number {
  switch (dept) {
    case "Cut": return m.cut;
    case "Welding": return m.weld;
    case "Painting": return m.paint;
    case SHOTBLAST_STAGE: return m.shp;
    default: return m.delivered;
  }
}

// -------------------------------------------------------------- LV totals

interface LvTotalsInput {
  stage: LvChainStage;
  totals: { mo: string; total: number }[];
}

async function lvStates(mos: readonly string[]): Promise<Map<string, LvState> | { error: string }> {
  const [orders, sums] = await Promise.all([
    prisma.masterOrder.findMany({ where: { mo: { in: [...mos] } }, select: { mo: true, line: true, planQty: true } }),
    prisma.handoverEntry.groupBy({ by: ["mo", "dept"], where: { mo: { in: [...mos] }, item: LV_ITEM }, _sum: { qty: true } }),
  ]);
  const out = new Map<string, LvState>();
  for (const mo of mos) {
    const o = orders.find((x) => x.mo === mo);
    if (!o || o.line !== "LV") return { error: `${mo} is not an LV panel order.` };
    const g = (d: string) => sums.find((s) => s.mo === mo && s.dept === d)?._sum.qty ?? 0;
    out.set(mo, { required: o.planQty, punch: g("Punching"), bend: g("Bending"), weld: g("Welding"), paint: g("Painting"), delivered: g(DELIVERED_STAGE) });
  }
  return out;
}

export const recordLvTotalsTool: WriteTool<LvTotalsInput> = {
  kind: "write",
  name: "record_lv_totals",
  title: "Record totals on the LV tracker",
  description:
    "Type the NEW cumulative total of one LV tracker stage (Punching, Bending, Welding, Painting, Delivered) on one or several panel orders: the difference lands in today's Daily log. The chain is re-checked (delivered ≤ painted ≤ welded ≤ bent ≤ punched ≤ order).",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      stage: { type: "string", enum: LV_CHAIN, description: "The LV stage." },
      totals: {
        type: "array",
        minItems: 1,
        maxItems: 60,
        items: { type: "object", properties: { mo: MO, total: { type: "integer", minimum: 0, maximum: 1000000 } }, required: ["mo", "total"], additionalProperties: false },
      },
    },
    required: ["stage", "totals"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as LvTotalsInput;
    const mos = i.totals.map((t) => t.mo.trim());
    if (new Set(mos).size !== mos.length) return "totals: an MO is listed twice.";
    return { stage: i.stage, totals: i.totals.map((t) => ({ mo: t.mo.trim(), total: t.total })) };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, lvPermKey(i.stage))) return { error: NO_RIGHT };
    const states = await lvStates(i.totals.map((t) => t.mo));
    if ("error" in states) return states;
    const changes: AiChange[] = [];
    const moving: LvTotalsInput["totals"] = [];
    for (const t of i.totals) {
      const s = states.get(t.mo)!;
      const was = lvStageOf(s, i.stage);
      if (was === t.total) continue;
      const err = lvChainError(s, i.stage, t.total - was, t.mo);
      if (err) return { error: err };
      changes.push({ label: `${t.mo} ${i.stage}`, before: cell(was), after: `${t.total} (${t.total > was ? "+" : ""}${t.total - was} today)` });
      moving.push(t);
    }
    if (changes.length === 0) return { error: "Every total reads so already." };
    return {
      title: changes.length === 1 ? `${changes[0].label}: ${changes[0].before} → ${moving[0].total}` : `LV ${i.stage} on ${changes.length} orders`,
      summary: `Record the LV ${i.stage} totals: ${moving.map((t) => `${t.mo} → ${t.total}`).join(", ")} — the differences go into today's Daily log.`,
      changes,
      snapshot: i.totals.map((t) => ({ mo: t.mo, state: states.get(t.mo) })),
    };
  },
  async execute(i) {
    const states = await lvStates(i.totals.map((t) => t.mo));
    if ("error" in states) return { ok: false, error: states.error };
    const done: string[] = [];
    const failed: string[] = [];
    const undo: { mo: string; total: number }[] = [];
    for (const t of i.totals) {
      const was = lvStageOf(states.get(t.mo)!, i.stage);
      if (was === t.total) continue;
      const r: ActionAnswer = await recordLvTotal(formOf({ stage: i.stage, mo: t.mo, total: t.total }));
      if (r.ok) {
        done.push(`${t.mo} → ${t.total}`);
        undo.push({ mo: t.mo, total: was });
      } else failed.push(`${t.mo}: ${r.error}`);
    }
    if (done.length === 0) return { ok: false, error: failed.join(" · ") || "Nothing changed." };
    return {
      ok: true,
      message: `Recorded LV ${i.stage}: ${done.join(", ")}.${failed.length ? ` Not done: ${failed.join(" · ")}` : ""}`,
      undo: { tool: "record_lv_totals", input: { stage: i.stage, totals: undo } },
    };
  },
};

interface LvBomTotalInput {
  stage: LvChainStage;
  bom: string;
  mos: string[];
  total: number;
}

/** The members of a merged panel row, checked: every MO a panel order of that BOM. */
async function lvGroup(i: LvBomTotalInput): Promise<{ rows: { mo: string; state: LvState }[] } | { error: string }> {
  const states = await lvStates(i.mos);
  if ("error" in states) return states;
  const boms = await prisma.masterOrder.findMany({ where: { mo: { in: i.mos } }, select: { mo: true, bom: true } });
  const off = i.mos.find((mo) => boms.find((b) => b.mo === mo)?.bom !== i.bom);
  if (off) return { error: `${off} is not on BOM ${i.bom}.` };
  return { rows: i.mos.map((mo) => ({ mo, state: states.get(mo)! })) };
}

export const recordLvBomTotalTool: WriteTool<LvBomTotalInput> = {
  kind: "write",
  name: "record_lv_bom_total",
  title: "Record a panel BOM's total over its orders",
  description:
    "Type the NEW total of a merged LV BOM row for one stage, as the LV tracker's group row does: the change is spread over the panel MOs in the order given — each filled to its own room before the next, a reduction taken off the LAST ones first — and refused whole when it does not fit. The card shows exactly which MO gets what.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      stage: { type: "string", enum: LV_CHAIN, description: "The LV stage." },
      bom: { type: "string", minLength: 1, maxLength: 60, description: "The panels' BOM." },
      mos: { ...MOS(60), description: "The BOM's panel MOs in the order they should be filled (the tracker lists them in MO order)." },
      total: { type: "integer", minimum: 0, maximum: 1000000, description: "The new total of the group at that stage." },
    },
    required: ["stage", "bom", "mos", "total"],
    additionalProperties: false,
  },
  parse: (r) => {
    const i = r as unknown as LvBomTotalInput;
    return { ...i, bom: i.bom.trim(), mos: uniq(i.mos) };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, lvPermKey(i.stage))) return { error: NO_RIGHT };
    const g = await lvGroup(i);
    if ("error" in g) return g;
    const current = g.rows.reduce((n, r) => n + lvStageOf(r.state, i.stage), 0);
    const delta = i.total - current;
    if (delta === 0) return { error: `The group total is ${current} already.` };
    const spread = spreadOverGroup(lvGroupMembers(g.rows, i.stage), delta);
    if (spread.left > 0) {
      return { error: delta > 0 ? `Only ${current + spread.fits} fit — the ${g.rows.length} MOs have no more room at ${i.stage} (the stage before it, or the order quantity, is the limit).` : `Only ${current - spread.fits} can be taken back — the rest already went on to the next stage.` };
    }
    return {
      title: `${i.bom} LV ${i.stage}: ${current} → ${i.total}`,
      summary: `Record ${i.bom}'s LV ${i.stage} total ${current} → ${i.total}: ${spread.alloc.map((a) => `${a.mo} ${a.qty > 0 ? "+" : ""}${a.qty}`).join(", ")} in today's Daily log.`,
      changes: spread.alloc.map((a) => {
        const was = lvStageOf(g.rows.find((r) => r.mo === a.mo)!.state, i.stage);
        return { label: `${a.mo} ${i.stage}`, before: cell(was), after: `${was + a.qty} (${a.qty > 0 ? "+" : ""}${a.qty} today)` };
      }),
      snapshot: g.rows,
    };
  },
  async execute(i) {
    const g = await lvGroup(i);
    if ("error" in g) return { ok: false, error: g.error };
    const before = new Map(g.rows.map((r) => [r.mo, lvStageOf(r.state, i.stage)]));
    const r: ActionAnswer = await recordLvGroupTotal(formOf({ stage: i.stage, bom: i.bom, mos: i.mos.join(","), total: i.total }));
    if (!r.ok) return { ok: false, error: r.error };
    const after = await lvStates(i.mos);
    const moved = "error" in after ? [] : i.mos.filter((mo) => lvStageOf(after.get(mo)!, i.stage) !== before.get(mo));
    return {
      ok: true,
      message: `Recorded ${i.bom} LV ${i.stage} total ${i.total}.`,
      // put back MO by MO: a group reduction would come off the last MOs, not the ones that took it
      undo: moved.length ? { tool: "record_lv_totals", input: { stage: i.stage, totals: moved.map((mo) => ({ mo, total: before.get(mo) ?? 0 })) } } : undefined,
    };
  },
};

export const TRACKER_TOOLS = [
  restoreWorklistPushTool,
  getOrders,
  setOrderStatusTool,
  setOrderHoldTool,
  setOrderPriorityTool,
  setOrderQtyTool,
  decidePendingQtyTool,
  setOrderSpecsTool,
  setBomSpecTool,
  setRequiredComponentsTool,
  pushToWorklistTool,
  closeDeliveredTool,
  recordStageTotalsTool,
  recordBomTotalTool,
  recordLvTotalsTool,
  recordLvBomTotalTool,
] as const;
