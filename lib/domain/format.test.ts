import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDayShort, formatNumber, formatField, formatQty } from "./format";

const now = new Date("2026-10-06T09:00:00Z");

describe("formatDate", () => {
  it("writes a day of the current year with its weekday and no year", () => {
    expect(formatDate("2026-10-04", now)).toBe("Sun 4 Oct");
    expect(formatDate(new Date("2026-10-04T00:00:00Z"), now)).toBe("Sun 4 Oct");
  });
  it("adds the year for any other year", () => {
    expect(formatDate("2025-10-04", now)).toBe("Sat 4 Oct 2025");
  });
  it("reads empty values as a dash and leaves a malformed one as written", () => {
    expect(formatDate(null, now)).toBe("—");
    expect(formatDate("", now)).toBe("—");
    expect(formatDate("not a date", now)).toBe("not a date");
  });
});

describe("formatDateTime", () => {
  it("writes the moment on the factory clock (Cairo)", () => {
    // 05:58 UTC is 08:58 in Cairo (UTC+3 in October 2026)
    expect(formatDateTime("2026-10-04T05:58:00Z", now)).toBe("4 Oct 08:58");
  });
  it("adds the year for another year", () => {
    expect(formatDateTime("2025-01-02T10:05:00Z", now)).toBe("2 Jan 2025 12:05");
  });
  it("puts a moment after factory midnight on the factory's day", () => {
    expect(formatDateTime("2026-10-04T22:30:00Z", now)).toBe("5 Oct 01:30");
  });
});

describe("formatDayShort", () => {
  it("drops the weekday for chart axes", () => {
    expect(formatDayShort("2026-10-04", now)).toBe("4 Oct");
    expect(formatDayShort("2025-12-31", now)).toBe("31 Dec 2025");
  });
});

describe("numbers", () => {
  it("writes a fixed number of decimals with separators", () => {
    expect(formatNumber(1234.5, 2)).toBe("1,234.50");
    expect(formatNumber(3, 0)).toBe("3");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
  });
  it("uses each field's own decimals", () => {
    expect(formatField(70.1, "weight")).toBe("70.10");
    expect(formatField(0.79, "factor")).toBe("0.7900");
    expect(formatField(1.2874, "sheets")).toBe("1.287");
    expect(formatField(12, "count")).toBe("12");
  });
  it("writes consumables quantities with only the decimals they need", () => {
    expect(formatQty(12)).toBe("12");
    expect(formatQty(0.5)).toBe("0.5");
    expect(formatQty(1.2345)).toBe("1.235");
  });
});
