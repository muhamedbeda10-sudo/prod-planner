import { describe, expect, it } from "vitest";
import { CENTERS, MACHINE_DEPTS, ROUTING, SHIFTS, dayTotals, isShiftCode, isShiftDept, lineHours, machineAvailable } from "./shifts";
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
});
