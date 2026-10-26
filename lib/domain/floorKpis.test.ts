import { describe, it, expect } from "vitest";
import {
  centresOf, efficiencyGrid, floorRange, floorStat, groupProductivity, groupsOf, isFloorDept, productivityTrend,
  type FloorDay, type FloorPieces,
} from "./floorKpis";
import { groupOfCentre } from "./kpis";
import type { WorkCentre } from "./shifts";

const day = (dateISO: string, centre: WorkCentre, o: Partial<FloorDay> = {}): FloorDay => ({
  dateISO, centre, workedH: 8, people: 1, earnedH: 8, machineH: 0, downtimeH: 0, overtimeH: 0, rows: 1, absent: 0, ...o,
});

describe("the department filter", () => {
  it("knows its departments and their centres", () => {
    expect(isFloorDept("all")).toBe(true);
    expect(isFloorDept("Fabrication")).toBe(true);
    expect(isFloorDept("Cutting")).toBe(false);
    expect(isFloorDept(null)).toBe(false);
    expect(centresOf("Fabrication")).toEqual(["Cutting", "Bending", "Fins"]);
    expect(centresOf("Welding")).toEqual(["Welding"]);
    expect(centresOf("all")).toHaveLength(6);
    expect(groupsOf("all")).toEqual(["Fabrication", "Welding", "ShotBlast", "Painting"]);
    expect(groupsOf("Painting")).toEqual(["Painting"]);
    expect(groupOfCentre("Fins")).toBe("Fabrication");
    expect(groupOfCentre("ShotBlast")).toBe("ShotBlast");
  });
});

describe("the floor over a period", () => {
  it("adds up hours, people, overtime and attendance; a day without hours counts only its stops", () => {
    const s = floorStat([
      day("2026-10-20", "Welding", { workedH: 20, people: 2, earnedH: 15, overtimeH: 4, rows: 3, absent: 1, machineH: 16, downtimeH: 2 }),
      day("2026-10-21", "Welding", { workedH: 16, people: 2, earnedH: 18, rows: 2, machineH: 16 }),
      day("2026-10-22", "Welding", { workedH: 0, people: 0, earnedH: 0, rows: 0, downtimeH: 4 }),
    ]);
    expect(s.days).toBe(2);
    expect(s.workedH).toBe(36);
    expect(s.earnedH).toBe(33);
    expect(s.efficiency).toBeCloseTo(33 / 36, 10);
    expect(s.personDays).toBe(4);
    expect(s.people).toBe(2);
    expect(s.stdPerPersonDay).toBeCloseTo(33 / 4, 10);
    expect(s.overtimeShare).toBeCloseTo(4 / 36, 10);
    expect(s.attendance).toBeCloseTo(4 / 5, 10);
    expect(s.downtimeH).toBe(6);
    expect(s.availability).toBeCloseTo(1 - 6 / 32, 10);
  });
  it("reads nothing from nothing", () => {
    const s = floorStat([]);
    expect([s.days, s.efficiency, s.stdPerPersonDay, s.overtimeShare, s.attendance, s.availability]).toEqual([0, null, null, null, null, null]);
  });
  it("counts several centres on one day as one recorded day", () => {
    const s = floorStat([day("2026-10-20", "Cutting"), day("2026-10-20", "Bending")]);
    expect(s.days).toBe(1);
    expect(s.people).toBe(2);
  });
});

describe("the efficiency heatmap", () => {
  it("lines each centre's days up under the dates, with the period's figure, and leaves out a centre that booked nothing", () => {
    const rows = efficiencyGrid(
      [day("2026-10-20", "Welding", { workedH: 10, earnedH: 5 }), day("2026-10-22", "Welding", { workedH: 10, earnedH: 15 }), day("2026-10-20", "Painting", { workedH: 0, earnedH: 3 })],
      ["Welding", "Painting"],
      ["2026-10-20", "2026-10-21", "2026-10-22"],
    );
    expect(rows.map((r) => r.centre)).toEqual(["Welding"]);
    expect(rows[0].cells.map((c) => c.efficiency)).toEqual([0.5, null, 1.5]);
    expect(rows[0].total).toBe(1);
    expect(rows[0].days).toBe(2);
  });
});

describe("what a department turns out", () => {
  it("sets the pieces of the days it booked hours against its person-days", () => {
    const days = [
      day("2026-10-20", "Cutting", { people: 2, workedH: 16, earnedH: 12 }),
      day("2026-10-20", "Bending", { people: 1, workedH: 8, earnedH: 8 }),
      day("2026-10-21", "Cutting", { people: 2, workedH: 16, earnedH: 16 }),
    ];
    const pieces: FloorPieces[] = [
      { dateISO: "2026-10-20", group: "Fabrication", pieces: 30 },
      { dateISO: "2026-10-21", group: "Fabrication", pieces: 20 },
      // a day nobody booked: its pieces wait for the day they belong to
      { dateISO: "2026-10-22", group: "Fabrication", pieces: 99 },
      { dateISO: "2026-10-20", group: "Welding", pieces: 5 },
    ];
    const [fab, ...rest] = groupProductivity(days, pieces, ["Fabrication", "Welding"]);
    expect(rest).toEqual([]); // welding booked nothing
    expect(fab.group).toBe("Fabrication");
    expect(fab.personDays).toBe(5);
    expect(fab.pieces).toBe(50);
    expect(fab.piecesPerPersonDay).toBe(10);
    expect(fab.stdPerPersonDay).toBeCloseTo(36 / 5, 10);
  });
});

describe("the productivity trend", () => {
  it("gives each recorded day its efficiency and the rolling figure over the window", () => {
    const t = productivityTrend([
      day("2026-10-20", "Welding", { workedH: 10, earnedH: 5, people: 1 }),
      day("2026-10-20", "Painting", { workedH: 10, earnedH: 5, people: 1 }),
      day("2026-10-21", "Welding", { workedH: 10, earnedH: 20, people: 2 }),
      day("2026-10-22", "Welding", { workedH: 0, earnedH: 4 }),
      day("2026-10-23", "Welding", { workedH: 10, earnedH: 10, people: 1 }),
    ], 2);
    expect(t.map((p) => p.dateISO)).toEqual(["2026-10-20", "2026-10-21", "2026-10-23"]);
    expect(t[0].efficiency).toBe(0.5);
    expect(t[0].stdPerPersonDay).toBe(5);
    expect(t[1].rolling).toBeCloseTo(30 / 30, 10);
    expect(t[2].rolling).toBeCloseTo(30 / 20, 10);
  });
});

describe("the period asked for", () => {
  const today = "2026-10-26";
  it("never runs past today, turns a reversed period round, and is cut at its start when too long", () => {
    expect(floorRange("2026-10-20", "2026-10-30", today)).toEqual({ fromISO: "2026-10-20", toISO: today });
    expect(floorRange("2026-10-24", "2026-10-20", today)).toEqual({ fromISO: "2026-10-20", toISO: "2026-10-24" });
    expect(floorRange("2025-01-01", today, today)).toEqual({ fromISO: "2026-07-27", toISO: today });
    expect(floorRange(today, today, today)).toEqual({ fromISO: today, toISO: today });
  });
});
