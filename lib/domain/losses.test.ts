import { describe, expect, it } from "vitest";
import { biggestLoss, explainChange, lossWaterfall, type LossDay } from "./losses";

const day = (o: Partial<LossDay>): LossDay => ({
  dateISO: "2026-10-20", centre: "Welding", workedH: 0, absentH: 0, overtimeH: 0, earnedH: 0, machineH: 0, stops: {}, ...o,
});

describe("lossWaterfall", () => {
  it("walks the rostered hours down to the earned ones — every step adding up", () => {
    // 20 people × 11 h with 2 absent; 10 h overtime; 4 machines × 11 h; 4 h breakdown
    const w = lossWaterfall([day({ workedH: 18 * 11 + 10, absentH: 22, overtimeH: 10, earnedH: 150, machineH: 44, stops: { MECH: 4 } })], "Welding");
    expect(w.rosteredH).toBe(220);
    expect(w.workedH).toBe(208);
    // a machine-hour stopped idles 208 / 44 man-hours
    expect(w.stopsH).toBeCloseTo(18.9, 1);
    expect(w.stops[0]).toMatchObject({ code: "MECH", label: "Breakdown — mechanical", planned: false, machineH: 4 });
    expect(w.performanceH).toBeCloseTo(208 - 18.9 - 150, 0);
    expect(w.efficiency).toBeCloseTo(150 / 208, 5);
    const run = w.steps.reduce((s, x) => (x.total ? x.hours : s + x.hours), 0);
    expect(run).toBeCloseTo(w.earnedH, 0);
    expect(w.steps.map((s) => s.key)).toEqual(["rostered", "absence", "overtime", "worked", "stops", "performance", "earned"]);
  });

  it("never lets the stops idle more than the hours not earned", () => {
    const w = lossWaterfall([day({ workedH: 100, earnedH: 90, machineH: 10, stops: { MATERIAL: 8 } })], "Welding");
    expect(w.stopsH).toBe(10);
    expect(w.performanceH).toBe(0);
  });

  it("counts a stop one for one where a centre keeps no machine hours, and reads faster than standard as a gain", () => {
    const w = lossWaterfall([day({ workedH: 50, earnedH: 60, stops: { OTHER: 2 } })], "Welding");
    expect(w.stopsH).toBe(0); // nothing unearned to idle
    expect(w.performanceH).toBe(-10);
    expect(w.steps.find((s) => s.key === "performance")).toMatchObject({ label: "Faster than standard", hours: 10 });
  });

  it("takes one centre's days, or every centre's", () => {
    const days = [day({ workedH: 100, earnedH: 80 }), day({ centre: "Painting", workedH: 50, earnedH: 50 }), day({ centre: "Painting", absentH: 11 })];
    expect(lossWaterfall(days, "Painting")).toMatchObject({ days: 1, workedH: 50, absentH: 11, rosteredH: 61 });
    expect(lossWaterfall(days, null)).toMatchObject({ days: 2, workedH: 150, earnedH: 130 });
  });
  it("counts a day nobody worked for its absence only — never its output as earned", () => {
    const w = lossWaterfall([day({ workedH: 100, earnedH: 80 }), day({ dateISO: "2026-10-21", absentH: 22, earnedH: 15 })], "Welding");
    expect(w).toMatchObject({ days: 1, workedH: 100, earnedH: 80, absentH: 22, rosteredH: 122 });
    expect(w.efficiency).toBe(0.8);
  });
});

describe("explainChange", () => {
  const before = lossWaterfall([day({ workedH: 200, earnedH: 160, machineH: 40, stops: { MECH: 2 }, absentH: 10 })], "Welding");

  it("names what took the efficiency down — the stops, and which", () => {
    const now = lossWaterfall([day({ workedH: 200, earnedH: 130, machineH: 40, stops: { MECH: 2, MATERIAL: 6 }, absentH: 10 })], "Welding");
    const c = explainChange(before, now);
    expect(c.change).toBe(-15);
    expect(c.drivers.find((d) => d.key === "stops")!.points).toBe(15);
    expect(c.text).toBe("Welding fell from 80% to 65% (−15 pts): machine stops took 15 pts more of the hours worked — most of it no material (30 man-h).");
  });

  it("says when it held, when it rose, and when absence moved", () => {
    expect(explainChange(before, before).text).toBe("Welding held its efficiency (80%, ±0 pts).");
    const up = lossWaterfall([day({ workedH: 200, earnedH: 180, machineH: 40, stops: { MECH: 2 }, absentH: 40 })], "Welding");
    expect(explainChange(before, up).text).toBe("Welding rose from 80% to 90% (+10 pts): slower than standard / not logged took 10 pts less. Absence rose by 11.9 pts of the rostered hours.");
  });

  it("does not compare without recorded days", () => {
    expect(explainChange(lossWaterfall([], "Welding"), before).change).toBeNull();
  });
});

describe("biggestLoss", () => {
  it("names where to look first, as a share of the rostered hours", () => {
    expect(biggestLoss(lossWaterfall([day({ workedH: 100, earnedH: 70, absentH: 50 })], "Welding"))).toBe("Welding's biggest loss is absence: 50 man-h, 33% of the rostered hours.");
    expect(biggestLoss(lossWaterfall([day({ workedH: 100, earnedH: 100 })], null))).toBe("The floor earned all the hours it worked.");
    expect(biggestLoss(lossWaterfall([], null))).toBeNull();
  });
});
