import { describe, it, expect } from "vitest";
import { linePart, mergeActions, plantDailyOutput, plantEfficiency, plantPlanningSummary } from "./plantKpis";

describe("the plant's efficiency", () => {
  it("is the sums' ratio, never the mean of the lines' rates", () => {
    const p = plantEfficiency([
      { line: "TR", earnedH: 900, workedH: 1000, personDays: 100, days: 5, pricedShare: 1 },
      { line: "LV", earnedH: 10, workedH: 50, personDays: 5, days: 5, pricedShare: 1 },
    ]);
    // the mean of 90% and 20% would say 55%; the plant worked 1050 h for 910
    expect(p.efficiency).toBeCloseTo(910 / 1050, 10);
    expect(p.stdPerPersonDay).toBeCloseTo(910 / 105, 10);
    expect(p.notes).toEqual([]);
  });
  it("says when a line is missing or only partly priced", () => {
    const p = plantEfficiency([
      { line: "TR", earnedH: 0, workedH: 0, personDays: 0, days: 0, pricedShare: null },
      { line: "LV", earnedH: 10, workedH: 50, personDays: 5, days: 3, pricedShare: 0.6 },
    ]);
    expect(p.notes).toHaveLength(2);
    expect(p.notes[0]).toContain("Transformers: no shift day recorded");
    expect(p.notes[1]).toContain("LV Panels: 60% of its output carries standard hours");
    expect(plantEfficiency([]).efficiency).toBeNull();
  });
});

describe("the two lines' decisions as one list", () => {
  it("tags each with its line and keeps the worst first, the transformers' first within a tone", () => {
    const out = mergeActions(
      [{ tone: "warn", text: "tr-warn", href: "/" }, { tone: "bad", text: "tr-bad", href: "/" }],
      [{ tone: "bad", text: "lv-bad", href: "/" }, { tone: "info", text: "lv-info", href: "/" }],
    );
    expect(out.map((a) => `${a.line}:${a.text}`)).toEqual(["TR:tr-bad", "LV:lv-bad", "TR:tr-warn", "LV:lv-info"]);
    expect(mergeActions([{ tone: "info", text: "a", href: "/" }], [{ tone: "info", text: "b", href: "/" }], 1)).toHaveLength(1);
  });
});

describe("the plant's planning headline", () => {
  it("adds the people short and takes the plant's efficiency from the sums", () => {
    const p = plantPlanningSummary(
      { manpower: [{ tone: "bad", gap: -2.2 }, { tone: "warn", gap: -0.3 }], recent: [{ workedH: 100, earnedH: 90 }] },
      { manpower: [{ tone: "bad", gap: -0.5 }], recent: [{ workedH: 100, earnedH: 50 }, { workedH: 0, earnedH: 0 }] },
    );
    expect(p.peopleShort).toEqual({ TR: 3, LV: 1, total: 4 });
    expect(p.recentEfficiency.TR).toBeCloseTo(0.9, 10);
    expect(p.recentEfficiency.LV).toBeCloseTo(0.5, 10);
    expect(p.recentEfficiency.plant).toBeCloseTo(0.7, 10);
    expect(plantPlanningSummary({ manpower: [], recent: [] }, { manpower: [], recent: [] }).recentEfficiency.plant).toBeNull();
  });
  it("reads a line's part off its period", () => {
    expect(linePart("LV", { summary: { earnedH: 1, workedH: 2, personDays: 3, days: 4 }, pricedShare: 0.5 })).toEqual({ line: "LV", earnedH: 1, workedH: 2, personDays: 3, days: 4, pricedShare: 0.5 });
  });
  it("keeps a decision's floor mark through the merge", () => {
    const out = mergeActions([{ tone: "bad", text: "x", href: "/", floor: true }], [{ tone: "bad", text: "y", href: "/" }]);
    expect(out[0].floor).toBe(true);
    expect("floor" in out[1]).toBe(false);
  });
});

describe("the plant's output day by day", () => {
  it("stacks the lines' standard hours, adds the man-hours and takes the day's efficiency from the sums", () => {
    const out = plantDailyOutput(
      [{ dateISO: "2026-10-02", earnedH: 90, workedH: 100 }, { dateISO: "2026-10-01", earnedH: 80, workedH: 100 }],
      [{ dateISO: "2026-10-02", earnedH: 10, workedH: 50 }, { dateISO: "2026-10-03", earnedH: 5, workedH: 10 }],
    );
    expect(out.map((d) => d.dateISO)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(out[1]).toEqual({ dateISO: "2026-10-02", earnedH: 100, workedH: 150, efficiency: 100 / 150, values: { TR: 90, LV: 10 } });
    expect(out[2].values).toEqual({ TR: 0, LV: 5 });
  });
});
