import { describe, expect, it } from "vitest";
import { isFridayISO, weekDaysISO, weekStartISO, weekTotals } from "./quickHours";

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
  it("sums each department over the days its roster was saved", () => {
    const cell = (hours: number, recorded = hours > 0) => ({ people: recorded ? 5 : null, hours, recorded });
    const empty = { Cut: cell(0), Welding: cell(0), ShotBlast: cell(0), Painting: cell(0) };
    const t = weekTotals({
      "2026-09-12": { ...empty, Cut: cell(108), Welding: cell(60) },
      "2026-09-13": { ...empty, Cut: cell(99.5), Painting: cell(0, true) },
    });
    expect(t.Cut).toEqual({ hours: 207.5, days: 2 });
    expect(t.Welding).toEqual({ hours: 60, days: 1 });
    expect(t.Painting).toEqual({ hours: 0, days: 1 }); // saved with everyone absent still counts as a recorded day
    expect(t.ShotBlast).toEqual({ hours: 0, days: 0 });
  });
});
