import { describe, it, expect } from "vitest";
import { computeReallocations, applyReallocations } from "./reallocate";
import { makeBomGrouper } from "./bom";

describe("computeReallocations", () => {
  const grouper = makeBomGrouper(["12011E13M12", "12011E14M12"]);

  it("moves excess-over-target from a donor to a same-family sibling with deficit", () => {
    // Family 12011|M12. E13 target CF=2 but logged 5 (excess 3).
    // E14 target CF=4 but logged 1 (deficit 3). Expect a move of 3 E13->E14.
    const orders = [
      { bom: "12011E13M12", item: "CF", targetQty: 2 },
      { bom: "12011E14M12", item: "CF", targetQty: 4 },
    ];
    const logs = [
      { id: 1, date: new Date("2026-07-04"), dept: "Cut", bom: "12011E13M12", item: "CF", qty: 5 },
      { id: 2, date: new Date("2026-07-04"), dept: "Cut", bom: "12011E14M12", item: "CF", qty: 1 },
    ];
    const moves = computeReallocations(orders, logs, grouper);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ dept: "Cut", item: "CF", fromBom: "12011E13M12", toBom: "12011E14M12", qty: 3 });

    const logged = new Map<string, number>([
      ["Cut|12011E13M12|CF", 5],
      ["Cut|12011E14M12|CF", 1],
    ]);
    const eff = applyReallocations(logged, moves);
    expect(eff.get("Cut|12011E13M12|CF")).toBe(2);
    expect(eff.get("Cut|12011E14M12|CF")).toBe(4);
  });

  it("does not move between different families", () => {
    const g = makeBomGrouper(["12011E13M12", "12011E13M13"]); // M12 vs M13 -> different families
    const orders = [
      { bom: "12011E13M12", item: "CF", targetQty: 2 },
      { bom: "12011E13M13", item: "CF", targetQty: 4 },
    ];
    const logs = [
      { id: 1, date: new Date(), dept: "Cut", bom: "12011E13M12", item: "CF", qty: 5 },
      { id: 2, date: new Date(), dept: "Cut", bom: "12011E13M13", item: "CF", qty: 1 },
    ];
    expect(computeReallocations(orders, logs, g)).toHaveLength(0);
  });

  it("produces no moves when nothing exceeds target (matches the seed data)", () => {
    const orders = [
      { bom: "12011E13M12", item: "CF", targetQty: 5 },
      { bom: "12011E14M12", item: "CF", targetQty: 5 },
    ];
    const logs = [
      { id: 1, date: new Date(), dept: "Cut", bom: "12011E13M12", item: "CF", qty: 3 },
      { id: 2, date: new Date(), dept: "Cut", bom: "12011E14M12", item: "CF", qty: 2 },
    ];
    expect(computeReallocations(orders, logs, grouper)).toHaveLength(0);
  });
});
