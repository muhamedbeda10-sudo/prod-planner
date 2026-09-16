import { describe, expect, it } from "vitest";
import { spreadOverGroup } from "./groupSpread";
import { LV_CHAIN, LV_STAGES, lvCaps, lvChainError, lvComplete, lvGroupMembers, lvPermKey, type LvState } from "./lv";

const st = (over: Partial<LvState> = {}): LvState => ({ required: 10, punch: 0, bend: 0, weld: 0, paint: 0, delivered: 0, ...over });

describe("an LV panel's chain — punched, bent, welded, painted, delivered", () => {
  it("passes the four stages in that order, then delivery", () => {
    expect(LV_STAGES).toEqual(["Punching", "Bending", "Welding", "Painting"]);
    expect(LV_CHAIN).toEqual(["Punching", "Bending", "Welding", "Painting", "Delivered"]);
  });

  it("caps punching at the order quantity, and leaves it open when there is none", () => {
    expect(lvCaps(st({ punch: 4 }), "Punching").add).toBe(6);
    expect(lvCaps(st({ required: 0, punch: 4 }), "Punching").add).toBe(Number.POSITIVE_INFINITY);
  });

  it("lets each stage take only what the stage before it finished", () => {
    expect(lvCaps(st({ punch: 6, bend: 2 }), "Bending").add).toBe(4);
    expect(lvCaps(st({ bend: 6, weld: 5 }), "Welding").add).toBe(1);
    expect(lvCaps(st({ weld: 6, paint: 6 }), "Painting").add).toBe(0);
    expect(lvCaps(st({ paint: 7, delivered: 2 }), "Delivered").add).toBe(5);
  });

  it("will not take back what the next stage already consumed", () => {
    expect(lvCaps(st({ punch: 6, bend: 6 }), "Punching").sub).toBe(0);
    expect(lvCaps(st({ punch: 6, bend: 2 }), "Punching").sub).toBe(4);
    expect(lvCaps(st({ paint: 5, delivered: 3 }), "Painting").sub).toBe(2);
    expect(lvCaps(st({ delivered: 3 }), "Delivered").sub).toBe(3);
  });

  it("says why a change is refused, in the cell's own words", () => {
    expect(lvChainError(st({ punch: 3 }), "Bending", 4, "MO-1")).toMatch(/only 3 punched/);
    expect(lvChainError(st({ punch: 9 }), "Punching", 2, "MO-1")).toMatch(/order is for 10/);
    expect(lvChainError(st({ punch: 6, bend: 4 }), "Punching", -3, "MO-1")).toMatch(/cannot drop below 4/);
    expect(lvChainError(st({ punch: 6, bend: 4 }), "Punching", -2, "MO-1")).toBeNull();
    expect(lvChainError(st(), "Welding", 0, "MO-1")).toBeNull();
  });

  it("records punching and bending behind the fabrication key, the rest behind their own", () => {
    expect(lvPermKey("Punching")).toBe("tracker.cut");
    expect(lvPermKey("Bending")).toBe("tracker.cut");
    expect(lvPermKey("Welding")).toBe("tracker.weld");
    expect(lvPermKey("Painting")).toBe("tracker.paint");
    expect(lvPermKey("Delivered")).toBe("tracker.delivered");
  });

  it("spreads a merged row's total over its MOs in order, each to its own room", () => {
    const members = lvGroupMembers(
      [
        { mo: "MO-1", state: st({ required: 5, punch: 5, bend: 5 }) },
        { mo: "MO-2", state: st({ required: 8, punch: 8, bend: 3 }) },
        { mo: "MO-3", state: st({ required: 4, punch: 4, bend: 0 }) },
      ],
      "Bending"
    );
    // 8 bent so far; 14 asked: MO-1 is full, MO-2 takes its last 5, MO-3 one
    expect(spreadOverGroup(members, 14 - 8).alloc).toEqual([{ mo: "MO-2", qty: 5 }, { mo: "MO-3", qty: 1 }]);
  });

  it("counts an order complete by its painted panels, capped at the order", () => {
    expect(lvComplete(st({ paint: 7 }))).toBe(7);
    expect(lvComplete(st({ paint: 12 }))).toBe(10);
  });
});
