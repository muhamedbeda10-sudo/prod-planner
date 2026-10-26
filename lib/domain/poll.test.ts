import { describe, expect, it } from "vitest";
import { askOnReturn, pollDelay } from "./poll";

const pace = { visibleMs: 30_000, hiddenMs: 120_000 };

describe("a page's polling pace", () => {
  it("asks at its own pace in front and much less often out of sight", () => {
    expect(pollDelay(true, pace)).toBe(30_000);
    expect(pollDelay(false, pace)).toBe(120_000);
  });

  it("counts the pace from the last ask, never below zero", () => {
    expect(pollDelay(true, pace, 10_000)).toBe(20_000);
    expect(pollDelay(false, pace, 10_000)).toBe(110_000);
    expect(pollDelay(true, pace, 45_000)).toBe(0);
  });

  it("asks nothing out of sight when told so", () => {
    expect(pollDelay(false, { visibleMs: 5_000, hiddenMs: null })).toBeNull();
    expect(pollDelay(false, { visibleMs: 5_000, hiddenMs: null }, 99_000)).toBeNull();
    expect(pollDelay(true, { visibleMs: 5_000, hiddenMs: null })).toBe(5_000);
  });

  it("coming back asks now only when the last answer is a whole interval old", () => {
    expect(askOnReturn(null, 1_000_000, pace)).toBe(true);
    expect(askOnReturn(1_000_000 - 30_000, 1_000_000, pace)).toBe(true);
    expect(askOnReturn(1_000_000 - 29_999, 1_000_000, pace)).toBe(false);
  });
});
