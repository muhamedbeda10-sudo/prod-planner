import { describe, it, expect } from "vitest";
import { findPlanForDate, type PlanWindow } from "./findPlan";
import { excelSerialToDate } from "./dates";

const plans: PlanWindow[] = [
  { planNo: 26, startDate: excelSerialToDate(46200) },
  { planNo: 27, startDate: excelSerialToDate(46207) },
];

describe("findPlanForDate", () => {
  it("cut (lead 2): day 46205 is covered by plan 27 (start 46207 - 2 = 46205)", () => {
    expect(findPlanForDate(plans, excelSerialToDate(46205), 2)).toBe(27);
  });

  it("welding (lead 1): day 46205 is NOT yet covered by plan 27, falls to 26", () => {
    // 46207 - 1 = 46206 > 46205, so plan 27's window hasn't opened; plan 26 (start 46200) covers it
    expect(findPlanForDate(plans, excelSerialToDate(46205), 1)).toBe(26);
  });

  it("picks the latest-starting plan whose window has opened", () => {
    expect(findPlanForDate(plans, excelSerialToDate(46211), 1)).toBe(27);
  });

  it("returns null when no plan covers the day", () => {
    expect(findPlanForDate(plans, excelSerialToDate(46100), 2)).toBeNull();
  });
});
