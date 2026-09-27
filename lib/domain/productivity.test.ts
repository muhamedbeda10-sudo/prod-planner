import { describe, expect, it } from "vitest";
import { OUTPUT_SOURCE, efficiencyTone, productivityOf } from "./productivity";

describe("productivityOf", () => {
  it("adds the recorded days up: man-hours per piece and earned over worked", () => {
    const s = productivityOf([
      { dateISO: "2026-09-21", hours: 272, people: 28, pieces: 205, earned: 250 },
      { dateISO: "2026-09-22", hours: 275, people: 28, pieces: 90, earned: 110 },
    ]);
    expect(s).toMatchObject({ days: 2, manHours: 547, people: 28, pieces: 295, mhPerPiece: 1.85, earned: 360 });
    expect(s.efficiency).toBeCloseTo(360 / 547, 5);
  });
  it("has no efficiency where there are no standard times, and no rate with no pieces", () => {
    const s = productivityOf([{ dateISO: "2026-09-21", hours: 150, people: 16, pieces: 0, earned: null }]);
    expect(s.efficiency).toBeNull();
    expect(s.earned).toBeNull();
    expect(s.mhPerPiece).toBeNull();
  });
  it("ignores days with no hours and a net-negative correction day", () => {
    const s = productivityOf([
      { dateISO: "2026-09-19", hours: 0, people: 0, pieces: 40, earned: 30 },
      { dateISO: "2026-09-20", hours: 100, people: 10, pieces: -3, earned: 0 },
      { dateISO: "2026-09-21", hours: 100, people: 12, pieces: 50, earned: 80 },
    ]);
    expect(s).toMatchObject({ days: 2, manHours: 200, people: 11, pieces: 50, mhPerPiece: 4, earned: 80 });
  });
  it("is empty with nothing recorded", () => {
    expect(productivityOf([])).toEqual({ days: 0, manHours: 0, people: 0, pieces: 0, mhPerPiece: null, earned: null, efficiency: null });
  });
});

describe("OUTPUT_SOURCE / efficiencyTone", () => {
  it("counts every painted piece through the blasters, and the panels under their own line", () => {
    expect(OUTPUT_SOURCE.ShotBlast.depts).toEqual(["ShotBlast", "Painting"]);
    expect(OUTPUT_SOURCE.WeldingLV).toEqual({ depts: ["Welding"], line: "LV" });
  });
  it("judges the efficiency", () => {
    expect([efficiencyTone(0.95), efficiencyTone(0.75), efficiencyTone(0.5)]).toEqual(["ok", "warn", "bad"]);
  });
});
