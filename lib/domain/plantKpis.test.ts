import { describe, it, expect } from "vitest";
import { mergeActions, plantPlanningSummary } from "./plantKpis";

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
  it("keeps a decision's floor mark through the merge", () => {
    const out = mergeActions([{ tone: "bad", text: "x", href: "/", floor: true }], [{ tone: "bad", text: "y", href: "/" }]);
    expect(out[0].floor).toBe(true);
    expect("floor" in out[1]).toBe(false);
  });
});
