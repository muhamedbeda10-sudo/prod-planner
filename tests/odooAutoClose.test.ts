import { beforeEach, describe, expect, it, vi } from "vitest";

// Orders that close by themselves once they are finished and Odoo has closed
// all they need (lib/server/odooAutoClose.ts), read off the Plan Tracker's own
// rows (the rule itself is tested in lib/domain/trackerOdoo.test.ts): one at
// a time, each only while it still reads open, not reopened by hand, not on
// hold and with no plan qty waiting.

const h = vi.hoisted(() => ({
  prisma: { masterOrder: { updateMany: vi.fn() } },
  rows: [] as unknown[],
  lines: [] as string[],
  emit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/events", () => ({ emitEvent: h.emit, listed: (xs: string[]) => xs.join(", ") }));
vi.mock("@/lib/server/line", () => ({ withLine: (l: string, f: () => unknown) => { h.lines.push(l); return f(); } }));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: async () => h.rows }));

import { closeOrdersClosedInOdoo, finishedAndClosedInOdooOf, settleOrdersAfterOdoo } from "@/lib/server/odooAutoClose";

// an order of 2 needing its tank and top cover (core frame and cable box N/A)
const item = (o: Record<string, unknown> = {}) => ({ cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true, odooClosed: 0, odooTracked: true, ...o });
const row = (o: { mo?: string; status?: string; tc?: number; onHold?: boolean } = {}) => ({
  mo: o.mo ?? "MO-1", required: 2, complete: 2, status: o.status ?? "open",
  hold: { onHold: o.onHold ?? false, holdNote: null, holdSinceISO: null, holdBy: null }, pendingQty: null,
  items: { TN: item({ odooClosed: 2 }), TC: item({ odooClosed: o.tc ?? 2 }), CF: item({ excluded: true }), CB: item({ excluded: true }), AR: item({ eligible: false }), MB: item({ eligible: false }) },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.lines = [];
  h.prisma.masterOrder.updateMany.mockResolvedValue({ count: 1 });
});

describe("closeOrdersClosedInOdoo", () => {
  it("closes the transformer orders Odoo has closed in full, stamping that it did, and says so once", async () => {
    h.rows = [row(), row({ mo: "MO-2", tc: 1 }), row({ mo: "MO-3", onHold: true })];
    expect(await closeOrdersClosedInOdoo()).toEqual(["MO-1"]);
    expect(h.lines).toEqual(["TR"]);
    expect(h.prisma.masterOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.masterOrder.updateMany).toHaveBeenCalledWith({
      where: { mo: "MO-1", status: "open", autoCloseOff: false, holdAt: null, pendingPlanQty: null },
      data: { status: "closed", closedAt: expect.any(Date), autoClosedAt: expect.any(Date) },
    });
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "order.closed", subject: "MO-1", data: { mos: ["MO-1"], reason: "odoo" } }));
    expect(h.revalidate).toHaveBeenCalledWith("/tracker");
  });

  it("names only the orders it actually closed — one reopened by hand, held or closed meanwhile is left as it is", async () => {
    h.rows = [row(), row({ mo: "MO-2" })];
    h.prisma.masterOrder.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    expect(await closeOrdersClosedInOdoo()).toEqual(["MO-2"]);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ subject: "MO-2", data: { mos: ["MO-2"], reason: "odoo" } }));
  });

  it("never reopens an order — a closed one Odoo no longer has in full stays closed", async () => {
    h.rows = [row({ status: "closed", tc: 1 }), row({ mo: "MO-2", tc: 1 })];
    expect(await closeOrdersClosedInOdoo()).toEqual([]);
    expect(h.prisma.masterOrder.updateMany).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});

describe("settleOrdersAfterOdoo", () => {
  it("never fails the Odoo write it follows", async () => {
    h.prisma.masterOrder.updateMany.mockRejectedValue(new Error("db down"));
    h.rows = [row()];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(settleOrdersAfterOdoo()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("finishedAndClosedInOdooOf", () => {
  it("picks, of the orders asked about, the ones Odoo has closed in full — closed or not", async () => {
    h.rows = [row({ status: "closed" }), row({ mo: "MO-2", status: "closed", tc: 1 }), row({ mo: "MO-3" })];
    expect([...await finishedAndClosedInOdooOf(["MO-1", "MO-2"])]).toEqual(["MO-1"]);
    expect([...await finishedAndClosedInOdooOf([])]).toEqual([]);
  });
});
