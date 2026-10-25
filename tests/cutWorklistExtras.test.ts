import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the Fabrication page's tracker layers -----------------------------------
// The Plan Tracker's "Send to a worklist" offers Cut like any other dept, and
// the ⭐ flag promises a table on top of EVERY dept worklist — so the loader
// the Fabrication page now reads for them has to give Cut the same answers it
// gives Welding and Painting: the pushed lines keyed on dept "Cut", shrinking
// with the cut output recorded since the push; every applicable component
// (the core included — only Painting skips it) on the priority table; and the
// admin's hidden lines filtering both. These tests pin that for dept "Cut".

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findMany: fn() },
      worklistPush: { findMany: fn() },
      worklistLineHide: { findMany: fn() },
      handoverEntry: { groupBy: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
// outside a request there is no cookie jar — the line helper falls back to
// transformers, but `next/headers` cannot be imported under vitest at all
vi.mock("next/headers", () => ({ cookies: async () => { throw new Error("outside a request"); } }));

import { getWorklistExtras } from "@/lib/server/worklistExtras";

function order(mo: string, extra: Record<string, unknown> = {}) {
  return {
    mo, bom: `B-${mo}`, line: "TR", status: "open", planQty: 10, priority: false,
    kva: "100 KVA", rating: "11/0.4", soi: null, urgent: false,
    excludedItems: null, includedItems: null, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0,
    holdAt: null, holdNote: null, holdBy: null,
    ...extra,
  };
}
function push(mo: string, item: string, qty: number, baseDone = 0, dept = "Cut") {
  return { id: 1, dept, bom: `B-${mo}`, mo, item, qty, baseDone };
}
function cutSoFar(mo: string, item: string, qty: number) {
  return { mo, item, _sum: { qty } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.worklistPush.findMany.mockResolvedValue([]);
  h.prisma.worklistLineHide.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
});

describe("getWorklistExtras('Cut') — what the Fabrication page shows", () => {
  it("reads the pushes, hides and output of dept Cut only", async () => {
    await getWorklistExtras("Cut");
    expect(h.prisma.worklistPush.findMany.mock.calls[0][0]).toMatchObject({ where: { dept: "Cut" } });
    expect(h.prisma.worklistLineHide.findMany.mock.calls[0][0]).toMatchObject({ where: { dept: "Cut" } });
    expect(h.prisma.handoverEntry.groupBy.mock.calls[0][0]).toMatchObject({ where: { dept: "Cut", mo: { not: null } } });
  });

  it("lists a line the tracker sent to Cut, clamped to what the order still owes Fabrication", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { planQty: 10, ospTN: 2 })]);
    h.prisma.worklistPush.findMany.mockResolvedValue([push("MO-1", "TN", 20)]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([cutSoFar("MO-1", "TN", 3)]);

    const { pushed } = await getWorklistExtras("Cut");
    // 8 in house (10 − 2 OSP), 3 cut → 5 left, although 20 were pushed
    expect(pushed).toEqual([{ bom: "B-MO-1", mo: "MO-1", description: "100 KVA · 11/0.4", item: "TN", qty: 5, done: 3, orderQty: 8 }]);
  });

  it("consumes the pushed quantity with the cut pieces recorded since the push, and retires it when done", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { planQty: 50 }), order("MO-2", { planQty: 50 })]);
    h.prisma.worklistPush.findMany.mockResolvedValue([
      { ...push("MO-1", "CF", 6, 10), id: 1 }, // 10 cut when pushed, 14 now → 4 of the 6 consumed
      { ...push("MO-2", "CF", 6, 10), id: 2 }, // 16 now → all 6 consumed, the line leaves the page
    ]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([cutSoFar("MO-1", "CF", 14), cutSoFar("MO-2", "CF", 16)]);

    const { pushed } = await getWorklistExtras("Cut");
    expect(pushed.map((p) => [p.mo, p.qty, p.done])).toEqual([["MO-1", 2, 14]]);
  });

  it("drops a pushed line whose order is closed or on hold, and names the held order once", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([
      order("MO-C", { status: "closed" }),
      order("MO-H", { holdAt: new Date("2026-10-20T08:00:00Z"), holdNote: "waiting for CRC", holdBy: "planner" }),
    ]);
    h.prisma.worklistPush.findMany.mockResolvedValue([{ ...push("MO-C", "CF", 5), id: 1 }, { ...push("MO-H", "CF", 5), id: 2 }]);

    const { pushed, held } = await getWorklistExtras("Cut");
    expect(pushed).toEqual([]);
    expect(held.map((o) => o.mo)).toEqual(["MO-H"]);
  });

  it("puts every applicable component of a ⭐ order on Cut's priority table — the core included", async () => {
    // 100 KVA qualifies the arrester bracket; one voltage on the secondary — no mono box
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-P", { priority: true, planQty: 4, ospCB: 4 })]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([cutSoFar("MO-P", "TC", 4), cutSoFar("MO-P", "CF", 1)]);

    const { priority } = await getWorklistExtras("Cut");
    // TC is finished and CB is fully outsourced — neither owes Fabrication anything
    expect(priority.map((p) => [p.item, p.need, p.done, p.remaining])).toEqual([
      ["CF", 4, 1, 3],
      ["TN", 4, 0, 4],
      ["AR", 4, 0, 4],
    ]);
  });

  it("keeps a priority order that is closed or on hold off the table", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([
      order("MO-C", { priority: true, status: "closed" }),
      order("MO-H", { priority: true, holdAt: new Date("2026-10-20T08:00:00Z") }),
      order("MO-P", { priority: true }),
    ]);

    const { priority } = await getWorklistExtras("Cut");
    expect(new Set(priority.map((p) => p.mo))).toEqual(new Set(["MO-P"]));
  });

  it("a line hidden by an admin leaves both the pushed and the priority tables, and waits in the hidden list", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-P", { priority: true })]);
    h.prisma.worklistPush.findMany.mockResolvedValue([{ ...push("MO-P", "CF", 5), id: 1 }, { ...push("MO-P", "TN", 5), id: 2 }]);
    h.prisma.worklistLineHide.findMany.mockResolvedValue([{ id: 1, dept: "Cut", bom: "B-MO-P", mo: "MO-P", item: "CF" }]);

    const { pushed, priority, hidden } = await getWorklistExtras("Cut");
    expect(pushed.map((p) => p.item)).toEqual(["TN"]);
    expect(priority.map((p) => p.item)).not.toContain("CF");
    expect(hidden).toEqual([{ dept: "Cut", bom: "B-MO-P", mo: "MO-P", item: "CF" }]);
  });
});
