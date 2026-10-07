import { describe, it, expect } from "vitest";
import { expectedSheets, partsDoneAt, runDescription, runIdOf, runMo, runSheet } from "./nestRun";

describe("nestRun", () => {
  it("keys and words", () => {
    expect(runIdOf(runMo(7))).toBe(7);
    expect(runIdOf("PF01/MO/1")).toBeNull();
    const r = { sheets: 5, thicknessMm: 3, material: "Steel", sheetSize: "1250*2500", parts: [{ id: 1, bom: "B1", mo: "M1", item: "TN", pcs: 12, donePcs: 0, consumedPcs: 0 }] };
    expect(runSheet(r)).toBe("3|Steel|1250*2500");
    expect(runDescription(r)).toBe("🧩 5 × 3 mm MS 1250×2500 — B1 TN ×12");
  });
  it("parts follow the sheets finished, rounded down, whole on the last sheet", () => {
    const parts = [{ id: 1, pcs: 12 }, { id: 2, pcs: 5 }];
    expect([...partsDoneAt(parts, 5, 2).values()]).toEqual([4, 2]);
    expect([...partsDoneAt(parts, 5, 5).values()]).toEqual([12, 5]);
    expect([...partsDoneAt(parts, 5, 9).values()]).toEqual([12, 5]);
  });
  it("expected sheets from the nesting's rates", () => {
    expect(expectedSheets([{ pcs: 10, perUnit: 0.4 }, { pcs: 4, perUnit: null }])).toBe(4);
    expect(expectedSheets([{ pcs: 10, perUnit: null }])).toBeNull();
  });
});
