import { describe, it, expect } from "vitest";
import { calibrate, MIN_CALIBRATION_DAYS, type CalibrationDay } from "./calibration";

const day = (actual: number, earned: number): CalibrationDay => ({ actual, earned });

describe("calibrate", () => {
  it("finds the factor that makes earned hours track actual hours", () => {
    // 5 days, 100h worked each, only 80 std-h earned each → standards 25% tight
    const c = calibrate(Array.from({ length: 5 }, () => day(100, 80)));
    expect(c.ready).toBe(true);
    expect(c.efficiency).toBeCloseTo(0.8, 6);
    expect(c.factor).toBeCloseTo(1.25, 6);
    expect(c.days).toBe(5);
    expect(c.actualH).toBe(500);
    expect(c.earnedH).toBe(400);
  });

  it("pools uneven days by their sums, not by averaging daily ratios", () => {
    // Σactual = 300, Σearned = 250 → factor 1.2 (a per-day mean would differ)
    const c = calibrate([day(200, 100), day(25, 37.5), day(25, 37.5), day(25, 37.5), day(25, 37.5)]);
    expect(c.factor).toBeCloseTo(300 / 250, 6);
  });

  it("stays locked below the minimum recorded days", () => {
    const c = calibrate(Array.from({ length: MIN_CALIBRATION_DAYS - 1 }, () => day(100, 80)));
    expect(c.ready).toBe(false);
    expect(c.factor).toBeNull();
    expect(c.reason).toContain(`${MIN_CALIBRATION_DAYS}`);
  });

  it("ignores days recorded with zero hours", () => {
    // the zero-hour day neither counts toward the minimum nor skews the sums
    const c = calibrate([day(0, 50), ...Array.from({ length: 5 }, () => day(100, 100))]);
    expect(c.days).toBe(5);
    expect(c.earnedH).toBe(500);
    expect(c.factor).toBeCloseTo(1, 6);
  });

  it("refuses when those days earned nothing — there is nothing to compare", () => {
    const c = calibrate(Array.from({ length: 5 }, () => day(100, 0)));
    expect(c.ready).toBe(false);
    expect(c.factor).toBeNull();
  });

  it("refuses an implausible gap instead of wrecking the standards", () => {
    // earning 10 std-h per 100 worked is a recording problem, not a pace finding
    const c = calibrate(Array.from({ length: 5 }, () => day(100, 10)));
    expect(c.ready).toBe(false);
    expect(c.factor).toBeCloseTo(10, 6); // still reported, just not applicable
    expect(c.reason).toBeTruthy();
  });
});
