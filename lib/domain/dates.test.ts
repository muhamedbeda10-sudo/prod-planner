import { describe, it, expect } from "vitest";
import {
  calendarDate,
  parseISODate,
  excelSerialToDate,
  dateToExcelSerial,
  toDisplayDate,
  dayNumber,
  factoryClockHHMM,
  factoryDayISO,
  factoryDaysBefore,
  factoryWallClockMs,
} from "./dates";

describe("excel serial dates", () => {
  it("46211 == 08/07/2026 (anchor from the Daily Report sheet)", () => {
    expect(toDisplayDate(excelSerialToDate(46211))).toBe("08/07/2026");
  });
  it("46207 == 04/07/2026 (plan 27 start)", () => {
    expect(toDisplayDate(excelSerialToDate(46207))).toBe("04/07/2026");
  });
  it("round-trips serial <-> date", () => {
    for (const s of [46205, 46207, 46211, 46213, 40000]) {
      expect(dateToExcelSerial(excelSerialToDate(s))).toBe(s);
    }
  });
  it("consecutive serials are consecutive day numbers", () => {
    const a = dayNumber(excelSerialToDate(46207));
    const b = dayNumber(excelSerialToDate(46208));
    expect(b - a).toBe(1);
  });
});

// The factory runs on Cairo time — UTC+3 in October 2026, UTC+2 in January.
// None of these may depend on the zone the test (or a browser) runs in.
describe("the factory clock", () => {
  it("reads a moment's time of day and day in Cairo", () => {
    expect(factoryClockHHMM(new Date("2026-10-04T05:58:00Z"))).toBe("08:58");
    expect(factoryClockHHMM(new Date("2026-01-04T05:58:00Z"))).toBe("07:58");
    // 22:30 UTC is already past midnight in Cairo
    expect(factoryClockHHMM(new Date("2026-10-04T22:30:00Z"))).toBe("01:30");
    expect(factoryDayISO(new Date("2026-10-04T22:30:00Z"))).toBe("2026-10-05");
  });

  it("counts whole factory days back, not 24-hour spans", () => {
    const now = new Date("2026-10-05T06:00:00Z"); // 09:00 on 5 Oct, Cairo
    expect(factoryDaysBefore(new Date("2026-10-04T22:30:00Z"), now)).toBe(0); // 01:30 the same day
    expect(factoryDaysBefore(new Date("2026-10-04T20:30:00Z"), now)).toBe(1); // 23:30 the day before
    expect(factoryDaysBefore(new Date("2026-09-28T06:00:00Z"), now)).toBe(7);
    // a moment ahead of now (a clock a little fast) is still today
    expect(factoryDaysBefore(new Date("2026-10-05T07:00:00Z"), now)).toBe(0);
  });

  it("writes the factory's wall clock as a UTC instant, to the minute", () => {
    expect(factoryWallClockMs(new Date("2026-10-04T05:58:41Z"))).toBe(Date.UTC(2026, 9, 4, 8, 58));
    expect(factoryWallClockMs(new Date("2026-10-04T22:30:00Z"))).toBe(Date.UTC(2026, 9, 5, 1, 30));
  });
});

describe("calendar dates", () => {
  it("parses a real day and refuses one Date.UTC would roll over", () => {
    expect(parseISODate("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parseISODate("2026-02-30")).toBeNull();
    expect(parseISODate("2026-00-10")).toBeNull();
    expect(calendarDate(2028, 2, 29)?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(calendarDate(2026, 2, 29)).toBeNull();
  });
});
