// FindPlanForDate — exact port of modShared.FindPlanForDate.
//
// The plan whose window covers the day is the one with the LATEST start date such
// that (start - lead) <= day. Returns null when no plan covers the day.

import { dayNumber } from "./dates";

export interface PlanWindow {
  planNo: number;
  startDate: Date;
}

export function findPlanForDate(
  plans: PlanWindow[],
  day: Date,
  lead: number
): number | null {
  const dt = dayNumber(day);
  let bestStart = -Infinity;
  let result: number | null = null;
  for (const p of plans) {
    if (!p || p.planNo === 0) continue;
    const sst = dayNumber(p.startDate);
    if (sst - lead <= dt && sst > bestStart) {
      bestStart = sst;
      result = p.planNo;
    }
  }
  return result;
}
