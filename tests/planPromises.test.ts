import { describe, it, expect } from "vitest";
import { inHouseCeiling, owedAcrossDays, owedPlanQtys, promiseCeiling } from "@/lib/domain/planPromises";

describe("promiseCeiling", () => {
  it("is the order's quantity", () => {
    expect(promiseCeiling({ planQty: 2 }, "CB")).toBe(2);
  });
  it("does not cap what it cannot know", () => {
    expect(promiseCeiling(null, "CB")).toBe(Infinity); // not in the registry
    expect(promiseCeiling({ planQty: 0 }, "CB")).toBe(Infinity); // no quantity on it
  });
  it("leaves an N/A component alone — it is already out of the work owed", () => {
    expect(promiseCeiling({ planQty: 2, excludedItems: "CB,TN" }, "CB")).toBe(Infinity);
    expect(promiseCeiling({ planQty: 2, excludedItems: "CB,TN" }, "TC")).toBe(2);
  });
});

describe("owedAcrossDays", () => {
  it("owes the order's quantity once, earliest promise first", () => {
    expect(owedAcrossDays([2, 2], 2)).toEqual([2, 0]);
  });
  it("splits a day that partly repeats and partly adds", () => {
    expect(owedAcrossDays([3, 4], 5)).toEqual([3, 2]);
  });
  it("leaves a genuine split alone", () => {
    expect(owedAcrossDays([15, 13], 28)).toEqual([15, 13]);
  });
  it("does nothing without a ceiling", () => {
    expect(owedAcrossDays([2, 2], Infinity)).toEqual([2, 2]);
  });
});

describe("promiseCeiling with outsourced pieces", () => {
  it("stays the whole order: the weekly tracker counts the bought-out pieces as made against it", () => {
    const order = { planQty: 10, ospTN: 4 };
    expect(promiseCeiling(order, "TN")).toBe(10);
  });
});

describe("inHouseCeiling", () => {
  it("owes only the in-house share — the bought-out pieces are never made here", () => {
    expect(inHouseCeiling({ planQty: 10, ospTN: 4 }, "TN")).toBe(6);
    expect(inHouseCeiling({ planQty: 10, ospTN: 4 }, "TC")).toBe(10);
    expect(inHouseCeiling({ planQty: 10, ospTN: 4 }, "tn")).toBe(6);
  });
  it("never goes below zero when the outsourced count exceeds the order", () => {
    expect(inHouseCeiling({ planQty: 3, ospCF: 5 }, "CF")).toBe(0);
  });
  it("ignores a negative or missing outsourced count", () => {
    expect(inHouseCeiling({ planQty: 3, ospCB: -2 }, "CB")).toBe(3);
    expect(inHouseCeiling({ planQty: 3, ospCB: null }, "CB")).toBe(3);
  });
  it("applies no ceiling where the order gives none", () => {
    expect(inHouseCeiling(null, "TN")).toBe(Infinity);
    expect(inHouseCeiling({ planQty: 10, ospTN: 4, excludedItems: "TN" }, "TN")).toBe(Infinity);
  });
});

describe("owedPlanQtys", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const orders: Record<string, { planQty: number; ospTN?: number; excludedItems?: string }> = {
    A: { planQty: 2 },
    B: { planQty: 10, ospTN: 4 },
    C: { planQty: 5, excludedItems: "CB" },
  };
  const orderOf = (mo: string) => orders[mo];

  it("walks each order+component by date and hands the repeat nothing", () => {
    const rows = [
      { mo: "A", item: "CB", ovenDate: d("2026-10-07"), qty: 2 }, // Wednesday repeat, listed first
      { mo: "A", item: "CB", ovenDate: d("2026-10-05"), qty: 2 }, // Monday — the real work
      { mo: "A", item: "TN", ovenDate: d("2026-10-05"), qty: 2 }, // another component, its own ceiling
    ];
    expect(owedPlanQtys(rows, orderOf)).toEqual([0, 2, 2]);
  });
  it("caps at the in-house share when some pieces are outsourced", () => {
    const rows = [
      { mo: "B", item: "TN", ovenDate: d("2026-10-05"), qty: 4 },
      { mo: "B", item: "TN", ovenDate: d("2026-10-06"), qty: 4 },
      { mo: "B", item: "TN", ovenDate: d("2026-10-07"), qty: 4 },
    ];
    expect(owedPlanQtys(rows, orderOf)).toEqual([4, 2, 0]);
  });
  it("leaves unknown orders as promised, and owes nothing for a component the order marks N/A", () => {
    const rows = [
      { mo: "ZZ", item: "TN", ovenDate: d("2026-10-05"), qty: 7 },
      { mo: "ZZ", item: "TN", ovenDate: d("2026-10-06"), qty: 7 },
      { mo: "C", item: "CB", ovenDate: d("2026-10-05"), qty: 9 }, // CB is N/A on C — the weekly tracker owes none either
      { mo: "C", item: "TN", ovenDate: d("2026-10-05"), qty: 9 },
    ];
    expect(owedPlanQtys(rows, orderOf)).toEqual([7, 7, 0, 5]);
  });
  it("owes nothing for an AR/MB the order's rule does not give it", () => {
    const rows = [{ mo: "D", item: "AR", ovenDate: d("2026-10-05"), qty: 2 }, { mo: "D", item: "TN", ovenDate: d("2026-10-05"), qty: 2 }];
    // 1000 kVA, no rating: the arrester box does not apply by rule
    expect(owedPlanQtys(rows, () => ({ planQty: 2, kva: "1000", rating: null, excludedItems: null, includedItems: null }))).toEqual([0, 2]);
    // ticked in by hand, it is owed
    expect(owedPlanQtys(rows, () => ({ planQty: 2, kva: "1000", rating: null, excludedItems: null, includedItems: "AR" }))).toEqual([2, 2]);
  });
  it("keeps the lines' own order in the result", () => {
    expect(owedPlanQtys([], orderOf)).toEqual([]);
    const rows = [
      { mo: "A", item: "TN", ovenDate: d("2026-10-09"), qty: 1 },
      { mo: "A", item: "CB", ovenDate: d("2026-10-08"), qty: 3 },
      { mo: "A", item: "TN", ovenDate: d("2026-10-01"), qty: 1 },
    ];
    expect(owedPlanQtys(rows, orderOf)).toEqual([1, 2, 1]);
  });
});
