import { describe, it, expect } from "vitest";
import { clockMinutes, downtimeByCause, downtimeLabel, isDowntimeCode, stopDurationLabel, stopTiming } from "./downtime";

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
  it("keeps minute-sized losses in totals and cause shares", () => {
    const result = downtimeByCause([{ hours: 1 / 60, reasonCode: "MECH" }, { hours: 2 / 60, reasonCode: "ELEC" }]);
    expect(result.unplannedH).toBe(3 / 60);
    expect(result.causes.find((c) => c.code === "MECH")?.hours).toBe(1 / 60);
  });
});

describe("machine stop clock ranges", () => {
  it("counts exact minutes, overnight and an explicitly full day", () => {
    expect(stopTiming("08:10", "09:35")).toMatchObject({ minutes: 85, hours: 85 / 60, endsNextDay: false });
    expect(stopTiming("23:30", "01:00")).toMatchObject({ minutes: 90, hours: 1.5, endsNextDay: true });
    expect(stopTiming("08:00", "08:00", true)?.hours).toBe(24);
    expect(stopTiming("09:00", "09:01")?.minutes).toBe(1);
    expect(stopDurationLabel(85 / 60)).toBe("1 h 25 min");
    expect(stopDurationLabel(1 / 60)).toBe("1 min");
  });
  it("rejects incomplete, malformed, zero, reversed same-day and over-24h ranges", () => {
    for (const [start, end, next] of [["", "09:00", false], ["09:00", "", false], ["24:00", "01:00", true], ["09:61", "10:00", false], ["9:00", "10:00", false], ["08:00", "08:00", false], ["23:00", "01:00", false], ["08:00", "09:00", true]] as const) expect(stopTiming(start, end, next)).toBeNull();
    expect(clockMinutes("00:00")).toBe(0);
    expect(clockMinutes("23:59")).toBe(1439);
  });
});
