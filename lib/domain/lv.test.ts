import { describe, expect, it } from "vitest";
import { spreadOverGroup } from "./groupSpread";
import { LV_CHAIN, LV_STAGES, lvCaps, lvChainError, lvChainViolation, lvComplete, lvDeptPermKey, lvFed, lvGroupMembers, lvPermKey, lvStageAt, lvWaiting, lvWorklistBucket, type LvState } from "./lv";

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

  it("types every tracker column with the stage's own key — the worklist's", () => {
    expect(lvPermKey("Punching")).toBe("lv.punching");
    expect(lvPermKey("Bending")).toBe("lv.bending");
    expect(lvPermKey("Welding")).toBe("lv.welding");
    expect(lvPermKey("Painting")).toBe("lv.painting");
    expect(lvPermKey("Delivered")).toBe("lv.tracker.delivered");
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

describe("an LV stage's worklist", () => {
  it("owes what the stage before finished and this one has not", () => {
    expect(lvWaiting(st({ punch: 8, bend: 3 }), "Bending")).toBe(5);
    expect(lvWaiting(st({ required: 10, punch: 4 }), "Punching")).toBe(6);
    expect(lvWaiting(st({ weld: 6, paint: 6 }), "Painting")).toBe(0);
  });

  it("owes nothing on an order with no quantity — there is no plan to work from", () => {
    expect(lvWaiting(st({ required: 0 }), "Punching")).toBe(0);
  });

  it("knows what the stage before has handed over — the plan, for punching", () => {
    expect(lvFed(st({ punch: 4 }), "Punching")).toBe(10);
    expect(lvFed(st({ required: 0, punch: 4 }), "Punching")).toBe(0);
    expect(lvFed(st({ punch: 4, bend: 1 }), "Bending")).toBe(4);
    expect(lvFed(st({ weld: 6 }), "Painting")).toBe(6);
  });

  it("puts every open order in exactly one place on the list", () => {
    // 4 punched, all 4 bent, 10 ordered: bending has caught up with punching
    // and waits for more — it must not vanish from the bending list
    const caughtUp = st({ required: 10, punch: 4, bend: 4 });
    expect(lvWorklistBucket(caughtUp, "Bending")).toBe("upstream");
    expect(lvWorklistBucket(caughtUp, "Welding")).toBe("rows");
    expect(lvWaiting(caughtUp, "Welding")).toBe(4);
    expect(lvWorklistBucket(caughtUp, "Punching")).toBe("rows");
    expect(lvWorklistBucket(st({ required: 10, punch: 0 }), "Bending")).toBe("upstream");
    expect(lvWorklistBucket(st({ required: 10, punch: 10, bend: 10 }), "Bending")).toBe("finished");
  });

  it("names an order with no quantity rather than hiding it among the unfed", () => {
    expect(lvWorklistBucket(st({ required: 0, punch: 3 }), "Punching")).toBe("unplanned");
    expect(lvWorklistBucket(st({ required: 0 }), "Bending")).toBe("unplanned");
    // what the stages before did on it is still real work for the next one
    expect(lvWorklistBucket(st({ required: 0, punch: 3 }), "Bending")).toBe("rows");
    expect(lvWorklistBucket(st({ required: 0, punch: 3, bend: 3 }), "Bending")).toBe("upstream");
  });

  it("opens each worklist with the panels' own key for that stage", () => {
    expect(lvDeptPermKey("Punching")).toBe("lv.punching");
    expect(lvDeptPermKey("Bending")).toBe("lv.bending");
    expect(lvDeptPermKey("Welding")).toBe("lv.welding");
    expect(lvDeptPermKey("Painting")).toBe("lv.painting");
  });

  it("knows the stage each bay of the shared floor works on a panel", () => {
    expect(lvStageAt("Cut")).toBe("Punching"); // the fabrication bay's punches
    expect(lvStageAt("Welding")).toBe("Welding");
    expect(lvStageAt("Painting")).toBe("Painting");
    expect(lvStageAt("ShotBlast")).toBeNull(); // takes no panels
  });

});

describe("lvChainViolation — the whole chain after an edit", () => {
  it("holds when every stage is within the one before it", () => {
    expect(lvChainViolation(st({ punch: 8, bend: 6, weld: 4, paint: 4, delivered: 2 }), "MO-1")).toBeNull();
  });

  it("catches a punching row lowered under the bending after it", () => {
    expect(lvChainViolation(st({ punch: 3, bend: 6 }), "MO-1")).toMatch(/6 bent but only 3 punched/);
  });

  it("names the LAST broken link first — delivery over painting before anything upstream", () => {
    expect(lvChainViolation(st({ punch: 1, bend: 5, weld: 5, paint: 5, delivered: 7 }), "MO-1")).toMatch(/delivered/);
  });

  it("catches punching beyond the order, and ignores the cap on an order with no quantity", () => {
    expect(lvChainViolation(st({ punch: 12 }), "MO-1")).toMatch(/for 10 panels/);
    expect(lvChainViolation(st({ required: 0, punch: 12 }), "MO-1")).toBeNull();
  });
});
