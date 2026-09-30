import { describe, expect, it } from "vitest";
import { parseChildMos, pickChildMo, sheetPlanMonth } from "./childMos";

const head = ["SN", "SOI", "MO", "BoM Ref.", "QTY", "Plan_Month", "Component_Type", "Child_MO", "Parent_MO", "Product_Code", "Child_Qty", "UoM", "State", "Link_Method", "Flag", "Child_Remarks"];
const row = (mo: string, comp: string, child: string | null, qty: number | null, state: string | null, flag: string | null = null, remarks: string | null = null) =>
  [1, "S1", mo, "B1", 2, "10-2026", comp, child, "PF01/MO/1", "FB-022-B1", qty, "PC", state, "direct", flag, remarks];

describe("parseChildMos", () => {
  it("reads one row per plan MO × component × child, and counts the flagged ones", () => {
    const p = parseChildMos([
      head,
      row("pf01/mo/36331-001", "TANK", "SF01/MO/19515", 2, "done"),
      row("PF01/MO/36331-001", "FINS", "SF01/MO/19519", 2, "done"),
      row("PF01/MO/36331-001", "CABLE_BOX", "PF01/MO/44582", 2, "confirmed"),
      row("PF01/MO/36331-001", "CABLE_BOX", "PF01/MO/44584", 2, "confirmed"),
      row("PF01/MO/36331-001", "ARRESTER", null, null, null, "NOT_IN_BOM"),
      row("PF01/MO/36331-002", "CABLE_BOX", "PF01/MO/44582", 2, "confirmed", null, "Shared with PF01/MO/36331-001"),
    ]);
    expect(p.present).toBe(true);
    expect(p.rows).toHaveLength(5);
    expect(p.rows[0]).toMatchObject({ planMo: "PF01/MO/36331-001", component: "TANK", item: "TN", childMo: "SF01/MO/19515", qty: 2, state: "done", planMonth: "10-2026" });
    expect(p.rows[1].item).toBeNull(); // fins
    expect(p.rows[4]).toMatchObject({ planMo: "PF01/MO/36331-002", remarks: "Shared with PF01/MO/36331-001" });
    expect(p.flagged).toEqual({ NOT_IN_BOM: 1 });
  });

  it("is absent on a plain plan", () => {
    expect(parseChildMos([["MO", "BoM Ref.", "QTY"], ["PF01/MO/1", "B1", 3]]).present).toBe(false);
  });
});

describe("sheetPlanMonth", () => {
  it("reads the sheet's Plan_Month as the app's label", () => {
    expect(sheetPlanMonth([head, row("PF01/MO/1", "TANK", "SF01/MO/1", 1, "confirmed")])).toBe("October 2026");
    expect(sheetPlanMonth([["MO", "Plan_Month"], ["X", "2026-11"]])).toBe("November 2026");
    expect(sheetPlanMonth([["MO", "Plan_Month"], ["X", "Dec 2026"]])).toBe("December 2026");
    expect(sheetPlanMonth([["MO", "BoM Ref."], ["X", "B"]])).toBeNull();
  });
});

describe("pickChildMo", () => {
  const kids = [
    { childMo: "A", qty: 2, state: "done" },
    { childMo: "B", qty: 3, state: "confirmed" },
    { childMo: "C", qty: 10, state: "progress" },
  ];
  it("skips closed children and takes the first open one that holds the closing", () => {
    expect(pickChildMo(kids, new Map(), 2)).toBe("B");
    expect(pickChildMo(kids, new Map([["B", 2]]), 2)).toBe("C");
  });
  it("falls back to any open one with room, then to none", () => {
    expect(pickChildMo(kids, new Map([["C", 9]]), 5)).toBe("B");
    expect(pickChildMo(kids, new Map([["B", 3], ["C", 10]]), 1)).toBeNull();
    expect(pickChildMo([{ childMo: "X", qty: null, state: "confirmed" }], new Map([["X", 99]]), 4)).toBe("X");
  });
});
