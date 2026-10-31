import { describe, expect, it } from "vitest";
import { correctionDays, isCorrectionNote } from "./corrections";

const r = (dateISO: string, qty: number, planNo = 41) => ({ dateISO, qty, planNo });

describe("correctionDays", () => {
  it("dates a correction on the day of the work it takes back, under that work's plan", () => {
    expect(correctionDays([r("2026-10-14", 30), r("2026-10-15", 10, 0)], 10, "2026-10-17", 44)).toEqual([r("2026-10-15", -10, 0)]);
  });
  it("takes back the most recent output first, over as many days as it needs", () => {
    expect(correctionDays([r("2026-10-14", 30), r("2026-10-15", 10)], 25, "2026-10-17", 44)).toEqual([r("2026-10-15", -10), r("2026-10-14", -15)]);
  });
  it("carries an earlier correction (typed on a later day) into the work before it", () => {
    // +10 on the 14th and 15th, −10 typed on the 17th: the 15th is already taken back
    expect(correctionDays([r("2026-10-14", 10), r("2026-10-15", 10), r("2026-10-17", -10)], 5, "2026-10-20", 44)).toEqual([r("2026-10-14", -5)]);
  });
  it("never dates a correction ahead of today", () => {
    expect(correctionDays([r("2026-10-14", 5), r("2026-11-02", 5)], 3, "2026-10-31", 44)).toEqual([r("2026-10-14", -3)]);
  });
  it("puts what the work cannot cover on today's plan, and nothing for nothing", () => {
    expect(correctionDays([r("2026-10-14", 3)], 5, "2026-10-17", 44)).toEqual([r("2026-10-14", -3), r("2026-10-17", -2, 44)]);
    expect(correctionDays([], 4, "2026-10-17", 44)).toEqual([r("2026-10-17", -4, 44)]);
    expect(correctionDays([r("2026-10-14", 3)], 0, "2026-10-17", 44)).toEqual([]);
  });
});

describe("isCorrectionNote", () => {
  it("knows a correction row by its note", () => {
    expect(isCorrectionNote("tracker correction: total 15 → 8")).toBe(true);
    expect(isCorrectionNote("group correction: B1 TN total 9 → 5")).toBe(true);
    expect(isCorrectionNote("re-delivered (was: dent)")).toBe(false);
    expect(isCorrectionNote(null)).toBe(false);
  });
});
