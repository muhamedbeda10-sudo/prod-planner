import { describe, expect, it } from "vitest";
import { computeRunOrderLines, type RunOrderEntryLite, type RunOrderMasterLite } from "./runOrder";

const appliedAt = new Date("2026-10-01T06:00:00Z");
const heldSince = new Date("2026-10-05T08:00:00Z");

function entry(rank: number, mo: string, item: string, batchQty: number | null = null, batchNo: number | null = null): RunOrderEntryLite {
  return { rank, mo, item, batchQty, batchNo, appliedAt };
}
function order(mo: string, over: Partial<RunOrderMasterLite> = {}): RunOrderMasterLite {
  return { mo, bom: `B-${mo}`, kva: "500", rating: "13.8/0.4", status: "open", holdAt: null, planQty: 10, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, ...over };
}
const ranks = (rows: { rank: number }[]) => rows.map((r) => r.rank);

// the committed sequence: MO-B's two lines sit between MO-A's
const entries = [entry(1, "MO-A", "TN"), entry(2, "MO-B", "TN"), entry(3, "MO-B", "CB", 4, 1), entry(4, "MO-A", "CB")];

describe("computeRunOrderLines", () => {
  it("leaves out every line of an order on hold, in every dept — the rest keep their rank", () => {
    const orders = [order("MO-A"), order("MO-B", { holdAt: heldSince })];
    for (const dept of ["Cut", "Welding", "Painting"] as const) {
      expect(ranks(computeRunOrderLines({ dept, entries, orders, done: new Map() }))).toEqual([1, 4]);
    }
  });

  it("brings a released order back at its old rank, with what is left on it", () => {
    const stored = structuredClone(entries);
    const done = new Map([["MO-B|TN", 3]]); // logged on the tracker while the order was held
    const held = computeRunOrderLines({ dept: "Welding", entries, orders: [order("MO-A"), order("MO-B", { holdAt: heldSince })], done });
    expect(ranks(held)).toEqual([1, 4]);

    const released = computeRunOrderLines({ dept: "Welding", entries, orders: [order("MO-A"), order("MO-B")], done });
    expect(ranks(released)).toEqual([1, 2, 3, 4]);
    expect(released[1]).toMatchObject({ mo: "MO-B", item: "TN", remaining: 7 });
    expect(released[2]).toMatchObject({ mo: "MO-B", item: "CB", remaining: 10, batchQty: 4, batchNo: 1 });
    // a hold only filters what the floor sees — the committed sequence is not edited
    expect(entries).toEqual(stored);
  });

  it("still drops lines of closed or unknown orders, N/A items, the unpainted core and finished work", () => {
    const orders = [order("MO-A", { ospTN: 4 }), order("MO-C", { status: "closed" })];
    const seq = [entry(1, "MO-X", "TN"), entry(2, "MO-C", "TN"), entry(3, "MO-A", "AR"), entry(4, "MO-A", "CF"), entry(5, "MO-A", "TC"), entry(6, "MO-A", "TN")];
    const done = new Map([["MO-A|TC", 10], ["MO-A|TN", 2]]);
    expect(ranks(computeRunOrderLines({ dept: "Welding", entries: seq, orders, done }))).toEqual([4, 6]);
    expect(computeRunOrderLines({ dept: "Painting", entries: seq, orders, done })).toEqual([
      { rank: 6, bom: "B-MO-A", mo: "MO-A", description: "500 · 13.8/0.4", item: "TN", remaining: 4, batchQty: null, batchNo: null, appliedAtISO: "2026-10-01T06:00:00.000Z" },
    ]);
  });
});
