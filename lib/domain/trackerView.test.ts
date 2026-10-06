import { describe, it, expect } from "vitest";
import { ITEMS, type Item } from "./constants";
import { itemFinishShare, rowBottleneck, type ItemProgress } from "./trackerView";

const none = (): ItemProgress => ({ eligible: true, excluded: false, osp: 0, cut: 0, weld: 0, paint: 0, shp: 0 });
const done = (n: number): ItemProgress => ({ ...none(), cut: n, weld: n, paint: n, shp: n });
function items(over: Partial<Record<Item, ItemProgress>>): Record<Item, ItemProgress> {
  return Object.fromEntries(ITEMS.map((it) => [it, over[it] ?? done(10)])) as Record<Item, ItemProgress>;
}

describe("rowBottleneck", () => {
  it("is null when every needed component is made", () => {
    expect(rowBottleneck(10, items({}))).toBeNull();
  });
  it("picks the component furthest from finished, at its first uncleared stage", () => {
    const r = rowBottleneck(10, items({ TC: { ...none(), cut: 10, weld: 4, paint: 2 }, TN: { ...none(), cut: 10, weld: 10, paint: 6 } }));
    expect(r).toEqual({ item: "TC", stage: "Welding" });
  });
  it("reads the core's finish as shot blast, and skips what the order does not need", () => {
    const r = rowBottleneck(10, items({
      CF: { ...none(), cut: 10, weld: 10, paint: 0, shp: 10 },
      AR: { ...none(), eligible: false },
      MB: { ...none(), excluded: true },
      CB: { ...none(), cut: 3 },
    }));
    expect(r).toEqual({ item: "CB", stage: "Cut" });
  });
  it("counts outsourced pieces off the target", () => {
    expect(rowBottleneck(10, items({ TN: { ...none(), osp: 10 } }))).toBeNull();
  });
});

describe("itemFinishShare", () => {
  it("is the last making stage over what is owed", () => {
    expect(itemFinishShare(10, "TN", { ...none(), paint: 5 })).toBe(0.5);
    expect(itemFinishShare(10, "CF", { ...none(), shp: 10, paint: 0 })).toBe(1);
    expect(itemFinishShare(10, "AR", { ...none(), eligible: false })).toBeNull();
  });
});
