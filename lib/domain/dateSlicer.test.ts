import { describe, expect, it } from "vitest";
import { addDaysISO, daysBetweenISO, presetRange, slicerPresets, slicerRangeLabel, slicerTicks, weekStartISO } from "./dateSlicer";

describe("date slicer arithmetic", () => {
  const today = "2026-09-28"; // a Monday
  it("adds days and counts them", () => {
    expect(addDaysISO("2026-09-28", 5)).toBe("2026-10-03");
    expect(daysBetweenISO("2026-09-01", "2026-09-28")).toBe(27);
  });
  it("reads the quick filters the same way everywhere", () => {
    expect(presetRange("today", today)).toEqual({ from: today, to: today });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-09-27", to: "2026-09-27" });
    expect(presetRange("last3", today)).toEqual({ from: "2026-09-26", to: today });
    expect(presetRange("last7", today)).toEqual({ from: "2026-09-22", to: today });
    expect(presetRange("thisWeek", today)).toEqual({ from: "2026-09-26", to: today }); // Saturday 26th
    expect(presetRange("thisWeek", "2026-09-26")).toEqual({ from: "2026-09-26", to: "2026-09-26" });
    expect(presetRange("thisMonth", today)).toEqual({ from: "2026-09-01", to: today });
    expect(presetRange("lastMonth", today)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("next7", today)).toEqual({ from: today, to: "2026-10-04" });
    expect(presetRange("overdue", today, "2026-08-01")).toEqual({ from: "2026-08-01", to: "2026-09-27" });
    expect(slicerPresets(["today", "last7"], today).map((p) => p.label)).toEqual(["Today", "Last 7 days"]);
  });
  it("labels the strip by month, or by week start on a short strip", () => {
    expect(slicerTicks("2026-06-15", "2026-09-28").map((t) => t.label)).toEqual(["Jul", "Aug", "Sep"]);
    const short = slicerTicks("2026-09-01", "2026-09-28");
    expect(short.map((t) => t.iso)).toEqual(["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26"]);
    expect(short[0].pos).toBeCloseTo(4 / 27, 5);
  });
  it("reads a range out loud", () => {
    expect(slicerRangeLabel("2026-09-22", "2026-09-28")).toBe("Tue 22 Sep → Mon 28 Sep · 7 days");
    expect(slicerRangeLabel("2026-09-28", "2026-09-28")).toBe("Mon 28 Sep");
  });
});

describe("the plant's week", () => {
  it("starts on Saturday", () => {
    expect(weekStartISO("2026-10-26")).toBe("2026-10-24"); // a Monday
    expect(weekStartISO("2026-10-24")).toBe("2026-10-24"); // Saturday itself
    expect(weekStartISO("2026-10-23")).toBe("2026-10-17"); // a Friday
  });
});
