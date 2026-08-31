import { describe, it, expect } from "vitest";
import { owedAcrossDays, promiseCeiling } from "@/lib/domain/planPromises";

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
