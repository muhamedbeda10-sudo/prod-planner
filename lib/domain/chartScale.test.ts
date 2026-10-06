import { describe, it, expect } from "vitest";
import { DELTA_MIN_BASE, axisWidth, describeDelta, niceScale } from "./chartScale";

describe("describeDelta", () => {
  it("says nothing without a period before", () => {
    expect(describeDelta(5, null)).toEqual({ kind: "none" });
  });
  it("calls an unchanged figure the same, and a first one new", () => {
    expect(describeDelta(7, 7)).toEqual({ kind: "same" });
    expect(describeDelta(0, 0)).toEqual({ kind: "same" });
    expect(describeDelta(5, 0)).toEqual({ kind: "new" });
  });
  it("writes the change in pieces under the minimum base", () => {
    expect(DELTA_MIN_BASE).toBe(10);
    expect(describeDelta(13, 3)).toEqual({ kind: "abs", diff: 10 });
    expect(describeDelta(2, 9)).toEqual({ kind: "abs", diff: -7 });
  });
  it("writes a percentage from the minimum base up", () => {
    expect(describeDelta(12, 10)).toEqual({ kind: "pct", pct: 20 });
    expect(describeDelta(80, 100)).toEqual({ kind: "pct", pct: -20 });
  });
});

describe("niceScale", () => {
  it("steps by 1, 2 or 5 times a power of ten, with room above the max", () => {
    expect(niceScale(42)).toEqual({ max: 50, ticks: [0, 10, 20, 30, 40, 50] });
    expect(niceScale(100).ticks.at(-1)).toBeGreaterThanOrEqual(112);
    expect(niceScale(3)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
  });
  it("never gives a count a fractional tick", () => {
    expect(niceScale(0).ticks.every(Number.isInteger)).toBe(true);
    expect(niceScale(1).ticks).toEqual([0, 1, 2]);
  });
});

describe("axisWidth", () => {
  it("grows with the widest label", () => {
    expect(axisWidth(100)).toBeGreaterThan(axisWidth(50));
    expect(axisWidth(1250)).toBe(14 + 5 * 7);
  });
});
