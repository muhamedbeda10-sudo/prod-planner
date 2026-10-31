import { describe, expect, it } from "vitest";
import { correctionDays } from "./corrections";

const r = (dateISO: string, qty: number) => ({ dateISO, qty });

describe("correctionDays", () => {
  it("dates a correction on the day of the work it takes back", () => {
    expect(correctionDays([r("2026-10-14", 30), r("2026-10-15", 10)], 10, "2026-10-17")).toEqual([r("2026-10-15", -10)]);
  });
  it("takes back the most recent output first, over as many days as it needs", () => {
    expect(correctionDays([r("2026-10-14", 30), r("2026-10-15", 10)], 25, "2026-10-17")).toEqual([r("2026-10-15", -10), r("2026-10-14", -15)]);
  });
  it("carries an earlier correction (typed on a later day) into the days before it", () => {
    // +10 on the 14th and 15th, −10 typed on the 17th: the 15th is already taken back
    expect(correctionDays([r("2026-10-14", 10), r("2026-10-15", 10), r("2026-10-17", -10)], 5, "2026-10-20")).toEqual([r("2026-10-14", -5)]);
  });
  it("puts what no day can cover on today, and nothing for nothing", () => {
    expect(correctionDays([r("2026-10-14", 3)], 5, "2026-10-17")).toEqual([r("2026-10-14", -3), r("2026-10-17", -2)]);
    expect(correctionDays([], 4, "2026-10-17")).toEqual([r("2026-10-17", -4)]);
    expect(correctionDays([r("2026-10-14", 3)], 0, "2026-10-17")).toEqual([]);
  });
});
