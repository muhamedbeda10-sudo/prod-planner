import { describe, expect, it } from "vitest";
import { AI_DOCK_DEFAULT, AI_DOCK_MAX, AI_DOCK_MIN, AI_DOCK_PAGE_MIN, clampDockWidth, dockMax } from "./aiDock";

describe("the docked assistant's width", () => {
  it("stays between its narrowest and widest", () => {
    expect(clampDockWidth(100)).toBe(AI_DOCK_MIN);
    expect(clampDockWidth(5000)).toBe(AI_DOCK_MAX);
    expect(clampDockWidth(512.4)).toBe(512);
  });
  it("is the usual width when nothing readable was kept", () => {
    expect(clampDockWidth(undefined)).toBe(AI_DOCK_DEFAULT);
    expect(clampDockWidth("600")).toBe(AI_DOCK_DEFAULT);
    expect(clampDockWidth(Number.NaN, 1920)).toBe(AI_DOCK_DEFAULT);
  });
  it("leaves the page beside it room to work", () => {
    expect(clampDockWidth(1000, 1280)).toBe(1280 - AI_DOCK_PAGE_MIN);
    expect(clampDockWidth(undefined, 800)).toBe(800 - AI_DOCK_PAGE_MIN);
    // never below its narrowest, however small the screen
    expect(clampDockWidth(600, 700)).toBe(AI_DOCK_MIN);
    expect(clampDockWidth(800, 2560)).toBe(800);
  });
  it("names the widest it can be on a screen", () => {
    expect(dockMax()).toBe(AI_DOCK_MAX);
    expect(dockMax(1280)).toBe(1280 - AI_DOCK_PAGE_MIN);
    expect(dockMax(600)).toBe(AI_DOCK_MIN);
  });
});
