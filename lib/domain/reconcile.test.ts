import { describe, it, expect } from "vitest";
import { computeReconciliation, type ReconOrder } from "./reconcile";

const rows4 = (bom: string, mo: string, req: number, tgt: number, bal?: number | null): ReconOrder[] =>
  (["CF", "TC", "TN", "CB"] as const).map((item) => ({ bom, mo, item, requiredQty: req, targetQty: tgt, plannerBalance: bal ?? null }));

describe("computeReconciliation", () => {
  it("flags a CONTINUED target that deviates from oldTarget - welded", () => {
    const prev = rows4("A11E11M11", "MO1", 10, 10);
    const cur = rows4("A11E11M11", "MO1", 10, 8); // expected = 10 - 3 = 7, new 8 -> delta +1
    const weldedPrev = new Map([["A11E11M11|CF", 3]]);
    const rows = computeReconciliation(cur, prev, weldedPrev, new Map());
    const cf = rows.find((r) => r.item === "CF")!;
    expect(cf.category).toBe("CONTINUED");
    expect(cf.expected).toBe(7);
    expect(cf.delta).toBe(1);
  });

  it("flags DROPPED_WITH_BACKLOG when an MO disappears with remaining work", () => {
    const prev = rows4("B11E11M11", "MO2", 6, 6);
    const cur: ReconOrder[] = []; // dropped
    const weldedPrev = new Map([["B11E11M11|CF", 2]]);
    const rows = computeReconciliation(cur, prev, weldedPrev, new Map());
    const cf = rows.find((r) => r.item === "CF")!;
    expect(cf.category).toBe("DROPPED_WITH_BACKLOG");
    expect(cf.backlog).toBe(4); // 6 - 2
    expect(cf.severity).toBe("high");
  });

  it("flags NEW MOs", () => {
    const cur = rows4("C11E11M11", "MOx", 5, 5);
    const rows = computeReconciliation(cur, [], new Map(), new Map());
    expect(rows.every((r) => r.category === "NEW")).toBe(true);
    expect(rows[0].newMOs).toContain("MOx");
  });

  it("flags a BALANCE CONFLICT when planner balance != expected carry-over", () => {
    // prev target 10, welded under prev 6 -> expected carry 4; remark balance says 2
    const cur = rows4("D11E11M11", "MO1", 10, 10, 2);
    const prev = rows4("D11E11M11", "MO1", 10, 10);
    const weldedPrev = new Map([["D11E11M11|CF", 6]]);
    const rows = computeReconciliation(cur, prev, weldedPrev, new Map());
    const cf = rows.find((r) => r.item === "CF")!;
    expect(cf.balanceConflict).toBe(true);
    expect(cf.actualRemaining).toBe(4); // = expected (oldTarget - weldedPrev)
    expect(cf.plannerBalance).toBe(2);
  });

  it("does NOT flag a balance conflict when the remark matches expected carry-over", () => {
    // prev target 10, welded 6 -> expected 4; remark says 4 -> clean
    const cur = rows4("D12E11M11", "MO1", 10, 4, 4);
    const prev = rows4("D12E11M11", "MO1", 10, 10);
    const weldedPrev = new Map(
      (["CF", "TC", "TN", "CB"] as const).map((it) => [`D12E11M11|${it}`, 6])
    );
    const rows = computeReconciliation(cur, prev, weldedPrev, new Map());
    expect(rows.every((r) => !r.balanceConflict)).toBe(true);
  });

  it("classifies a dropped code as MOVED when a family sibling is in the new plan", () => {
    // E13M12 dropped with backlog, but E16M12 (same base+M) exists in the new plan
    const prev = rows4("12011E13M12", "MO1", 8, 8);
    const cur = rows4("12011E16M12", "MO9", 8, 8);
    const weldedPrev = new Map([["12011E13M12|CF", 3]]);
    const rows = computeReconciliation(cur, prev, weldedPrev, new Map());
    const moved = rows.find((r) => r.bom === "12011E13M12" && r.item === "CF")!;
    expect(moved.category).toBe("MOVED");
    expect(moved.severity).toBe("warn");
    expect(moved.backlog).toBe(5); // 8 - 3
    expect(moved.message).toContain("12011E16M12");
    // and the new sibling is flagged as NEW with the family note
    const fresh = rows.find((r) => r.bom === "12011E16M12" && r.item === "CF")!;
    expect(fresh.category).toBe("NEW");
    expect(fresh.message).toContain("12011E13M12");
  });

  it("omits perfectly-continued rows with no conflict", () => {
    const prev = rows4("E11E11M11", "MO1", 10, 10);
    const cur = rows4("E11E11M11", "MO1", 10, 7); // expected 10-3=7, delta 0
    const rows = computeReconciliation(cur, prev, new Map([["E11E11M11|CF", 3], ["E11E11M11|TC", 3], ["E11E11M11|TN", 3], ["E11E11M11|CB", 3]]), new Map());
    expect(rows).toHaveLength(0);
  });
});
