import { describe, expect, it } from "vitest";
import { CENTERS, DEPT_CENTRES, centreDept, centreOf, machineWorkCentre, MACHINE_DEPTS, ROUTING, SHIFTS, attendanceLine, attendanceOf, centerShares, dayTotals, isAttendance, overtimeFits, roundOvertime, shiftSplit, hoursOfShift, isShiftCode, isShiftDept, lineHours, machineAvailable, routeFor, shiftLabel } from "./shifts";
import { SHEET_ITEMS } from "./constants";

describe("lineHours", () => {
  it("is the shift plus overtime, nothing when absent", () => {
    expect(lineHours({ present: true, shift: "S9", overtimeH: 0 })).toBe(8);
    expect(lineHours({ present: true, shift: "S11", overtimeH: 3 })).toBe(11);
    expect(lineHours({ present: false, shift: "S11", overtimeH: 3 })).toBe(0);
    expect(lineHours({ present: true, shift: "S9", overtimeH: -2 })).toBe(8);
    expect(lineHours({ present: true, shift: "S9", overtimeH: NaN })).toBe(8);
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
    expect(t).toEqual({ workers: 4, present: 3, hours: 28.5, overtimeH: 4.5, byMachine: { 1: 19 } });
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
  it("runs 8 base hours on both shifts after each break", () => {
    expect(SHIFTS).toEqual({ S9: 8, S11: 8 });
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
    expect(shiftLabel("S9", hrs)).toBe("Day · 8 h");
  });
  it("uses 8 base hours and optional 3 overtime hours by default", () => {
    expect(lineHours({ present: true, shift: "S9", overtimeH: 0 })).toBe(8);
    expect(lineHours({ present: true, shift: "S11", overtimeH: 3 })).toBe(11);
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


describe("who came on which shift", () => {
  const hrs = { short: 8, long: 11, overtime: 3 };
  it("reads one choice — day, night or absent — off a line, and unset while the day has no record", () => {
    expect(attendanceOf({ recorded: false, present: false, shift: "S9" })).toBe("unset");
    expect(attendanceOf({ recorded: true, present: false, shift: "S11" })).toBe("absent");
    expect(attendanceOf({ recorded: true, present: true, shift: "S9" })).toBe("day");
    expect(attendanceOf({ recorded: true, present: true, shift: "S11" })).toBe("night");
    // a line from the database is recorded by being there
    expect(attendanceOf({ present: true, shift: "S11" })).toBe("night");
    expect(isAttendance("night")).toBe(true);
    expect(isAttendance("unset")).toBe(false);
  });

  it("keeps overtime on either shift, clearing it for absence or a different shift", () => {
    expect(attendanceLine("day", { overtimeH: 3 })).toEqual({ present: true, shift: "S9", overtimeH: 3 });
    expect(attendanceLine("night", { shift: "S11", overtimeH: 3 })).toEqual({ present: true, shift: "S11", overtimeH: 3 });
    expect(attendanceLine("night", { shift: "S9", overtimeH: 3 })).toEqual({ present: true, shift: "S11", overtimeH: 0 });
    expect(attendanceLine("absent", { overtimeH: 3 })).toEqual({ present: false, shift: "S9", overtimeH: 0 });
    expect(attendanceLine("day", { overtimeH: 0 }, true)).toEqual({ present: false, shift: "S9", overtimeH: 0 });
  });

  it("splits the day's people and man-hours by shift", () => {
    const s = shiftSplit([
      { recorded: true, present: true, shift: "S9", overtimeH: 3 },
      { recorded: true, present: true, shift: "S9", overtimeH: 0 },
      { recorded: true, present: true, shift: "S11", overtimeH: 0 },
      { recorded: true, present: false, shift: "S9", overtimeH: 0 },
      { recorded: false, present: false, shift: "S9", overtimeH: 0 },
    ], hrs);
    expect(s).toEqual({
      workers: 5,
      day: { people: 2, hours: 19, overtimePeople: 1, overtimeH: 3 },
      night: { people: 1, hours: 11, overtimePeople: 0, overtimeH: 0 },
      absent: 1,
      unset: 1,
      hours: 30,
    });
    // the same man-hours the day's total counts
    expect(s.hours).toBe(dayTotals([
      { present: true, shift: "S9", overtimeH: 3 }, { present: true, shift: "S9", overtimeH: 0 }, { present: true, shift: "S11", overtimeH: 0 },
    ], hrs).hours);
  });

  it("an empty list is all zeros", () => {
    expect(shiftSplit([])).toEqual({ workers: 0, day: { people: 0, hours: 0, overtimePeople: 0, overtimeH: 0 }, night: { people: 0, hours: 0, overtimePeople: 0, overtimeH: 0 }, absent: 0, unset: 0, hours: 0 });
  });
});

describe("work centres", () => {
  it("books a Fabrication worker to his section's centre, the day's own when it is Fabrication's", () => {
    expect(centreOf("Cut", ["BendingTX"])).toBe("Bending");
    expect(centreOf("Cut", ["Channels"])).toBe("Bending");
    expect(centreOf("Cut", ["Fins"], "Cutting")).toBe("Cutting");
    // a centre that is not Fabrication's is ignored
    expect(centreOf("Cut", ["Fins"], "Welding")).toBe("Fins");
    expect(centreOf("Cut", [])).toBe("Cutting");
    expect(centreOf("Welding", ["WeldingTX"])).toBeNull();
    expect(centreOf("WeldingLV", ["WeldingLV"])).toBeNull();
  });

  it("counts a machine's hours at its work centre — tubes and roll blanks are cutting", () => {
    expect(machineWorkCentre("Cut", "Tubes")).toBe("Cutting");
    expect(machineWorkCentre("Cut", "Bending")).toBe("Bending");
    expect(machineWorkCentre("Painting", "Line")).toBe("Painting");
    expect(machineWorkCentre("Punching", "Line")).toBeNull();
    expect(machineWorkCentre("Cut", "SomethingNew")).toBeNull();
    expect(centreDept("Fins")).toBe("Cut");
    expect(DEPT_CENTRES.Cut).toEqual(["Cutting", "Bending", "Fins"]);
  });
});


describe("night overtime", () => {
  it("counts 8 without OT and 11 with OT, including machine and split totals", () => {
    const night = { present: true, shift: "S11" as const, overtimeH: 3, machineId: 7 };
    expect(lineHours({ ...night, overtimeH: 0 })).toBe(8);
    expect(lineHours(night)).toBe(11);
    expect(dayTotals([night])).toMatchObject({ hours: 11, overtimeH: 3, byMachine: { 7: 11 } });
    expect(shiftSplit([night]).night).toEqual({ people: 1, hours: 11, overtimePeople: 1, overtimeH: 3 });
    expect(shiftSplit([{ ...night, present: false }]).hours).toBe(0);
  });
});

describe("shiftSplit rounds the day's hours once", () => {
  it("agrees with dayTotals when both shifts end in a quarter hour", () => {
    const h = { short: 7.75, long: 7.75, overtime: 0, nightOvertime: 0 };
    const day = { present: true, shift: "S9" as const, overtimeH: 0 };
    const night = { present: true, shift: "S11" as const, overtimeH: 0 };
    const s = shiftSplit([day, day, day, night, night, night], h);
    // 23.25 + 23.25 = 46.5 — not 23.3 + 23.3 = 46.6
    expect(s.hours).toBe(46.5);
    expect(s.day.hours).toBe(23.3);
    expect(s.hours).toBe(dayTotals([day, day, day, night, night, night].map((l) => ({ ...l, dept: "Welding", workerId: 1, center: null, note: null })) as never, h).hours);
  });
});

describe("overtimeFits", () => {
  it("accepts none, the fixed period, or the figure the row already holds", () => {
    expect(overtimeFits(0, 3, undefined)).toBe(true);
    expect(overtimeFits(3, 3, undefined)).toBe(true);
    expect(overtimeFits(3.0005, 3, undefined)).toBe(true);
    expect(overtimeFits(3.002, 3, undefined)).toBe(false);
    expect(overtimeFits(2.25, 3, 2.25)).toBe(true);
    expect(overtimeFits(2.5, 3, undefined)).toBe(false);
    expect(overtimeFits(2.5, 3, 0)).toBe(false);
  });
});

describe("roundOvertime", () => {
  it("keeps the hundredth Settings keeps", () => {
    expect(roundOvertime(2.254)).toBe(2.25);
    expect(roundOvertime(2.25)).toBe(2.25);
    expect(roundOvertime(3)).toBe(3);
  });
});
