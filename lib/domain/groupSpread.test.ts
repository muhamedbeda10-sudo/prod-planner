import { describe, expect, it } from "vitest";
import { agreedSpec, capsFor, finsTotal, isFullyDelivered, spreadOverGroup, spreadWords, type ChainState, type GroupMember } from "./groupSpread";

const m = (mo: string, capAdd: number, capSub = 0): GroupMember => ({ mo, capAdd, capSub });

describe("spreadOverGroup — one order closed before the next is touched", () => {
  it("fills the FIRST MO to its cap, then the second, then the third", () => {
    const g = [m("MO-1", 10), m("MO-2", 10), m("MO-3", 10)];
    expect(spreadOverGroup(g, 25).alloc).toEqual([
      { mo: "MO-1", qty: 10 },
      { mo: "MO-2", qty: 10 },
      { mo: "MO-3", qty: 5 },
    ]);
  });

  it("never spreads evenly — a quantity one MO can hold goes to that MO alone", () => {
    const g = [m("MO-1", 10), m("MO-2", 10), m("MO-3", 10)];
    expect(spreadOverGroup(g, 7).alloc).toEqual([{ mo: "MO-1", qty: 7 }]);
  });

  it("steps over an MO with no room and gives the pieces to the next", () => {
    // MO-1 cannot take any (nothing cut for it yet) — MO-2 takes the lot
    const g = [m("MO-1", 0), m("MO-2", 10)];
    expect(spreadOverGroup(g, 6).alloc).toEqual([{ mo: "MO-2", qty: 6 }]);
  });

  it("fills an unbounded MO without leaking into the rest", () => {
    const g = [m("MO-1", Number.POSITIVE_INFINITY), m("MO-2", 10)];
    expect(spreadOverGroup(g, 40).alloc).toEqual([{ mo: "MO-1", qty: 40 }]);
  });

  it("reports what did not fit instead of clamping", () => {
    const g = [m("MO-1", 4), m("MO-2", 3)];
    const s = spreadOverGroup(g, 12);
    expect(s.alloc).toEqual([{ mo: "MO-1", qty: 4 }, { mo: "MO-2", qty: 3 }]);
    expect(s.fits).toBe(7);
    expect(s.left).toBe(5);
  });

  it("takes a correction off the LAST MOs first", () => {
    // undoing 8 unwinds the newest filling, it does not reopen MO-1
    const g = [m("MO-1", 0, 10), m("MO-2", 0, 5), m("MO-3", 0, 5)];
    expect(spreadOverGroup(g, -8).alloc).toEqual([
      { mo: "MO-3", qty: -5 },
      { mo: "MO-2", qty: -3 },
    ]);
  });

  it("will not take back more than the stage after it allows", () => {
    const g = [m("MO-1", 0, 2), m("MO-2", 0, 1)];
    const s = spreadOverGroup(g, -9);
    expect(s.fits).toBe(3);
    expect(s.left).toBe(6);
  });

  it("does nothing for a delta of nothing, and for an empty group", () => {
    expect(spreadOverGroup([m("MO-1", 10)], 0)).toEqual({ alloc: [], left: 0, fits: 0 });
    expect(spreadOverGroup([], 5)).toMatchObject({ alloc: [], left: 5, fits: 0 });
  });

  it("treats a negative cap as no room rather than as room to borrow", () => {
    expect(spreadOverGroup([m("MO-1", -3), m("MO-2", 4)], 4).alloc).toEqual([{ mo: "MO-2", qty: 4 }]);
  });
});

describe("spreadWords — what the planner reads before saving", () => {
  it("names each MO by the part that differs, and the pieces it takes", () => {
    const s = spreadOverGroup([m("PF01/MO/35301-001", 29), m("PF01/MO/35302-001", 10)], 34);
    expect(spreadWords(s)).toBe("35301-001 +29 · 35302-001 +5");
  });

  it("marks a correction as a subtraction", () => {
    const s = spreadOverGroup([m("MO-A", 0, 4)], -4);
    expect(spreadWords(s)).toBe("MO-A −4");
  });
});

describe("isFullyDelivered — which orders the bulk close may touch", () => {
  const line = (delivered: number, counts = true) => ({ counts, delivered });

  it("is finished when every component it needs has reached the customer in full", () => {
    expect(isFullyDelivered(10, [line(10), line(10), line(10)])).toBe(true);
  });

  it("is NOT finished while one component is short, however far the others got", () => {
    expect(isFullyDelivered(10, [line(10), line(9), line(10)])).toBe(false);
  });

  it("ignores the components the order does not need", () => {
    // AR/MB the KVA rule excludes, or a component marked N/A
    expect(isFullyDelivered(10, [line(10), line(0, false)])).toBe(true);
  });

  it("counts a delivery beyond the order quantity as covered, not as a gap", () => {
    expect(isFullyDelivered(10, [line(12), line(10)])).toBe(true);
  });

  it("never closes an order with no quantity or no component that counts", () => {
    expect(isFullyDelivered(0, [line(0)])).toBe(false);
    expect(isFullyDelivered(10, [line(10, false)])).toBe(false);
    expect(isFullyDelivered(10, [])).toBe(false);
  });
});

describe("capsFor — the chain guard as room to move", () => {
  const st = (over: Partial<ChainState> = {}): ChainState => ({
    required: 10, cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0,
    eligible: true, paintExempt: false, ...over,
  });

  it("caps cutting at the order quantity, less what is outsourced", () => {
    expect(capsFor(st({ cut: 4, osp: 2 }), "Cut").add).toBe(4);
  });

  it("leaves cutting unbounded when the order carries no quantity", () => {
    expect(capsFor(st({ required: 0 }), "Cut").add).toBe(Number.POSITIVE_INFINITY);
  });

  it("lets each stage take only what the stage before it finished", () => {
    expect(capsFor(st({ cut: 6, weld: 2 }), "Welding").add).toBe(4);
    expect(capsFor(st({ weld: 6, paint: 1 }), "Painting").add).toBe(5);
    expect(capsFor(st({ weld: 6, shp: 1, paintExempt: true }), "ShotBlast").add).toBe(5);
  });

  it("delivers only what the finishing stage produced — SHB for the core", () => {
    expect(capsFor(st({ paint: 7, delivered: 2 }), "Delivered").add).toBe(5);
    expect(capsFor(st({ shp: 7, delivered: 2, paintExempt: true }), "Delivered").add).toBe(5);
    expect(capsFor(st({ paint: 7, delivered: 2, paintExempt: true }), "Delivered").add).toBe(0);
  });

  it("gives a component the order does not need no room at all", () => {
    expect(capsFor(st({ cut: 5, eligible: false }), "Welding").add).toBe(0);
  });

  it("will not take back what the next stage has already consumed", () => {
    expect(capsFor(st({ cut: 6, weld: 6 }), "Cut").sub).toBe(0);
    expect(capsFor(st({ cut: 6, weld: 2 }), "Cut").sub).toBe(4);
    expect(capsFor(st({ weld: 6, paint: 4 }), "Welding").sub).toBe(2);
    expect(capsFor(st({ weld: 6, shp: 5, paintExempt: true }), "Welding").sub).toBe(1);
  });
});

describe("agreedSpec — one value for the whole BOM, or none", () => {
  it("gives the value back when every MO already carries it", () => {
    expect(agreedSpec(["RAL 7035", "RAL 7035", " RAL 7035 "])).toBe("RAL 7035");
  });

  it("ignores the MOs that have nothing written", () => {
    expect(agreedSpec(["RAL 7035", null, "", "   ", undefined])).toBe("RAL 7035");
  });

  it("is empty when nobody carries it — the cell is there to be filled", () => {
    expect(agreedSpec([null, "", undefined])).toBe("");
  });

  it("reports a disagreement rather than picking a side", () => {
    expect(agreedSpec(["RAL 7035", "RAL 9002"])).toBeNull();
  });
});

describe("finsTotal — the merged row adds Fins up like every other number", () => {
  it("sums the MOs under the row", () => {
    expect(finsTotal(["12", "8", "4"])).toBe(24);
  });

  it("counts only the MOs that carry a figure", () => {
    expect(finsTotal(["12", null, "", "8"])).toBe(20);
  });

  it("keeps a fractional count as it was typed", () => {
    expect(finsTotal(["1.5", "2.25"])).toBe(3.75);
  });

  it("refuses to add free text up — the column is not a number field", () => {
    expect(finsTotal(["12", "2 rows"])).toBeNull();
    expect(finsTotal(["—"])).toBeNull();
  });

  it("has nothing to total when no MO carries Fins", () => {
    expect(finsTotal([null, "", undefined])).toBeNull();
    expect(finsTotal([])).toBeNull();
  });
});
