import { describe, it, expect } from "vitest";
import {
  qualifiesAR,
  qualifiesMB,
  itemApplies,
  eligibleItems,
  applicableItems,
  itemEligible,
  itemOverrides,
  itemDailyTarget,
  sumItemTargets,
  ospOf,
  stageItemError,
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
  it("a forced-on component counts although the rule skipped it", () => {
    const o = { kva: "50", rating: "13.8/0.4", includedItems: "AR,MB" };
    expect(itemEligible("AR", o)).toBe(true);
    expect(eligibleItems(o)).toEqual(["CF", "TC", "TN", "CB", "AR", "MB"]);
    expect(applicableItems(o)).toEqual(["CF", "TC", "TN", "CB", "AR", "MB"]);
    // N/A still wins over a force — the planner unticked it last
    expect(applicableItems({ ...o, excludedItems: "MB" })).toEqual(["CF", "TC", "TN", "CB", "AR"]);
  });
});

describe("itemOverrides — the six ticks become the two override lists", () => {
  it("stores only the ticks that disagree with the rule", () => {
    const o = { kva: "200", rating: "13.8/0.4" }; // rule: base four + AR
    expect(itemOverrides(o, ["CF", "TC", "TN", "CB", "AR"])).toEqual({ includedItems: null, excludedItems: null });
    expect(itemOverrides(o, ["CF", "TC", "TN", "CB", "AR", "MB"])).toEqual({ includedItems: "MB", excludedItems: null });
    expect(itemOverrides(o, ["CF", "TN", "CB"])).toEqual({ includedItems: null, excludedItems: "TC,AR" });
    expect(itemOverrides(o, ["cf", "tn", "cb", "mb"])).toEqual({ includedItems: "MB", excludedItems: "TC,AR" });
  });
  it("round-trips: the overrides give back the ticks", () => {
    const o = { kva: "50", rating: "13.8/0.4" };
    const ticks = ["CF", "TN", "AR"];
    expect(applicableItems({ ...o, ...itemOverrides(o, ticks) })).toEqual(ticks);
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
  it("reads a missing or negative count as none outsourced", () => {
    expect(ospOf({ ospCF: null, ospTN: -2 }, "CF")).toBe(0);
    expect(ospOf({ ospCF: null, ospTN: -2 }, "TN")).toBe(0);
  });
});

describe("stageItemError", () => {
  it("keeps shot blast for the core frame and painting for everyone else", () => {
    expect(stageItemError("ShotBlast", "TN")).toBe("TN is painted, not shot blasted — SHB applies to the core (CF) only.");
    expect(stageItemError("Painting", "CF")).toBe("CF is shot blasted, not painted — record it on the SHB cell.");
    expect(stageItemError("ShotBlast", "CF")).toBeNull();
    expect(stageItemError("Painting", "TN")).toBeNull();
    expect(stageItemError("Cut", "CF")).toBeNull();
    expect(stageItemError("Welding", "CF")).toBeNull();
    expect(stageItemError("Delivered", "CF")).toBeNull();
  });
});
