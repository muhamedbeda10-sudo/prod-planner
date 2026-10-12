import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's Plan Tracker and Daily log tools: what each one's card says
// (before → after), which of the app's own actions it runs with what, and how
// it is undone — against a stubbed database and stubbed actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findMany: fn(), findUnique: fn() },
      handoverEntry: { groupBy: fn(), findUnique: fn(), findMany: fn() },
      worklistPush: { findMany: fn(), count: fn() },
    },
    perms: new Set<string>(),
    actions: {
      setOrderStatus: fn(), setOrderQty: fn(), decidePlanQty: fn(), setOrderSpec: fn(), setGroupOrderSpec: fn(),
      setOrderPriority: fn(), setOrderHold: fn(), pushOrderToWorklist: fn(), setExcludedItems: fn(), closeDeliveredOrders: fn(),
      recordTrackerTotal: fn(), recordGroupOutput: fn(), recordLvTotal: fn(),
      updateHandover: fn(), bulkSetHandoverDate: fn(), bulkDeleteHandover: fn(),
    },
    checkOutputChain: fn(),
    getSettings: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/line", () => ({ withLine: (_l: string, f: () => unknown) => f() }));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: vi.fn() }));
vi.mock("@/lib/server/lvTracker", () => ({ getLvTracker: vi.fn() }));
vi.mock("@/lib/server/data", () => ({ getSettings: h.getSettings }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain }));
vi.mock("@/lib/server/deliveredOrders", () => ({ fullyDeliveredOpenOrders: vi.fn() }));
vi.mock("@/app/orders/actions", () => h.actions);
vi.mock("@/app/worklist/actions", () => h.actions);
vi.mock("@/app/lv/actions", () => h.actions);
vi.mock("@/app/handover/actions", () => h.actions);

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import {
  pushToWorklistTool, recordBomTotalTool, recordStageTotalsTool, setOrderHoldTool, setOrderSpecsTool, setOrderStatusTool,
} from "@/lib/server/ai/tools/tracker";
import { deleteLogEntriesTool, setLogDatesTool } from "@/lib/server/ai/tools/dailyLog";
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
    h.perms.add("tracker.weld");
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
});

describe("record_bom_total", () => {
  it("spreads the change over the MOs as the tracker does, and is undone MO by MO", async () => {
    h.perms.add("tracker.cut");
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

  it("says how much fits when the total does not", async () => {
    h.perms.add("tracker.cut");
    h.prisma.masterOrder.findMany.mockResolvedValue([order("A", { planQty: 5 })]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
    expect(await recordBomTotalTool.describe({ dept: "Cut", bom: "12011E16M13", item: "TC", mos: ["A"], total: 9 }, ctx)).toEqual({ error: "Only 5 more pieces fit on these orders (the chain and the order quantities)." });
  });
});

describe("push_to_worklist", () => {
  it("clearing a push is a success when the push is gone, whatever the action's words", async () => {
    h.perms.add("tracker.push");
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("A"));
    h.prisma.worklistPush.findMany.mockResolvedValue([{ item: "TC", qty: 3 }]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
    h.prisma.worklistPush.count.mockResolvedValue(0);
    h.actions.pushOrderToWorklist.mockResolvedValue({ ok: false, error: "Nothing sent — … (the Cut push was cleared)." });
    const out = await pushToWorklistTool.execute({ mo: "A", dept: "Cut", qty: {} }, ctx);
    expect(out).toMatchObject({ ok: true, undo: { tool: "push_to_worklist", input: { mo: "A", dept: "Cut", qty: { TC: 3 } } } });
  });

  it("refuses more than the department still owes", async () => {
    h.perms.add("tracker.push");
    h.prisma.masterOrder.findUnique.mockResolvedValue(order("A"));
    h.prisma.worklistPush.findMany.mockResolvedValue([]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ item: "TC", _sum: { qty: 8 } }]);
    expect(await pushToWorklistTool.describe({ mo: "A", dept: "Cut", qty: { TC: 5 } }, ctx)).toEqual({ error: "TC: only 2 still owed by Cut — cannot send 5." });
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
