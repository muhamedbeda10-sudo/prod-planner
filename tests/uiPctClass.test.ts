import { describe, it, expect } from "vitest";
import { pctClass } from "@/components/ui";

// The percentage washes: five token-based buckets, red through amber to
// green, green only at a full 100%. No fraction → no class.
describe("pctClass", () => {
  it("gives no class when there is nothing to colour", () => {
    expect(pctClass(null)).toBe("");
    expect(pctClass(Number.NaN)).toBe("");
  });

  it("steps red → amber → green by quarters, green only at 100%", () => {
    expect(pctClass(0)).toBe("pct-0");
    expect(pctClass(0.24)).toBe("pct-0");
    expect(pctClass(0.25)).toBe("pct-1");
    expect(pctClass(0.5)).toBe("pct-2");
    expect(pctClass(0.75)).toBe("pct-3");
    expect(pctClass(0.999)).toBe("pct-3");
    expect(pctClass(1)).toBe("pct-4");
  });

  it("clamps fractions outside 0..1", () => {
    expect(pctClass(-0.5)).toBe("pct-0");
    expect(pctClass(1.7)).toBe("pct-4");
  });
});
