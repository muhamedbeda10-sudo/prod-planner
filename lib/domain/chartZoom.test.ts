import { describe, it, expect } from "vitest";
import { ZOOM_MAX, ZOOM_ONE, clampView, panBy, wheelFactor, zoomAt } from "./chartZoom";

describe("clampView", () => {
  it("never shrinks the chart below its own size", () => {
    expect(clampView({ k: 0.5, x: 30, y: -10 }, 400, 300)).toEqual(ZOOM_ONE);
  });
  it("caps the zoom", () => {
    expect(clampView({ k: 99, x: 0, y: 0 }, 400, 300).k).toBe(ZOOM_MAX);
  });
  it("keeps the chart covering the frame", () => {
    expect(clampView({ k: 2, x: 50, y: -900 }, 400, 300)).toEqual({ k: 2, x: 0, y: -300 });
  });
  it("falls back to the plain view on a broken number", () => {
    expect(clampView({ k: Number.NaN, x: 0, y: 0 }, 400, 300)).toEqual(ZOOM_ONE);
  });
});

describe("zoomAt", () => {
  it("keeps the point under the pointer still", () => {
    const v = zoomAt(ZOOM_ONE, 2, 100, 60, 400, 300);
    expect(v).toEqual({ k: 2, x: -100, y: -60 });
    // the chart point that sat at (100, 60) is still drawn there
    expect((100 - v.x) / v.k).toBe(100);
  });
  it("zooming back out returns to the plain view", () => {
    const v = zoomAt(zoomAt(ZOOM_ONE, 3, 200, 100, 400, 300), 1 / 3, 50, 20, 400, 300);
    expect(v).toEqual(ZOOM_ONE);
  });
});

describe("panBy", () => {
  it("moves a zoomed chart, up to its edges", () => {
    const v = { k: 2, x: -100, y: -100 };
    expect(panBy(v, 40, -20, 400, 300)).toEqual({ k: 2, x: -60, y: -120 });
    expect(panBy(v, 500, -500, 400, 300)).toEqual({ k: 2, x: 0, y: -300 });
  });
  it("does nothing at the plain view", () => {
    expect(panBy(ZOOM_ONE, 40, 40, 400, 300)).toEqual(ZOOM_ONE);
  });
});

describe("wheelFactor", () => {
  it("zooms in on a wheel up and out on a wheel down, by the same step", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1);
  });
  it("takes a pinch's small steps gently, and caps a huge one", () => {
    expect(wheelFactor(-4)).toBeLessThan(1.05);
    expect(wheelFactor(-5000)).toBe(wheelFactor(-100));
  });
  it("never zooms less for a bigger step", () => {
    const steps = [1, 10, 30, 49, 50, 80, 100, 400].map((d) => wheelFactor(-d));
    steps.slice(1).forEach((f, i) => expect(f).toBeGreaterThanOrEqual(steps[i]));
  });
  it("does nothing on no step", () => {
    expect(wheelFactor(0)).toBe(1);
  });
  it("reads a wheel counted in lines like one counted in pixels", () => {
    expect(wheelFactor(-3, 1)).toBe(wheelFactor(-99));
  });
});
