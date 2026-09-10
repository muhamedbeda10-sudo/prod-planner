import { describe, expect, it } from "vitest";
import { CENTERS, MACHINE_DEPTS, ROUTING, SHIFTS, centerShares, dayTotals, hoursOfShift, isShiftCode, isShiftDept, lineHours, machineAvailable, routeFor, shiftLabel } from "./shifts";
import { SHEET_ITEMS } from "./constants";

describe("lineHours", () => {
  it("is the shift plus overtime, nothing when absent", () => {
    expect(lineHours({ present: true, shift: "S9", overtimeH: 0 })).toBe(9);
    expect(lineHours({ present: true, shift: "S11", overtimeH: 3 })).toBe(14);
    expect(lineHours({ present: false, shift: "S11", overtimeH: 3 })).toBe(0);
    expect(lineHours({ present: true, shift: "S9", overtimeH: -2 })).toBe(9);
    expect(lineHours({ present: true, shift: "S9", overtimeH: NaN })).toBe(9);
  });
});

describe("dayTotals", () => {
  it("counts the present, sums their hours and overtime, and loads the machines", () => {
    const t = dayTotals([
      { present: true, shift: "S9", overtimeH: 3, machineId: 1 },
      { present: true, shift: "S11", overtimeH: 0, machineId: 1 },
      { present: false, shift: "S9", overtimeH: 3, machineId: 2 },
      { present: true, shift: "S9", overtimeH: 1.5, machineId: null },
    ]);
    expect(t).toEqual({ workers: 4, present: 3, hours: 33.5, overtimeH: 4.5, byMachine: { 1: 23 } });
  });
  it("is all zero for an empty department", () => {
    expect(dayTotals([])).toEqual({ workers: 0, present: 0, hours: 0, overtimeH: 0, byMachine: {} });
  });
});

describe("machineAvailable", () => {
  it("takes the downtime off the day, never below zero, null without a figure", () => {
    expect(machineAvailable(9, 2)).toBe(7);
    expect(machineAvailable(9, 12)).toBe(0);
    expect(machineAvailable(null, 2)).toBeNull();
  });
});

describe("the plant's shape", () => {
  it("runs a 9-hour and an 11-hour shift", () => {
    expect(SHIFTS).toEqual({ S9: 9, S11: 11 });
    expect(isShiftCode("S11")).toBe(true);
    expect(isShiftCode("S8")).toBe(false);
  });
  it("has machines in fabrication, shot blast and painting; welding has partitions", () => {
    expect(MACHINE_DEPTS).toEqual(["Cut", "Welding", "ShotBlast", "Painting"]);
    expect(CENTERS.Welding).toEqual(["Zone"]);
    expect(isShiftDept("LeakTest")).toBe(false);
  });
  it("routes every sheet component through cutting first, the tank through fins last", () => {
    for (const it of SHEET_ITEMS) expect(ROUTING[it][0]).toBe("Cutting");
    expect(ROUTING.TN).toEqual(["Cutting", "Bending", "Fins"]);
    expect(ROUTING.TC).toEqual(["Cutting"]);
  });

  it("gives a department outside fabrication its one centre as the whole route", () => {
    expect(routeFor("Painting", "TN")).toEqual(["Line"]);
    expect(routeFor("Welding", "CF")).toEqual(["Zone"]);
    expect(routeFor("Cut", "TN")).toEqual(["Cutting", "Bending", "Fins"]);
    expect(routeFor("Cut", "AR")).toEqual(["Cutting"]); // no routing figures — cut only
  });

  it("splits a piece's stage hours over its own centres, by the crew that does the work", () => {
    const tank = centerShares("Cut", "TN");
    expect(Object.keys(tank)).toEqual(["Cutting", "Bending", "Fins"]);
    expect(Object.values(tank).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(tank.Cutting).toBeCloseTo(15 / 33, 6);
    expect(tank.Fins).toBeCloseTo(10 / 33, 6);
    // a top cover never sees a press, so its whole cut is cutting
    expect(centerShares("Cut", "TC")).toEqual({ Cutting: 1 });
    // a core frame shares between the two centres it does pass
    expect(centerShares("Cut", "CF").Bending).toBeCloseTo(8 / 23, 6);
    expect(centerShares("Painting", "TN")).toEqual({ Line: 1 });
  });
});

describe("shift hours the planner sets", () => {
  const hrs = { short: 8, long: 12, overtime: 2 };
  it("counts a day with the hours in force, not the ones in the code", () => {
    expect(lineHours({ present: true, shift: "S9", overtimeH: 0 }, hrs)).toBe(8);
    expect(lineHours({ present: true, shift: "S11", overtimeH: 2 }, hrs)).toBe(14);
    expect(lineHours({ present: false, shift: "S11", overtimeH: 2 }, hrs)).toBe(0);
    expect(hoursOfShift("S11", hrs)).toBe(12);
    expect(shiftLabel("S9", hrs)).toBe("8 h");
  });
  it("falls back to the plant's own 9 and 11 when nothing is set", () => {
    expect(lineHours({ present: true, shift: "S9", overtimeH: 0 })).toBe(9);
    expect(lineHours({ present: true, shift: "S11", overtimeH: 3 })).toBe(14);
  });
  it("totals a day with them", () => {
    const t = dayTotals([
      { present: true, shift: "S11", overtimeH: 2, machineId: 1 },
      { present: true, shift: "S9", overtimeH: 0, machineId: 1 },
      { present: false, shift: "S9", overtimeH: 0 },
    ], hrs);
    expect(t.hours).toBe(22);
    expect(t.byMachine[1]).toBe(22);
    expect(t.present).toBe(2);
  });
});

