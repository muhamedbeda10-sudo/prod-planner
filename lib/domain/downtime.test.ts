import { describe, it, expect } from "vitest";
import { downtimeByCause, downtimeLabel, isDowntimeCode } from "./downtime";

describe("machine stops by cause", () => {
  it("sums the hours per code, unplanned first by hours, planned maintenance last and outside the shares", () => {
    const r = downtimeByCause([
      { reasonCode: "MECH", hours: 2 },
      { reasonCode: "MATERIAL", hours: 3 },
      { reasonCode: "MECH", hours: 1.5 },
      { reasonCode: "PM", hours: 4 },
      { reasonCode: null, reason: "old free text", hours: 0.5 },
      { reasonCode: "MECH", hours: 0 },
    ]);
    expect(r.unplannedH).toBe(7);
    expect(r.plannedH).toBe(4);
    expect(r.causes.map((c) => [c.code, c.hours, c.stops])).toEqual([["MECH", 3.5, 2], ["MATERIAL", 3, 1], ["UNCODED", 0.5, 1], ["PM", 4, 1]]);
    expect(r.causes[0].share).toBeCloseTo(0.5, 10);
    expect(r.causes.at(-1)!.share).toBeNull();
  });

  it("reads a code as its label, and a row from before the codes as its own words", () => {
    expect(downtimeLabel("SETUP")).toBe("Setup / changeover");
    expect(downtimeLabel(null, "  belt snapped ")).toBe("belt snapped");
    expect(downtimeLabel(null)).toBe("Not given");
    expect(isDowntimeCode("ELEC")).toBe(true);
    expect(isDowntimeCode("elec")).toBe(false);
  });
});
