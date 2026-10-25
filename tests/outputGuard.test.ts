import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the physical chain guard's ceiling: what the plant MAKES of an order.
// The pieces bought out (OSP) are never cut here, so cut may reach
// planQty − osp, not planQty — the merged-row path (capsFor) and the worklist's
// own target already read it so; the single-MO path used to let 4 outsourced
// cores be cut twice.

const h = vi.hoisted(() => ({
  prisma: { handoverEntry: { groupBy: vi.fn(), aggregate: vi.fn() }, masterOrder: { findUnique: vi.fn() } },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

import { ChainRefused, checkOutputChain, recheckLvChainLocked } from "@/lib/server/outputGuard";

const sums = (rows: Record<string, number>) => Object.entries(rows).map(([dept, qty]) => ({ dept, _sum: { qty } }));
const ORDER = { mo: "MO-1", planQty: 10, ospCF: 4, ospTC: 0, ospTN: 0, ospCB: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.masterOrder.findUnique.mockResolvedValue(ORDER);
});

describe("checkOutputChain — the order's in-house share", () => {
  it("lets cut reach the in-house share and no further when part of the component is outsourced", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 5 }));
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 1 })).toBeNull();
    const over = await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 2 });
    expect(over).toMatch(/order MO-1 is for 10 pcs \(4 outsourced, 6 made here\) — cut would reach 7\. Max extra cut now: 1\./);
  });

  it("keeps the whole order quantity as the ceiling for a component made entirely here", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 9 }));
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "TC", qty: 1 })).toBeNull();
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "TC", qty: 2 })).toMatch(/cut would reach 11/);
  });

  it("lets a correction or a delete bring an over-cut order down — only a raise is refused", async () => {
    // the 4 outsourced cores were typed after 9 had been cut: 9 > the 6 made here
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 9 }));
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: -1 })).toBeNull();
    // a 1-piece row deleted: the others sum to 8 without it, the whole was 9
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 8 }));
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 9 } });
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 0, excludeId: 7 })).toBeNull();
    expect(h.prisma.handoverEntry.aggregate).toHaveBeenCalledWith({ where: { mo: "MO-1", item: "CF", dept: "Cut" }, _sum: { qty: true } });
    // an edit that raises the row from 1 to 3 is still refused, and says what is left (none)
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 3, excludeId: 7 })).toMatch(/cut would reach 11\. Max extra cut now: 0\./);
    // a plain add on top is refused too
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 9 }));
    expect(await checkOutputChain({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 1 })).toMatch(/cut would reach 10/);
  });

  it("does not refuse another stage for a cut that is already over the order", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 12, Welding: 0 }));
    expect(await checkOutputChain({ dept: "Welding", bom: "B", mo: "MO-1", item: "TC", qty: 1 })).toBeNull();
  });

  it("still holds the stage order: welded never above cut", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue(sums({ Cut: 6, Welding: 6 }));
    expect(await checkOutputChain({ dept: "Welding", bom: "B", mo: "MO-1", item: "CF", qty: 1 })).toMatch(/welded must stay ≤ cut/);
  });
});

describe("recheckLvChainLocked — a panel row is judged again under its order's lock, inside the write", () => {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(`lock:${strings.join("?")}:${values.join(",")}`); }),
    handoverEntry: { groupBy: vi.fn(async () => { calls.push("read"); return sums({ Punching: 4, Bending: 4 }); }) },
    masterOrder: { findUnique: vi.fn(async () => ({ planQty: 10 })) },
  };
  beforeEach(() => { calls.length = 0; });

  it("takes the lock first, then reads through the same transaction, and refuses what the ledger no longer allows", async () => {
    // another record bent 4 meanwhile: 2 more bent would pass 4 punched
    await expect(recheckLvChainLocked(tx as never, { dept: "Bending", bom: "LV-1", mo: "P-1", item: "PNL", qty: 2 })).rejects.toBeInstanceOf(ChainRefused);
    expect(calls[0]).toBe("lock:SELECT pg_advisory_xact_lock(?::int, hashtext(?)::int):52613,P-1");
    expect(calls[1]).toBe("read");
    // the app's own client is never used while the transaction holds its connection
    expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
  });

  it("lets a panel through when the chain still holds", async () => {
    await expect(recheckLvChainLocked(tx as never, { dept: "Punching", bom: "LV-1", mo: "P-1", item: "PNL", qty: 2 })).resolves.toBeUndefined();
  });

  it("leaves transformer rows and panel rows without an MO to the one check before the write", async () => {
    await recheckLvChainLocked(tx as never, { dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 1 });
    await recheckLvChainLocked(tx as never, { dept: "Bending", bom: "LV-1", mo: null, item: "PNL", qty: 1 });
    expect(calls).toEqual([]);
  });
});
