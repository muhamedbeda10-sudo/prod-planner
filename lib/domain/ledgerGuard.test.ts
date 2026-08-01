import { describe, it, expect } from "vitest";
import { guardLedger, MIN_GROUP, LATE_DAYS, type GuardEntry } from "./ledgerGuard";

let nextId = 1;
const entry = (over: Partial<GuardEntry>): GuardEntry => ({
  id: nextId++,
  dateISO: "2026-07-20",
  dept: "Cut",
  bom: "B-1000",
  mo: "MO-1",
  item: "TC",
  qty: 6,
  createdISO: "2026-07-20T18:00:00Z",
  ...over,
});

// a healthy history: same dept×item, everyday quantities, no duplicates
const history = (n: number, qty = 6) =>
  Array.from({ length: n }, (_, i) =>
    entry({ qty: qty + (i % 3), dateISO: `2026-07-${String(1 + i).padStart(2, "0")}`, bom: `B-${i}`, mo: `MO-${i}`, createdISO: `2026-07-${String(1 + i).padStart(2, "0")}T18:00:00Z` })
  );

describe("guardLedger — outlier quantities", () => {
  it("flags a quantity far above the dept×item's usual", () => {
    const rows = [...history(12), entry({ id: 999, qty: 80, bom: "B-X", mo: "MO-X" })];
    const flags = guardLedger(rows);
    expect(flags.get(999)?.some((f) => f.type === "outlier")).toBe(true);
    // the everyday rows stay clean
    expect(rows.filter((r) => r.id !== 999 && flags.get(r.id)?.some((f) => f.type === "outlier"))).toHaveLength(0);
  });

  it("never judges a small history", () => {
    const rows = [...history(MIN_GROUP - 2), entry({ id: 999, qty: 80, bom: "B-X", mo: "MO-X" })];
    expect(guardLedger(rows).get(999)).toBeUndefined();
  });

  it("does not flag the low side — a small entry is just a small day", () => {
    const rows = [...history(12, 40), entry({ id: 999, qty: 1, bom: "B-X", mo: "MO-X" })];
    expect(guardLedger(rows).get(999)).toBeUndefined();
  });

  it("catches an outlier even when every other entry is identical (MAD = 0)", () => {
    const rows = [...history(12, 6).map((e) => ({ ...e, qty: 6 })), entry({ id: 999, qty: 60, bom: "B-X", mo: "MO-X" })];
    expect(guardLedger(rows).get(999)?.some((f) => f.type === "outlier")).toBe(true);
  });

  it("keeps dept×item groups separate — a Painting day can't skew Cut's band", () => {
    const rows = [...history(12, 5), ...history(12, 50).map((e) => ({ ...e, dept: "Painting" }))];
    expect([...guardLedger(rows).values()].flat().filter((f) => f.type === "outlier")).toHaveLength(0);
  });
});

describe("guardLedger — duplicates", () => {
  it("flags the same record appearing twice on the same day", () => {
    const a = entry({ id: 501 });
    const b = entry({ id: 502 });
    const flags = guardLedger([a, b]);
    expect(flags.get(501)?.some((f) => f.type === "duplicate")).toBe(true);
    expect(flags.get(502)?.some((f) => f.type === "duplicate")).toBe(true);
  });

  it("different quantities on the same day are two real entries, not a duplicate", () => {
    const flags = guardLedger([entry({ id: 501, qty: 6 }), entry({ id: 502, qty: 8 })]);
    expect(flags.size).toBe(0);
  });
});

describe("guardLedger — recording drift", () => {
  it("flags an entry recorded well after the work date", () => {
    const e = entry({ id: 700, dateISO: "2026-07-01", createdISO: `2026-07-${String(2 + LATE_DAYS).padStart(2, "0")}T09:00:00Z` });
    expect(guardLedger([e]).get(700)?.[0].type).toBe("late");
  });

  it("allows the normal next-morning recording", () => {
    const e = entry({ id: 700, dateISO: "2026-07-01", createdISO: "2026-07-02T07:30:00Z" });
    expect(guardLedger([e]).get(700)).toBeUndefined();
  });

  it("flags output claimed for a day that hadn't happened yet", () => {
    const e = entry({ id: 700, dateISO: "2026-07-05", createdISO: "2026-07-01T12:00:00Z" });
    expect(guardLedger([e]).get(700)?.[0].type).toBe("future");
  });
});
