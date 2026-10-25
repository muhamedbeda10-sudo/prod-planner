import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- closed and held orders leave the Welding and Painting screens --------------
// A hold "leaves every worklist queue" (lib/domain/hold.ts) and a closed order
// leaves the daily screens — the Cut sheet, the pushed and priority tables
// already drop them. These tests pin the two feeds that used to list them
// anyway: the dept queues (and so the machine boards, the Floor and the
// optimizer built on them) and the approved run order.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      worklistLineHide: { findMany: fn() },
      runOrderEntry: { findMany: fn() },
      handoverEntry: { groupBy: fn() },
    },
    loads: { loadAllSchedules: fn(), loadAllHandover: fn(), loadMasterOrders: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/loads", () => h.loads);
vi.mock("@/lib/server/data", () => ({ getSettings: async () => ({ leadCut: 2, leadWeld: 1 }), getPlanWindows: async () => [] }));

import { getPaintingQueue, getWeldingQueue } from "@/lib/server/execution";
import { getRunOrderLines } from "@/lib/server/worklistExtras";
import { utcDate } from "@/lib/domain/dates";

const DAY = utcDate(2026, 10, 25);

function order(mo: string, extra: Record<string, unknown> = {}) {
  return {
    id: 1, mo, bom: "B-1", kva: "1000", rating: null, planQty: 10, status: "open", priority: false, urgent: false,
    includedItems: null, excludedItems: null, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0,
    holdAt: null, holdNote: null, holdBy: null, ...extra,
  };
}
const sched = (mo: string, item: string, qty = 10) => ({ planNo: 40, bom: "B-1", mo, description: "1000kva", item, ovenDate: utcDate(2026, 11, 5), qty });
const log = (dept: string, mo: string | null, item: string, qty: number, bom = "B-1") => ({ planNo: 40, dept, bom, mo, item, qty, date: DAY });

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.worklistLineHide.findMany.mockResolvedValue([]);
  h.prisma.runOrderEntry.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
  h.loads.loadAllSchedules.mockResolvedValue([sched("MO-OPEN", "TN"), sched("MO-HELD", "TN"), sched("MO-CLOSED", "TN")]);
  h.loads.loadAllHandover.mockResolvedValue([
    log("Cut", "MO-OPEN", "TN", 4),
    log("Cut", "MO-HELD", "TN", 2),
    log("Cut", "MO-CLOSED", "TN", 15),
    log("Cut", null, "CB", 3, "LEGACY-CODE"), // output on a code the registry does not know — stays, at BOM level
    log("Welding", "MO-OPEN", "TN", 1),
    log("Welding", "MO-HELD", "TN", 2),
    log("Welding", "MO-CLOSED", "TN", 5),
  ]);
  h.loads.loadMasterOrders.mockResolvedValue([
    order("MO-OPEN"),
    order("MO-HELD", { id: 2, holdAt: utcDate(2026, 10, 20), holdNote: "Waiting for customer drawing", holdBy: "planner" }),
    order("MO-CLOSED", { id: 3, status: "closed" }),
  ]);
});

describe("getWeldingQueue / getPaintingQueue — only live orders are queued", () => {
  it("the welding queue lists the open order and the BOM-level row, never the held or closed one", async () => {
    const rows = await getWeldingQueue(DAY);
    expect(rows.map((r) => [r.bom, r.mo, r.item, r.available])).toEqual([
      ["B-1", "MO-OPEN", "TN", 3],
      ["LEGACY-CODE", "", "CB", 3],
    ]);
  });

  it("the painting queue drops them too", async () => {
    const rows = await getPaintingQueue(DAY);
    expect(rows.map((r) => [r.mo, r.available])).toEqual([["MO-OPEN", 1]]);
  });

  it("a released hold puts the line straight back — a hold is a state, not a record", async () => {
    h.loads.loadMasterOrders.mockResolvedValue([order("MO-OPEN"), order("MO-HELD", { id: 2 }), order("MO-CLOSED", { id: 3, status: "closed" })]);
    const rows = await getWeldingQueue(DAY);
    expect(rows.map((r) => r.mo)).toEqual(["MO-HELD", "MO-OPEN", ""]);
  });
});

describe("getRunOrderLines — the approved run order as one dept sees it", () => {
  it("skips held orders like closed ones, and keeps the open one", async () => {
    h.prisma.runOrderEntry.findMany.mockResolvedValue([
      { rank: 1, mo: "MO-HELD", item: "TN", batchQty: null, batchNo: null, appliedAt: DAY },
      { rank: 2, mo: "MO-CLOSED", item: "TN", batchQty: null, batchNo: null, appliedAt: DAY },
      { rank: 3, mo: "MO-OPEN", item: "TN", batchQty: null, batchNo: null, appliedAt: DAY },
    ]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: "MO-OPEN", item: "TN", _sum: { qty: 4 } }]);
    const lines = await getRunOrderLines("Welding");
    expect(lines.map((l) => [l.rank, l.mo, l.remaining])).toEqual([[3, "MO-OPEN", 6]]);
  });

  it("the line returns by itself once the hold is released", async () => {
    h.prisma.runOrderEntry.findMany.mockResolvedValue([{ rank: 1, mo: "MO-HELD", item: "TN", batchQty: null, batchNo: null, appliedAt: DAY }]);
    h.loads.loadMasterOrders.mockResolvedValue([order("MO-HELD", { id: 2 })]);
    const lines = await getRunOrderLines("Painting");
    expect(lines.map((l) => [l.mo, l.remaining])).toEqual([["MO-HELD", 10]]);
  });
});
