import { describe, expect, it } from "vitest";
import { isFridayISO, parseQuickCell, quickHours, weekDaysISO, weekStartISO, weekTotals } from "./quickHours";

describe("quickHours", () => {
  it("is heads × hours each, rounded to a tenth", () => {
    expect(quickHours(12, 9)).toBe(108);
    expect(quickHours(7, 12)).toBe(84);
    expect(quickHours(3, 9.25)).toBe(27.8);
  });
  it("is nothing while either figure is blank", () => {
    expect(quickHours(null, 9)).toBe(0);
    expect(quickHours(5, null)).toBe(0);
    expect(quickHours(0, 9)).toBe(0);
  });
});

describe("parseQuickCell", () => {
  it("takes the default shift when only the heads are typed", () => {
    expect(parseQuickCell({ people: "12", hoursEach: "" }, 9)).toEqual({ people: 12, hoursEach: 9 });
  });
  it("keeps typed hours, to the half hour", () => {
    expect(parseQuickCell({ people: 8, hoursEach: 11.3 }, 9)).toEqual({ people: 8, hoursEach: 11.5 });
  });
  it("clears the day when both are blank or the heads are zero", () => {
    expect(parseQuickCell({ people: "", hoursEach: "" }, 9)).toBeNull();
    expect(parseQuickCell({ people: 0, hoursEach: 9 }, 9)).toBeNull();
  });
  it("refuses hours without heads, and figures out of range", () => {
    expect(parseQuickCell({ people: "", hoursEach: 9 }, 9)).toHaveProperty("error");
    expect(parseQuickCell({ people: 2.5, hoursEach: 9 }, 9)).toHaveProperty("error");
    expect(parseQuickCell({ people: 3, hoursEach: 30 }, 9)).toHaveProperty("error");
  });
});

describe("work week", () => {
  it("starts on Saturday and ends on Friday", () => {
    expect(weekStartISO("2026-09-17")).toBe("2026-09-12"); // Thursday → the Saturday before
    expect(weekStartISO("2026-09-12")).toBe("2026-09-12");
    expect(weekStartISO("2026-09-18")).toBe("2026-09-12"); // Friday closes the week
    const days = weekDaysISO("2026-09-12");
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-09-12");
    expect(days[6]).toBe("2026-09-18");
    expect(isFridayISO(days[6])).toBe(true);
    expect(isFridayISO(days[0])).toBe(false);
  });
});

describe("weekTotals", () => {
  it("sums each department over the days that carry a figure", () => {
    const cell = (hours: number) => ({ people: null, hoursEach: null, hours, source: "quick" as const });
    const empty = { Cut: cell(0), Welding: cell(0), ShotBlast: cell(0), Painting: cell(0) };
    const t = weekTotals({
      "2026-09-12": { ...empty, Cut: cell(108), Welding: cell(60) },
      "2026-09-13": { ...empty, Cut: cell(99.5) },
    });
    expect(t.Cut).toEqual({ hours: 207.5, days: 2 });
    expect(t.Welding).toEqual({ hours: 60, days: 1 });
    expect(t.Painting).toEqual({ hours: 0, days: 0 });
  });
});
