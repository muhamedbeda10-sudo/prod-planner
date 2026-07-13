import { describe, it, expect } from "vitest";
import { parseWeeklyPlan } from "./importPlan";

// Build a 30-col row; cells is a map of 0-based index -> value.
function row(cells: Record<number, unknown>): unknown[] {
  const r = new Array(30).fill(null);
  for (const [k, v] of Object.entries(cells)) r[Number(k)] = v;
  return r;
}
// grid index 5=day0 CF, 6=day0 TC, 7=day0 TN, 8=day0 CB, 9=day1 CF ...
const dayCell = (day: number, item: number) => 5 + 4 * day + item;

describe("parseWeeklyPlan", () => {
  const grid: unknown[][] = [];
  grid[5] = row({
    0: "12011E13M12", 1: "S001", 2: "MO1", 3: "1000kva", 4: 6,
    [dayCell(0, 0)]: 3, [dayCell(1, 0)]: 2, // CF grid = 5
    [dayCell(0, 1)]: 1, // TC grid = 1
    29: "2 TN & TC BALANCE FROM WEEK-24",
  });
  grid[6] = row({
    // A empty -> BOM carried down; MO2 required 4, no balance remark
    2: "MO2", 4: 4, [dayCell(0, 3)]: 4, // CB grid = 4
  });
  grid[7] = row({
    0: "99001E11M11", 2: "MO3", 4: 2, 29: "5 CF BALANCE FROM WEEK-24", // 5 > required 2 -> double count
  });

  const parsed = parseWeeklyPlan(grid);
  const find = (mo: string, item: string) => parsed.orders.find((o) => o.mo === mo && o.item === item)!;

  it("emits one order row per MO x item", () => {
    expect(parsed.orders).toHaveLength(3 * 4);
    expect(parsed.orderRowCount).toBe(3);
  });

  it("carries the merged BOM value down to rows with an empty A", () => {
    expect(find("MO2", "CF").bom).toBe("12011E13M12");
  });

  it("DATES-ONLY role: targetQty = the scheduled grid sum, remarks are never parsed", () => {
    // MO1 carries a BALANCE remark — it must be IGNORED
    expect(find("MO1", "CF").targetQty).toBe(5); // grid 3 + 2
    expect(find("MO1", "TC").targetQty).toBe(1); // grid 1 only (no +balance)
    expect(find("MO1", "TN").targetQty).toBe(0); // nothing scheduled
    expect(find("MO1", "CF").plannerBalance).toBeNull();
    expect(find("MO1", "TC").plannerBalance).toBeNull();
  });

  it("plannerBalance is always null and unscheduled items get target 0", () => {
    for (const it of ["CF", "TC", "TN"]) {
      expect(find("MO2", it).targetQty).toBe(0);
      expect(find("MO2", it).plannerBalance).toBeNull();
    }
    expect(find("MO2", "CB").targetQty).toBe(4); // the only scheduled cell
  });

  it("creates schedule rows only for non-zero grid cells, dated by day offset", () => {
    const mo1 = parsed.schedules.filter((s) => s.mo === "MO1");
    expect(mo1).toHaveLength(3); // CF day0, CF day1, TC day0
    expect(mo1.find((s) => s.item === "CF" && s.dayOffset === 1)!.qty).toBe(2);
    expect(parsed.schedules.filter((s) => s.mo === "MO2")).toHaveLength(1); // CB day0
  });

  it("no balance-related warnings — remarks are reference-only now", () => {
    expect(parsed.warnings.find((w) => w.kind === "double-count")).toBeUndefined();
  });
});
