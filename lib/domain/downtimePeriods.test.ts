import { describe, expect, it } from "vitest";
import { factoryTimeAt, factoryWallClockMs } from "./dates";
import { downtimeHoursInRange, elapsedStopHours, splitDowntimeDays, stopPeriodBounds } from "./downtimePeriods";
const now = factoryTimeAt("2026-10-25", "12:00")!;
const open = { date: "2026-10-23", startTime: "10:15", endTime: null, endDate: null, hours: 0, isOpen: true };
describe("open and multi-day downtime", () => {
  it("calculates open elapsed time without an invented end, including multi-day repairs", () => {
    expect(elapsedStopHours(open, now)).toBe(49.75);
    expect(stopPeriodBounds(open)?.end).toBe(Infinity);
    expect(stopPeriodBounds(open, factoryWallClockMs(now))?.end).toBe(factoryWallClockMs(now));
    expect(elapsedStopHours({ ...open, date: "2026-10-25", startTime: "13:00" }, now)).toBe(0);
  });
  it("allocates an open incident across its actual affected days, at most 24 hours per day", () => {
    const days = splitDowntimeDays(open, "2026-10-22", "2026-10-26", now);
    expect(days.map((d) => [d.date.toISOString().slice(0, 10), d.hours])).toEqual([["2026-10-23", 13.75], ["2026-10-24", 24], ["2026-10-25", 12]]);
    expect(downtimeHoursInRange(open, "2026-10-24", "2026-10-25", now)).toBe(36);
  });
  it("freezes the actual final duration after resolution and clips reports to their window", () => {
    const closed = { ...open, isOpen: false, endDate: "2026-10-25", endTime: "11:05", hours: 48 + 50 / 60 };
    expect(elapsedStopHours(closed, factoryTimeAt("2026-10-27", "12:00")!)).toBe(closed.hours);
    expect(downtimeHoursInRange(closed, "2026-10-25", "2026-10-25", now)).toBeCloseTo(11 + 5 / 60);
    expect(downtimeHoursInRange(closed, "2026-10-26", "2026-10-26", now)).toBe(0);
  });
  it("preserves old recorded start-day bookings and duration-only rows", () => {
    const legacy = { date: "2026-10-24", startTime: "23:00", endTime: "01:00", endsNextDay: true, hours: 2 };
    expect(downtimeHoursInRange(legacy, "2026-10-24", "2026-10-24", now)).toBe(2);
    expect(downtimeHoursInRange(legacy, "2026-10-25", "2026-10-25", now)).toBe(0);
    expect(downtimeHoursInRange({ date: "2026-10-24", hours: 1.42 }, "2026-10-24", "2026-10-25", now)).toBe(1.42);
  });
  it("never gives the next day hours when the repair finished at midnight", () => {
    const closed = { ...open, isOpen: false, endDate: "2026-10-25", endTime: "00:00", hours: 37.75 };
    expect(downtimeHoursInRange(closed, "2026-10-25", "2026-10-25", now)).toBe(0);
    expect(stopPeriodBounds({ ...closed, endDate: "2026-10-22" })).toBeNull();
  });
});
