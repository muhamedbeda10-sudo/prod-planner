import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's Plan Tracker and Daily log tools: what each one's card says
// (before → after), which of the app's own actions it runs with what, and how
// it is undone — against a stubbed database and stubbed actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  // the undo of a push runs the real restoreWorklistPush (lib/server/rowSnapshots.ts) inside this transaction
  const tx = { worklistPush: { deleteMany: fn(), createMany: fn() } };
  return {
    tx,
    prisma: {
      masterOrder: { findMany: fn(), findUnique: fn() },
      handoverEntry: { groupBy: fn(), findUnique: fn(), findMany: fn() },
      worklistPush: { findMany: fn(), count: fn() },
      $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)),
    },
    perms: new Set<string>(),
    actions: {
      setOrderStatus: fn(), setOrderQty: fn(), decidePlanQty: fn(), setOrderSpec: fn(), setGroupOrderSpec: fn(),
      setOrderPriority: fn(), setOrderHold: fn(), pushOrderToWorklist: fn(), setExcludedItems: fn(), closeDeliveredOrders: fn(),
      updateOrder: fn(), deleteOrders: fn(), removeOrderMonth: fn(), setGroupFins: fn(),
      recordTrackerTotal: fn(), recordGroupOutput: fn(), recordLvTotal: fn(), recordLvGroupTotal: fn(),
      updateHandover: fn(), bulkSetHandoverDate: fn(), bulkDeleteHandover: fn(),
    },
    checkOutputChain: fn(),
    getSettings: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({
  hasPerm: (_u: unknown, k: string) => h.perms.has(k),
  requirePerm: async (k: string) => (h.perms.has(k) ? { user: { id: 1, name: "Sara" } } : { error: "You do not have permission to do this." }),
}));
vi.mock("@/lib/server/line", () => ({ withLine: (_l: string, f: () => unknown) => f() }));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: vi.fn() }));
vi.mock("@/lib/server/lvTracker", () => ({ getLvTracker: vi.fn() }));
vi.mock("@/lib/server/data", () => ({ getSettings: h.getSettings }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain, recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/deliveredOrders", () => ({ fullyDeliveredOpenOrders: vi.fn() }));
vi.mock("@/lib/server/orderDelete", () => ({ orderDeletePreview: vi.fn() }));
vi.mock("@/app/orders/actions", () => h.actions);
vi.mock("@/app/worklist/actions", () => h.actions);
vi.mock("@/app/lv/actions", () => h.actions);
vi.mock("@/app/handover/actions", () => h.actions);

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import {
  pushToWorklistTool, recordBomTotalTool, recordLvBomTotalTool, recordStageTotalsTool, restoreWorklistPushTool, setOrderHoldTool, setOrderQtyTool, setOrderSpecsTool, setOrderStatusTool,
} from "@/lib/server/ai/tools/tracker";
import { deleteLogEntriesTool, setLogDatesTool } from "@/lib/server/ai/tools/dailyLog";
import { updateOrderTool } from "@/lib/server/ai/tools/orders";
import { AI_TOOLS, checkToolInput, writeToolNamed } from "@/lib/server/ai/tools";

const ctx: ToolCtx = { user: { id: 1, name: "Sara" } as User, hidden: new Set(), now: new Date(), todayISO: "2026-10-12", conversationId: 1, automationId: null };
const order = (mo: string, o: Record<string, unknown> = {}) => ({
  mo, bom: "12011E16M13", line: "TR", status: "open", planQty: 10, holdAt: null, holdNote: null, priority: false,
  fins: null, colorRal: null, crcSize: null, sfm: null, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, excludedItems: null, includedItems: null, kva: "1000", rating: null,
  ...o,
});
const fdOf = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.checkOutputChain.mockResolvedValue(null);
  h.getSettings.mockResolvedValue({ tankTracking: false });
  for (const f of Object.values(h.actions)) f.mockResolvedValue({ ok: true });
});

describe("the registry", () => {
  it("has unique names, a description, and every required field in its schema", () => {
    const names = AI_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of AI_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      for (const r of t.schema.required ?? []) expect(t.schema.properties, `${t.name}.${r}`).toHaveProperty(r);
    }
  });
});

describe("update_order", () => {
  const admin: ToolCtx = { ...ctx, user: { id: 1, name: "Sara", isAdmin: true } as User };
  const row = {
    ...order("SF01/MO/1"), id: 4, soi: null, customer: "EEHC", fgCode: null, remarks: null, product: null, secItem: null, materialsRemarks: null,
    ospEncloser: 0, urgent: false, updatedAt: new Date("2026-10-20T08:00:00.000Z"),
  };
  it("posts the registry's own form with the row's updatedAt, so the edit lands only on the row as read", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue(row);
    const input = checkToolInput(updateOrderTool, { mo: "SF01/MO/1", customer: "SEC" });
    if (!input.ok) throw new Error(input.error);
    const d = await updateOrderTool.describe(input.input, admin);
    expect(d).toMatchObject({ changes: [{ label: "SF01/MO/1 Customer", before: "EEHC", after: "SEC" }], snapshot: expect.objectContaining({ updatedAt: "2026-10-20T08:00:00.000Z" }) });
    const out = await updateOrderTool.execute(input.input, admin);
    expect(out).toMatchObject({ ok: true, undo: { tool: "update_order", input: { mo: "SF01/MO/1", customer: "EEHC" } } });
    expect(fdOf(h.actions.updateOrder)).toMatchObject({ mo: "SF01/MO/1", customer: "SEC", bom: "12011E16M13", planQty: "10", urgent: "false", updatedAt: "2026-10-20T08:00:00.000Z" });
  });
  it("passes the action's refusal on when the row moved under it", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue(row);
    h.actions.updateOrder.mockResolvedValue({ ok: false, error: "This order was changed by someone else meanwhile — reload and try again." });
    expect(await updateOrderTool.execute({ mo: "SF01/MO/1", customer: "SEC" }, admin)).toEqual({ ok: false, error: expect.stringContaining("changed by someone else") });
  });
});

describe("record_lv_bom_total", () => {
  // two panel orders of one BOM: P1 bent 5 / welded 3, P2 bent 4 / welded 0
  const panels = [
    { mo: "P1", bom: "LVB", line: "LV", planQty: 5 },
    { mo: "P2", bom: "LVB", line: "LV", planQty: 5 },
  ];
  const sums = [
    { mo: "P1", dept: "Punching", _sum: { qty: 5 } }, { mo: "P1", dept: "Bending", _sum: { qty: 5 } }, { mo: "P1", dept: "Welding", _sum: { qty: 3 } },
    { mo: "P2", dept: "Punching", _sum: { qty: 4 } }, { mo: "P2", dept: "Bending", _sum: { qty: 4 } },
  ];
  const input = { stage: "Welding" as const, bom: "LVB", mos: ["P1", "P2"], total: 7 };

  beforeEach(() => {
    h.prisma.masterOrder.findMany.mockResolvedValue(panels);
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums);
  });

  it("spreads the group's new total over its MOs in order, as the LV tracker's group row does", async () => {
    expect(await recordLvBomTotalTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("permission") });
    h.perms.add("lv.welding");
    const p = await recordLvBomTotalTool.describe(input, ctx);
    expect(p).toMatchObject({
      title: "LVB LV Welding: 3 → 7",
      changes: [{ label: "P1 Welding", before: "3", after: "5 (+2 today)" }, { label: "P2 Welding", before: "0", after: "2 (+2 today)" }],
    });
    // more than the stage before has finished is refused whole
    expect(await recordLvBomTotalTool.describe({ ...input, total: 10 }, ctx)).toEqual({ error: expect.stringContaining("Only 9 fit") });
    expect(await recordLvBomTotalTool.describe({ ...input, total: 3 }, ctx)).toEqual({ error: "The group total is 3 already." });
    // an MO of another BOM is not in the group
    h.prisma.masterOrder.findMany.mockResolvedValue([panels[0], { ...panels[1], bom: "OTHER" }]);
    expect(await recordLvBomTotalTool.describe(input, ctx)).toEqual({ error: "P2 is not on BOM LVB." });
  });

  it("runs the group row's own action and is undone MO by MO", async () => {
    h.perms.add("lv.welding");
    h.prisma.handoverEntry.groupBy.mockResolvedValueOnce(sums).mockResolvedValueOnce([
      ...sums.filter((x) => x.dept !== "Welding"), { mo: "P1", dept: "Welding", _sum: { qty: 5 } }, { mo: "P2", dept: "Welding", _sum: { qty: 2 } },
    ]);
    const out = await recordLvBomTotalTool.execute(input, ctx);
    expect(fdOf(h.actions.recordLvGroupTotal)).toEqual({ stage: "Welding", bom: "LVB", mos: "P1,P2", total: "7" });
    expect(out).toEqual({ ok: true, message: "Recorded LVB LV Welding total 7.", undo: { tool: "record_lv_totals", input: { stage: "Welding", totals: [{ mo: "P1", total: 3 }, { mo: "P2", total: 0 }] } } });
  });
});

describe("set_order_hold", () => {
  it("lists what changes, skips closed orders, and runs the tracker's own hold", async () => {
    h.perms.add("tracker.status");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A"), order("B", { status: "closed" })]);
    const p = await setOrderHoldTool.describe({ mos: ["A", "B"], hold: true, note: "no steel" }, ctx);
    expect(p).toMatchObject({ title: "Hold A", changes: [{ label: "A", before: "running", after: "on hold — no steel" }] });
    expect("summary" in p && p.summary).toContain("1 closed order(s) skipped");
    const out = await setOrderHoldTool.execute({ mos: ["A", "B"], hold: true, note: "no steel" }, ctx);
    expect(fdOf(h.actions.setOrderHold)).toEqual({ mos: "A", hold: "true", note: "no steel" });
    expect(out.undo).toEqual({ tool: "set_order_hold", input: { mos: ["A"], hold: false } });
  });

  it("undoes a note change by re-holding with the earlier note, and has no undo for a mixed set", async () => {
    h.perms.add("tracker.status");
    // A was already on hold for steel; the assistant changes the reason
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { holdAt: new Date("2026-10-01T00:00:00Z"), holdNote: "no steel" })]);
    const renote = await setOrderHoldTool.execute({ mos: ["A"], hold: true, note: "waiting paint" }, ctx);
    expect(renote.undo).toEqual({ tool: "set_order_hold", input: { mos: ["A"], hold: true, note: "no steel" } });
    // A held, B running: one call cannot put both back
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { holdAt: new Date("2026-10-01T00:00:00Z"), holdNote: "no steel" }), order("B")]);
    const mixed = await setOrderHoldTool.execute({ mos: ["A", "B"], hold: true, note: "waiting paint" }, ctx);
    expect(mixed.ok).toBe(true);
    expect(mixed.undo).toBeUndefined();
  });

  it("is refused without the line's close/hold permission", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { line: "LV" })]);
    h.perms.add("tracker.status"); // the transformer key, not lv.status
    expect(await setOrderHoldTool.describe({ mos: ["A"], hold: true }, ctx)).toHaveProperty("error");
  });

  it("names the MOs that are not in the registry", async () => {
    h.perms.add("tracker.status");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A")]);
    expect(await setOrderHoldTool.describe({ mos: ["A", "ZZ"], hold: true }, ctx)).toEqual({ error: "Not in the orders registry: ZZ. Check the MO numbers." });
  });
});

describe("set_order_status", () => {
  it("is high risk to close, and undone by reopening what it closed", async () => {
    h.perms.add("tracker.status");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A"), order("B", { status: "closed" })]);
    expect(typeof setOrderStatusTool.risk === "function" && setOrderStatusTool.risk({ mos: ["A"], status: "closed" })).toBe("high");
    const out = await setOrderStatusTool.execute({ mos: ["A", "B"], status: "closed" }, ctx);
    expect(h.actions.setOrderStatus).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, undo: { tool: "set_order_status", input: { mos: ["A"], status: "open" } } });
  });
});

describe("set_order_specs", () => {
  it("writes each cell through the tracker's action and keeps the old values to put back", async () => {
    h.perms.add("tracker.qty");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { colorRal: "7035" }), order("B")]);
    const input = { changes: [{ mo: "A", field: "colorRal" as const, value: "7032" }, { mo: "B", field: "sfm" as const, value: "Y" }] };
    const p = await setOrderSpecsTool.describe(input, ctx);
    expect("changes" in p && p.changes).toEqual([
      { label: "A Colour", before: "7035", after: "7032" },
      { label: "B SFM", before: "—", after: "Y" },
    ]);
    const out = await setOrderSpecsTool.execute(input, ctx);
    expect(h.actions.setOrderSpec).toHaveBeenCalledTimes(2);
    expect(out.undo).toEqual({ tool: "set_order_specs", input: { changes: [{ mo: "A", field: "colorRal", value: "7035" }, { mo: "B", field: "sfm", value: "" }] } });
  });
});

describe("record_stage_totals", () => {
  beforeEach(() => {
    h.perms.add("welding.edit");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A"), order("B")]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: "A", _sum: { qty: 4 } }]);
  });

  it("shows the totals and today's difference, checks the chain, and files them under the order's BOM", async () => {
    const input = { dept: "Welding" as const, item: "TN" as const, totals: [{ mo: "A", total: 6 }, { mo: "B", total: 2 }] };
    const p = await recordStageTotalsTool.describe(input, ctx);
    expect("changes" in p && p.changes).toEqual([
      { label: "A TN Welding", before: "4", after: "6 (+2 today)" },
      { label: "B TN Welding", before: "0", after: "2 (+2 today)" },
    ]);
    expect(h.checkOutputChain).toHaveBeenCalledWith({ dept: "Welding", bom: "12011E16M13", mo: "A", item: "TN", qty: 2 });
    const out = await recordStageTotalsTool.execute(input, ctx);
    expect(fdOf(h.actions.recordTrackerTotal)).toEqual({ dept: "Welding", bom: "12011E16M13", mo: "A", item: "TN", total: "6" });
    expect(out.undo).toEqual({ tool: "record_stage_totals", input: { dept: "Welding", item: "TN", totals: [{ mo: "A", total: 4 }, { mo: "B", total: 0 }] } });
  });

  it("says what the chain says, and refuses shot blast on a painted part", async () => {
    h.checkOutputChain.mockResolvedValue("Chain check: A TN would have 9 welded but only 8 cut");
    expect(await recordStageTotalsTool.describe({ dept: "Welding", item: "TN", totals: [{ mo: "A", total: 9 }] }, ctx)).toEqual({ error: "Chain check: A TN would have 9 welded but only 8 cut" });
    h.perms.add("tracker.shp");
    expect(await recordStageTotalsTool.describe({ dept: "ShotBlast", item: "TN", totals: [{ mo: "A", total: 1 }] }, ctx)).toHaveProperty("error");
  });

  it("refuses an MO listed twice", () => {
    expect(checkToolInput(recordStageTotalsTool, { dept: "Welding", item: "TN", totals: [{ mo: "A", total: 1 }, { mo: "A", total: 2 }] })).toEqual({ ok: false, error: "totals: an MO is listed twice." });
  });

  it("names the order that changes in the headline, not the first one listed", async () => {
    // A reads 4 already; only B moves
    const p = await recordStageTotalsTool.describe({ dept: "Welding", item: "TN", totals: [{ mo: "A", total: 4 }, { mo: "B", total: 2 }] }, ctx);
    expect(p).toMatchObject({ title: "B TN Welding: 0 → 2", summary: expect.stringContaining("B 0 → 2") });
    expect("summary" in p && p.summary).not.toContain("A 4");
  });

  it("refuses painting the core frame, as the tracker cell does", async () => {
    h.perms.add("painting.edit");
    expect(await recordStageTotalsTool.describe({ dept: "Painting", item: "CF", totals: [{ mo: "A", total: 1 }] }, ctx)).toEqual({ error: "CF is shot blasted, not painted — record it on the SHB cell." });
  });
});

describe("record_bom_total", () => {
  it("spreads the change over the MOs as the tracker does, and is undone MO by MO", async () => {
    h.perms.add("cut.edit");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { planQty: 5 }), order("B", { planQty: 5 })]);
    h.prisma.handoverEntry.groupBy.mockResolvedValueOnce([{ mo: "A", dept: "Cut", _sum: { qty: 3 } }]);
    const input = { dept: "Cut" as const, bom: "12011E16M13", item: "TC" as const, mos: ["A", "B"], total: 7 };
    const p = await recordBomTotalTool.describe(input, ctx);
    // A fills to its 5 first, then B takes the rest
    expect("changes" in p && p.changes).toEqual([
      { label: "A TC Cut", before: "3", after: "5 (+2 today)" },
      { label: "B TC Cut", before: "0", after: "2 (+2 today)" },
    ]);
    h.prisma.handoverEntry.groupBy
      .mockResolvedValueOnce([{ mo: "A", dept: "Cut", _sum: { qty: 3 } }])
      .mockResolvedValueOnce([{ mo: "A", _sum: { qty: 5 } }, { mo: "B", _sum: { qty: 2 } }]);
    const out = await recordBomTotalTool.execute(input, ctx);
    expect(fdOf(h.actions.recordGroupOutput)).toMatchObject({ source: "tracker", dept: "Cut", bom: "12011E16M13", item: "TC", mos: "A,B", total: "7" });
    expect(out.undo).toEqual({ tool: "record_stage_totals", input: { dept: "Cut", item: "TC", totals: [{ mo: "A", total: 3 }, { mo: "B", total: 0 }] } });
  });

  it("refuses an MO the orders registry does not hold — it has no quantity to bound it — on the card and when run", async () => {
    h.perms.add("cut.edit");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { planQty: 5 })]);
    // G is known to the Daily log, so it is a member — but no registry order bounds it
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: "G", dept: "Cut", _sum: { qty: 2 } }]);
    const input = { dept: "Cut" as const, bom: "12011E16M13", item: "TC" as const, mos: ["A", "G"], total: 9 };
    expect(await recordBomTotalTool.describe(input, ctx)).toEqual({ error: "Not in the orders registry: G. Check the MO numbers." });
    expect(await recordBomTotalTool.execute(input, ctx)).toEqual({ ok: false, error: "Not in the orders registry: G." });
    expect(h.actions.recordGroupOutput).not.toHaveBeenCalled();
  });

  it("says how much fits when the total does not", async () => {
    h.perms.add("cut.edit");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { planQty: 5 })]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
    expect(await recordBomTotalTool.describe({ dept: "Cut", bom: "12011E16M13", item: "TC", mos: ["A"], total: 9 }, ctx)).toEqual({ error: "Only 5 more pieces fit on these orders (the chain and the order quantities)." });
  });

  it("snapshots everything the spread reads — an order's outsourced share and N/A tick included — and refuses a panel order", async () => {
    h.perms.add("cut.edit");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { planQty: 5, ospTC: 2 }), order("B", { planQty: 5, excludedItems: "TC" })]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
    const p = await recordBomTotalTool.describe({ dept: "Cut", bom: "12011E16M13", item: "TC", mos: ["A", "B"], total: 3 }, ctx);
    expect("snapshot" in p && p.snapshot).toEqual([
      { mo: "A", cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, planQty: 5, osp: 2, eligible: true },
      { mo: "B", cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, planQty: 5, osp: 0, eligible: false },
    ]);
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { planQty: 5 }), order("P1", { line: "LV", planQty: 5 })]);
    expect(await recordBomTotalTool.describe({ dept: "Cut", bom: "12011E16M13", item: "TC", mos: ["A", "P1"], total: 3 }, ctx)).toEqual({ error: "P1 is an LV panel order — use record_lv_bom_total." });
  });
});

describe("push_to_worklist", () => {
  const pushed = { item: "TC", qty: 3, baseDone: 1, createdBy: "Sara", createdAt: new Date("2026-10-01T00:00:00Z") };
  const pushedThen = JSON.stringify([{ item: "TC", qty: 3, baseDone: 1, createdBy: "Sara", createdAt: "2026-10-01T00:00:00.000Z" }]);

  it("clearing a push is a success when the push is gone, whatever the action's words — undone by the rows as they were", async () => {
    h.perms.add("tracker.push");
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("A"));
    h.prisma.worklistPush.findMany.mockResolvedValue([pushed]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
    h.prisma.worklistPush.count.mockResolvedValue(0);
    h.actions.pushOrderToWorklist.mockResolvedValue({ ok: false, error: "Nothing sent — … (the Cut push was cleared)." });
    const out = await pushToWorklistTool.execute({ mo: "A", dept: "Cut", qty: {} }, ctx);
    // the undo writes the rows back with the output already counted against them (baseDone), not a fresh push
    expect(out).toMatchObject({ ok: true, undo: { tool: "restore_worklist_push", input: { mo: "A", dept: "Cut", rows: pushedThen } } });
    expect(restoreWorklistPushTool.parse!({ mo: "A", dept: "Cut", rows: pushedThen })).toMatchObject({ mo: "A" });
    expect(typeof restoreWorklistPushTool.parse!({ mo: "A", dept: "Cut", rows: "[{\"item\":\"TC\"}]" })).toBe("string");
    const p = await restoreWorklistPushTool.describe({ mo: "A", dept: "Cut", rows: pushedThen }, ctx);
    expect(p).toMatchObject({ title: "Put A's push to Cut back", changes: [{ label: "A → Cut", before: "3 TC", after: "3 TC" }] });
  });

  it("its undo writes the rows back through the push permission, and an MO gone from the registry is refused", async () => {
    const out = { mo: "A", dept: "Cut" as const, rows: pushedThen };
    expect(await restoreWorklistPushTool.execute(out, ctx)).toEqual({ ok: false, error: "You do not have permission to do this." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    h.perms.add("tracker.push");
    h.prisma.masterOrder.findUnique.mockResolvedValue(null);
    expect(await restoreWorklistPushTool.execute(out, ctx)).toEqual({ ok: false, error: "MO A is not in the orders registry." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("A"));
    expect(await restoreWorklistPushTool.execute(out, ctx)).toEqual({ ok: true, message: "A's push to Cut is back as it was." });
    expect(h.tx.worklistPush.deleteMany).toHaveBeenCalledWith({ where: { dept: "Cut", mo: "A" } });
    expect(h.tx.worklistPush.createMany).toHaveBeenCalledWith({
      data: [{ dept: "Cut", bom: "12011E16M13", mo: "A", item: "TC", qty: 3, baseDone: 1, createdBy: "Sara", createdAt: new Date("2026-10-01T00:00:00.000Z") }],
    });
  });

  it("refuses more than the department still owes", async () => {
    h.perms.add("tracker.push");
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("A"));
    h.prisma.worklistPush.findMany.mockResolvedValue([]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ item: "TC", _sum: { qty: 8 } }]);
    expect(await pushToWorklistTool.describe({ mo: "A", dept: "Cut", qty: { TC: 5 } }, ctx)).toEqual({ error: "TC: only 2 still owed by Cut — cannot send 5." });
  });

  it("is a quantity when pieces are sent — it waits for the click — and low only when clearing; a panel order is refused", async () => {
    const risk = pushToWorklistTool.risk as (i: { mo: string; dept: "Cut"; qty: Record<string, number> }) => string;
    expect(risk({ mo: "A", dept: "Cut", qty: { TC: 5 } })).toBe("high");
    expect(risk({ mo: "A", dept: "Cut", qty: {} })).toBe("low");
    expect(risk({ mo: "A", dept: "Cut", qty: { TC: 0 } })).toBe("low");
    h.perms.add("tracker.push");
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("P1", { line: "LV" }));
    expect(await pushToWorklistTool.describe({ mo: "P1", dept: "Cut", qty: { TC: 1 } }, ctx)).toEqual({ error: "P1 is an LV panel order — panels are not pushed to the transformer worklists." });
  });
});

describe("the Daily log", () => {
  const row = (id: number, o: Record<string, unknown> = {}) => ({ id, date: new Date("2026-10-10T00:00:00Z"), dept: "Welding", bom: "B", mo: "A", item: "TN", qty: 3, createdBy: "Ali", createdAt: new Date(), updatedAt: new Date(), ...o });

  it("deleting is a deletion, checked for the batch as a whole, the rows kept in the snapshot", async () => {
    h.perms.add("welding.edit");
    h.prisma.handoverEntry.findMany.mockResolvedValue([row(5), row(6)]);
    expect(deleteLogEntriesTool.risk).toBe("destructive");
    const p = await deleteLogEntriesTool.describe({ ids: [5, 6] }, ctx);
    expect(h.checkOutputChain).toHaveBeenCalledTimes(1);
    expect(h.checkOutputChain).toHaveBeenCalledWith(expect.objectContaining({ qty: 0, excludeIds: [5, 6] }));
    expect("snapshot" in p && (p.snapshot as { id: number }[]).map((r) => r.id)).toEqual([5, 6]);
    await deleteLogEntriesTool.execute({ ids: [5, 6] }, ctx);
    expect(fdOf(h.actions.bulkDeleteHandover)).toEqual({ ids: "5,6" });
    expect(writeToolNamed("delete_log_entries")).toBe(deleteLogEntriesTool);
  });

  it("moving rows calls the log's action once per day, and puts each back on its own day", async () => {
    h.perms.add("welding.edit");
    h.prisma.handoverEntry.findMany.mockResolvedValue([row(5), row(6, { date: new Date("2026-10-09T00:00:00Z") })]);
    const out = await setLogDatesTool.execute({ items: [{ id: 5, date: "2026-10-11" }, { id: 6, date: "2026-10-11" }] }, ctx);
    expect(h.actions.bulkSetHandoverDate).toHaveBeenCalledTimes(1);
    expect(fdOf(h.actions.bulkSetHandoverDate)).toEqual({ date: "2026-10-11", ids: "5,6" });
    expect(out.undo).toEqual({ tool: "set_log_dates", input: { items: [{ id: 5, date: "2026-10-10" }, { id: 6, date: "2026-10-09" }] } });
  });
});

describe("set_order_qty", () => {
  it("warns only when ONE component's stage total is above the new quantity — not the sum over components", async () => {
    h.perms.add("tracker.qty");
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("A", { planQty: 10 }));
    // four components at Cut, 3 each: 12 in all, but no component is above 3
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { dept: "Cut", item: "CF", _sum: { qty: 3 } }, { dept: "Cut", item: "TC", _sum: { qty: 3 } }, { dept: "Cut", item: "TN", _sum: { qty: 3 } }, { dept: "Cut", item: "CB", _sum: { qty: 3 } },
    ]);
    const raise = await setOrderQtyTool.describe({ mo: "A", qty: 11 }, ctx);
    expect("changes" in raise && raise.changes).toEqual([{ label: "A required", before: "10", after: "11" }]);
    expect(h.prisma.handoverEntry.groupBy.mock.calls[0][0]).toMatchObject({ by: ["dept", "item"] });
    const lower = await setOrderQtyTool.describe({ mo: "A", qty: 2 }, ctx);
    expect("changes" in lower && lower.changes).toEqual([{ label: "A required", before: "10", after: "2" }, { label: "⚠ already recorded at a stage", before: "3", after: "more than the order" }]);
  });
});
