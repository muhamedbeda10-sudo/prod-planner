import { describe, it, expect } from "vitest";
import {
  excelSerialToDate,
  dateToExcelSerial,
  toDisplayDate,
  dayNumber,
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
