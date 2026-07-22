import { describe, it, expect } from "vitest";
import {
  qualifiesAR,
  qualifiesMB,
  itemApplies,
  eligibleItems,
  applicableItems,
  itemDailyTarget,
  sumItemTargets,
  ospOf,
  ITEMS,
  SHEET_ITEMS,
  PAINTED_ITEMS,
} from "./constants";

describe("qualifiesAR — Arrester Bracket rule (KVA 100–300 inclusive)", () => {
  it("accepts the inclusive 100–300 range", () => {
    expect(qualifiesAR("100")).toBe(true);
    expect(qualifiesAR("200")).toBe(true);
    expect(qualifiesAR("300")).toBe(true);
    expect(qualifiesAR("150 KVA")).toBe(true); // leading number is read
  });
  it("rejects values outside the range", () => {
    expect(qualifiesAR("99")).toBe(false);
    expect(qualifiesAR("301")).toBe(false);
    expect(qualifiesAR("1000")).toBe(false);
    expect(qualifiesAR("3000kva")).toBe(false);
  });
  it("rejects empty / non-numeric", () => {
    expect(qualifiesAR(null)).toBe(false);
    expect(qualifiesAR("")).toBe(false);
    expect(qualifiesAR("N/A")).toBe(false);
  });
});

describe("qualifiesMB — Mono Box rule (two+ voltages after the first /)", () => {
  it("matches two numbers on the secondary side", () => {
    expect(qualifiesMB("13.8/0.4|0.23")).toBe(true); // 0.4 and 0.23
    expect(qualifiesMB("13.8/400-230")).toBe(true); // 400 and 230
    expect(qualifiesMB("13.8/0.4/0.23")).toBe(true);
  });
  it("rejects a single voltage after the /", () => {
    expect(qualifiesMB("13.8/0.4")).toBe(false);
    expect(qualifiesMB("13.8/11")).toBe(false);
  });
  it("rejects strings without a / or empty", () => {
    expect(qualifiesMB("13.8")).toBe(false);
    expect(qualifiesMB(null)).toBe(false);
    expect(qualifiesMB("")).toBe(false);
  });
});

describe("itemApplies", () => {
  const both = { kva: "200", rating: "13.8/0.4|0.23" };
  const neither = { kva: "50", rating: "13.8/0.4" };
  it("keeps the four base components on every order", () => {
    for (const it of SHEET_ITEMS) {
      expect(itemApplies(it, both)).toBe(true);
      expect(itemApplies(it, neither)).toBe(true);
    }
  });
  it("gates AR/MB on the KVA / rating rules", () => {
    expect(itemApplies("AR", both)).toBe(true);
    expect(itemApplies("MB", both)).toBe(true);
    expect(itemApplies("AR", neither)).toBe(false);
    expect(itemApplies("MB", neither)).toBe(false);
  });
});

describe("applicableItems / eligibleItems", () => {
  it("returns base four + qualifying AR/MB", () => {
    expect(applicableItems({ kva: "200", rating: "13.8/0.4|0.23" })).toEqual(["CF", "TC", "TN", "CB", "AR", "MB"]);
    expect(applicableItems({ kva: "50", rating: "13.8/0.4" })).toEqual(["CF", "TC", "TN", "CB"]);
    expect(applicableItems({ kva: "200", rating: "13.8/0.4" })).toEqual(["CF", "TC", "TN", "CB", "AR"]);
  });
  it("removes manual N/A components", () => {
    expect(applicableItems({ kva: "200", rating: "13.8/0.4|0.23", excludedItems: "TC,AR" })).toEqual(["CF", "TN", "CB", "MB"]);
  });
  it("eligibleItems ignores N/A (drives the ⚙ editor list)", () => {
    expect(eligibleItems({ kva: "200", rating: "13.8/0.4|0.23" })).toEqual(["CF", "TC", "TN", "CB", "AR", "MB"]);
    // eligibility does not depend on excludedItems
    expect(eligibleItems({ kva: "50", rating: "13.8/0.4" })).toEqual(["CF", "TC", "TN", "CB"]);
  });
});

describe("per-item daily targets", () => {
  it("base components use the shared capacity; AR/MB use 20", () => {
    expect(itemDailyTarget("CF", 27)).toBe(27);
    expect(itemDailyTarget("TC", 27)).toBe(27);
    expect(itemDailyTarget("AR", 27)).toBe(20);
    expect(itemDailyTarget("MB", 27)).toBe(20);
  });
  it("sums dept capacity lines correctly", () => {
    expect(sumItemTargets(SHEET_ITEMS, 27)).toBe(108); // 4 × 27
    expect(sumItemTargets(ITEMS, 27)).toBe(148); // 4 × 27 + 20 + 20
    expect(sumItemTargets(PAINTED_ITEMS, 27)).toBe(121); // 3 × 27 + 20 + 20
  });
});

describe("ospOf", () => {
  const o = { ospCF: 1, ospTC: 2, ospTN: 3, ospCB: 4 };
  it("reads the base OSP columns", () => {
    expect(ospOf(o, "CF")).toBe(1);
    expect(ospOf(o, "CB")).toBe(4);
  });
  it("returns 0 for AR/MB (always in-house)", () => {
    expect(ospOf(o, "AR")).toBe(0);
    expect(ospOf(o, "MB")).toBe(0);
  });
});
