import { beforeEach, describe, expect, it, vi } from "vitest";

// The Orders Registry's own actions (app/orders/actions.ts): a bulk close
// records the same order.closed event a close on the tracker does, the
// monthly import says which orders it closed, and a row edit only lands on
// the row as it was read — against a stubbed database.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = { worklistPush: { deleteMany: fn(), createMany: fn() } };
  return {
    tx,
    prisma: {
      masterOrder: { findUnique: fn(), findMany: fn(), update: fn(), updateMany: fn() },
      handoverEntry: { groupBy: fn() },
      $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)),
    },
    emitEvent: fn(),
    guard: fn(),
    getActiveLine: fn(),
    fullyDeliveredOpenOrders: fn(),
    importMonthlyPlan: fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/events", () => ({
  emitEvent: h.emitEvent,
  listed: (items: readonly string[], max = 3) => (items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`),
}));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.guard, requireAdmin: h.guard, getCurrentUser: vi.fn(), hasPerm: () => true }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: h.getActiveLine }));
vi.mock("@/lib/server/deliveredOrders", () => ({ fullyDeliveredOpenOrders: h.fullyDeliveredOpenOrders }));
vi.mock("@/lib/server/orderDelete", () => ({ orderDeletePreview: vi.fn() }));
vi.mock("@/lib/server/importMonthly", () => ({ importMonthlyPlan: h.importMonthlyPlan }));

import { closeDeliveredOrders, importMonthlyAction, pushOrderToWorklist, updateOrder } from "@/app/orders/actions";

const SEEN = new Date("2026-10-20T08:00:00.000Z");
const order = {
  mo: "SF01/MO/1", bom: "12011E16M13", planQty: 10, urgent: false, soi: null, customer: "EEHC", fgCode: null, kva: "1000", rating: null,
  colorRal: null, remarks: null, product: null, secItem: null, materialsRemarks: null, ospEncloser: 0, updatedAt: SEEN,
};
const editForm = (extra: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ mo: order.mo, bom: order.bom, planQty: "12", customer: "SEC", kva: "1000", ...extra })) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({ user: { id: 1, name: "Sara", isAdmin: true } });
  h.getActiveLine.mockResolvedValue("TR");
  h.prisma.masterOrder.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.masterOrder.findUnique.mockResolvedValue(order);
});

describe("closeDeliveredOrders", () => {
  it("records one order.closed event naming the orders it closed", async () => {
    h.fullyDeliveredOpenOrders.mockResolvedValue([{ mo: "SF01/MO/1" }, { mo: "SF01/MO/2" }]);
    expect(await closeDeliveredOrders()).toEqual({ ok: true, closed: 2, mos: ["SF01/MO/1", "SF01/MO/2"] });
    expect(h.prisma.masterOrder.updateMany).toHaveBeenCalledWith({
      where: { mo: { in: ["SF01/MO/1", "SF01/MO/2"] } },
      data: { status: "closed", closedAt: expect.any(Date) },
    });
    expect(h.emitEvent).toHaveBeenCalledTimes(1);
    expect(h.emitEvent).toHaveBeenCalledWith({
      type: "order.closed",
      subject: "SF01/MO/1, SF01/MO/2",
      summary: "Closed SF01/MO/1, SF01/MO/2 — fully delivered",
      data: { mos: ["SF01/MO/1", "SF01/MO/2"], reason: "delivered" },
    });
  });

  it("records nothing when there is nothing to close", async () => {
    h.fullyDeliveredOpenOrders.mockResolvedValue([]);
    expect(await closeDeliveredOrders()).toEqual({ ok: true, closed: 0, mos: [] });
    expect(h.prisma.masterOrder.updateMany).not.toHaveBeenCalled();
    expect(h.emitEvent).not.toHaveBeenCalled();
  });
});

describe("importMonthlyAction", () => {
  const importForm = (preview = false) => {
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1, 2, 3])], "plan.xlsx"));
    fd.set("month", "2026-10");
    fd.set("missing", "takeOut");
    if (preview) fd.set("preview", "on");
    return fd;
  };

  it("records the import and, as a close, the orders it took out with history behind them", async () => {
    h.importMonthlyPlan.mockResolvedValue({
      ok: true, added: 3, updatedMos: 1, preview: false,
      removed: [{ mo: "SF01/MO/7", action: "closed" }, { mo: "SF01/MO/8", action: "deleted" }, { mo: "SF01/MO/9", action: "closed" }],
    });
    expect(await importMonthlyAction(importForm())).toMatchObject({ ok: true, added: 3 });
    expect(h.emitEvent).toHaveBeenCalledTimes(2);
    expect(h.emitEvent.mock.calls[0][0]).toMatchObject({ type: "plan.imported", data: { kind: "monthly", month: "October 2026", removed: 3 } });
    expect(h.emitEvent.mock.calls[1][0]).toEqual({
      type: "order.closed",
      subject: "SF01/MO/7, SF01/MO/9",
      summary: "Closed SF01/MO/7, SF01/MO/9 — not on the October 2026 plan any more",
      data: { mos: ["SF01/MO/7", "SF01/MO/9"], reason: "import" },
    });
  });

  it("records no close when nothing was closed, and nothing at all for a preview", async () => {
    h.importMonthlyPlan.mockResolvedValue({ ok: true, added: 1, updatedMos: 0, preview: false, removed: [{ mo: "SF01/MO/8", action: "deleted" }] });
    await importMonthlyAction(importForm());
    expect(h.emitEvent).toHaveBeenCalledTimes(1);
    expect(h.emitEvent.mock.calls[0][0]).toMatchObject({ type: "plan.imported" });

    h.emitEvent.mockClear();
    h.importMonthlyPlan.mockResolvedValue({ ok: true, added: 1, preview: true, removed: [{ mo: "SF01/MO/7", action: "closed" }] });
    await importMonthlyAction(importForm(true));
    expect(h.emitEvent).not.toHaveBeenCalled();
  });
});

describe("updateOrder", () => {
  it("writes only while the row still reads as the form saw it", async () => {
    expect(await updateOrder(editForm({ updatedAt: SEEN.toISOString() }))).toEqual({ ok: true });
    expect(h.prisma.masterOrder.updateMany).toHaveBeenCalledTimes(1);
    const call = h.prisma.masterOrder.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ mo: order.mo, updatedAt: SEEN });
    expect(call.data).toMatchObject({ bom: order.bom, planQty: 12, customer: "SEC", kva: "1000", urgent: false, remarks: null });
    expect(h.prisma.masterOrder.update).not.toHaveBeenCalled();
  });

  it("refuses a save from a row someone else changed meanwhile", async () => {
    h.prisma.masterOrder.updateMany.mockResolvedValue({ count: 0 });
    expect(await updateOrder(editForm({ updatedAt: new Date("2026-10-20T07:00:00.000Z").toISOString() }))).toEqual({
      ok: false,
      error: "This order was changed by someone else meanwhile — reload and try again.",
    });
    expect(h.prisma.masterOrder.update).not.toHaveBeenCalled();
    // a form whose stamp is not a date is from a broken page: refused, nothing written
    h.prisma.masterOrder.updateMany.mockClear();
    expect(await updateOrder(editForm({ updatedAt: "yesterday" }))).toEqual({ ok: false, error: "This page is out of date — reload and try again." });
    expect(h.prisma.masterOrder.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an over-long text field in the planner's words, writing nothing", async () => {
    expect(await updateOrder(editForm({ materialsRemarks: "x".repeat(401) }))).toEqual({ ok: false, error: "Keep Materials remarks under 400 characters." });
    expect(h.prisma.masterOrder.updateMany).not.toHaveBeenCalled();
  });

  it("a form without the stamp (an older page) writes as before", async () => {
    expect(await updateOrder(editForm())).toEqual({ ok: true });
    expect(h.prisma.masterOrder.updateMany.mock.calls[0][0].where).toEqual({ mo: order.mo });
  });
});

describe("pushOrderToWorklist", () => {
  const pushForm = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ mo: "P1", dept: "Cut", qtyTC: "3" })) fd.set(k, v);
    return fd;
  };
  const open = (o: Record<string, unknown>) => ({ ...order, mo: "P1", status: "open", line: "TR", ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, excludedItems: null, includedItems: null, ...o });

  it("refuses an LV panel order and writes no push", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue(open({ line: "LV" }));
    expect(await pushOrderToWorklist(pushForm())).toEqual({ ok: false, error: "MO P1 is an LV panel order — panels are not pushed to the transformer worklists." });
    expect(h.guard).toHaveBeenCalledWith("tracker.push");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.worklistPush.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.worklistPush.createMany).not.toHaveBeenCalled();
  });

  it("pushes a transformer order's pieces (the same form, so the refusal above is the line's)", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue(open({}));
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ item: "TC", _sum: { qty: 2 } }]);
    expect(await pushOrderToWorklist(pushForm())).toEqual({ ok: true });
    expect(h.tx.worklistPush.deleteMany).toHaveBeenCalledWith({ where: { dept: "Cut", mo: "P1" } });
    expect(h.tx.worklistPush.createMany).toHaveBeenCalledWith({
      data: [{ dept: "Cut", bom: "12011E16M13", mo: "P1", item: "TC", qty: 3, baseDone: 2, createdBy: "Sara" }],
    });
  });
});
