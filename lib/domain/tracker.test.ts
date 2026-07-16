import { describe, it, expect } from "vitest";
import { computeTracker, type TrackerOrderRow, type TrackerLogRow } from "./tracker";

// Build the 4 item rows for one MO.
function moRows(bom: string, mo: string, required: number, target: Record<string, number>, kva = "3000kva"): TrackerOrderRow[] {
  return (["CF", "TC", "TN", "CB"] as const).map((item) => ({
    bom, mo, description: kva, item, requiredQty: required, targetQty: target[item] ?? 0,
  }));
}

describe("computeTracker", () => {
  it("reproduces the 64016E11M11 sheet row (2 MOs merged, MIN-component complete)", () => {
    // MO-A required 4, MO-B required 2 -> Required 6.
    // Targets chosen so pre = required - target = [CF4, TC2, TN2, CB4] with no logging.
    const orders: TrackerOrderRow[] = [
      ...moRows("64016E11M11", "MO-A", 4, { CF: 2, TC: 4, TN: 4, CB: 2 }),
      ...moRows("64016E11M11", "MO-B", 2, { CF: 0, TC: 0, TN: 0, CB: 0 }),
    ];
    const [row] = computeTracker(orders, []);
    expect(row.bom).toBe("64016E11M11");
    expect(row.required).toBe(6);
    expect(row.moCount).toBe(2);
    expect(row.moLabel).toBe("MO-A +1 MO");
    expect(row.items.CF.weldDone).toBe(4);
    expect(row.items.TC.weldDone).toBe(2);
    expect(row.items.TN.weldDone).toBe(2);
    expect(row.items.CB.weldDone).toBe(4);
    expect(row.complete).toBe(2); // MIN of paintDone (= pre here, nothing logged)
    expect(row.remaining).toBe(4);
    expect(row.achievement).toBeCloseTo(2 / 6, 9);
  });

  it("complete follows PAINT for TC/TN/CB but WELD for the paint-exempt core CF", () => {
    const orders = moRows("X3E11M11", "MO1", 5, { CF: 5, TC: 5, TN: 5, CB: 5 }); // pre 0
    const logs: TrackerLogRow[] = (["CF", "TC", "TN", "CB"] as const).flatMap((item) => [
      { dept: "Welding", bom: "X3E11M11", item, qty: 5 },
      { dept: "Painting", bom: "X3E11M11", item, qty: 2 },
    ]);
    const [row] = computeTracker(orders, logs);
    // CF's final stage is welding (it's never painted) → counts 5
    // TC/TN/CB counts their paint (2) → MIN(5,2,2,2) = 2
    expect(row.complete).toBe(2);
    expect(row.remaining).toBe(3);
  });

  it("CF welded but not painted does not block completion (painted trio decides it)", () => {
    const orders = moRows("X4E11M11", "MO1", 5, { CF: 5, TC: 5, TN: 5, CB: 5 });
    const logs: TrackerLogRow[] = [
      { dept: "Welding", bom: "X4E11M11", item: "CF", qty: 5 }, // core finished at welding
      { dept: "Painting", bom: "X4E11M11", item: "TC", qty: 5 },
      { dept: "Painting", bom: "X4E11M11", item: "TN", qty: 5 },
      { dept: "Painting", bom: "X4E11M11", item: "CB", qty: 5 },
    ];
    const [row] = computeTracker(orders, logs);
    expect(row.complete).toBe(5); // 100% even though CF paint = 0
    expect(row.remaining).toBe(0);
  });

  it("logged Cut/Welding stacks on top of previous-week progress and caps at Required", () => {
    // Required 10, target 10 -> pre 0. Log 4 cut + 3 weld for each item.
    const orders = moRows("X1E11M11", "MO1", 10, { CF: 10, TC: 10, TN: 10, CB: 10 });
    const logs: TrackerLogRow[] = [
      { dept: "Cut", bom: "X1E11M11", item: "CF", qty: 4 },
      { dept: "Welding", bom: "X1E11M11", item: "CF", qty: 3 },
    ];
    const [row] = computeTracker(orders, logs);
    expect(row.items.CF.cutDone).toBe(4);
    expect(row.items.CF.weldDone).toBe(3);
    expect(row.complete).toBe(0); // TC/TN/CB have no paint yet
  });

  it("caps done at Required even when pre + logged exceeds it", () => {
    const orders = moRows("X2E11M11", "MO1", 5, { CF: 0, TC: 0, TN: 0, CB: 0 }); // pre = 5 each
    const logs: TrackerLogRow[] = [{ dept: "Welding", bom: "X2E11M11", item: "CF", qty: 9 }];
    const [row] = computeTracker(orders, logs);
    expect(row.items.CF.weldDone).toBe(5); // capped
  });

  it("keeps different raw BOMs as separate rows (no BomGroup merge in the tracker)", () => {
    const orders = [
      ...moRows("12011E13M12", "MO1", 3, { CF: 3, TC: 3, TN: 3, CB: 3 }),
      ...moRows("12011E14M12", "MO2", 5, { CF: 5, TC: 5, TN: 5, CB: 5 }),
    ];
    const rows = computeTracker(orders, []);
    expect(rows.map((r) => r.bom).sort()).toEqual(["12011E13M12", "12011E14M12"]);
  });
});
