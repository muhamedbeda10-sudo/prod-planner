import { describe, it, expect } from "vitest";
import {
  FLOOR_TREND_WINDOW, centresOf, efficiencyGrid, floorDays, floorDefault, floorDeptOf, floorPieces, floorRange, floorRequest, floorStat, groupProductivity, groupsOf,
  isFloorDept, ledgerGroups, productivityTrend, recordedDates,
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
    expect(floorRange("2026-10-20", "2026-10-30", today)).toEqual({ fromISO: "2026-10-20", toISO: today, clamped: true });
    expect(floorRange("2026-10-24", "2026-10-20", today)).toEqual({ fromISO: "2026-10-20", toISO: "2026-10-24", clamped: false });
    expect(floorRange("2026-06-01", today, today)).toEqual({ fromISO: "2026-07-27", toISO: today, clamped: true });
    expect(floorRange(today, today, today)).toEqual({ fromISO: today, toISO: today, clamped: false });
  });
  it("keeps a period wholly in the future at today, whichever way round", () => {
    expect(floorRange("2026-11-01", "2026-11-30", today)).toEqual({ fromISO: today, toISO: today, clamped: true });
    expect(floorRange("2026-11-01", "2026-10-01", today)).toMatchObject({ fromISO: "2026-10-01", toISO: today });
  });
  it("starts no earlier than the history it keeps, so an old link reads only its own days", () => {
    expect(floorRange("2000-01-01", "2000-01-02", today)).toEqual({ fromISO: "2026-04-30", toISO: "2026-04-30", clamped: true });
  });
  it("allows exactly 92 days", () => {
    expect(floorRange("2026-07-27", today, today).clamped).toBe(false);
    expect(floorRange("2026-07-26", today, today)).toMatchObject({ fromISO: "2026-07-27", clamped: true });
  });
});

describe("a request, as the page and the assistant read it", () => {
  const today = "2026-10-26";
  it("defaults to the last 7 days and every department", () => {
    expect(floorRequest({}, today)).toEqual({ fromISO: "2026-10-20", toISO: today, dept: "all", clamped: false, isDefault: true });
    expect(floorDefault(today)).toEqual({ label: "Last 7 days", from: "2026-10-20", to: today });
  });
  it("counts the default start back from the end asked for", () => {
    expect(floorRequest({ to: "2026-09-30" }, today)).toMatchObject({ fromISO: "2026-09-24", toISO: "2026-09-30", isDefault: false });
  });
  it("normalises a day, and ignores one that is not a day or comes twice", () => {
    expect(floorRequest({ from: " 2026-10-01 ", to: "2026-10-10" }, today)).toMatchObject({ fromISO: "2026-10-01", toISO: "2026-10-10" });
    expect(floorRequest({ from: "2026-02-30", to: ["2026-10-01", "2026-10-02"] }, today)).toMatchObject({ fromISO: "2026-10-20", toISO: today });
  });
  it("reads the roster's department names too", () => {
    expect(floorRequest({ dept: "Cut" }, today).dept).toBe("Fabrication");
    expect(floorDeptOf("Painting")).toBe("Painting");
    expect(floorDeptOf("Cutting")).toBe("all");
    expect(floorDeptOf(["Welding"])).toBe("all");
  });
});

describe("the days of the period", () => {
  it("joins each centre-day to its shift-log rows, adds a day the crew was all away, and keeps only the period and the centres", () => {
    const days = [
      day("2026-10-20", "Welding", { overtimeH: 0, rows: 0, absent: 0 }),
      day("2026-10-21", "Painting"),
      day("2026-10-25", "Welding"),
    ];
    const out = floorDays(days, [
      { dateISO: "2026-10-20", centre: "Welding", rows: 3, absent: 1, overtimeH: 2 },
      { dateISO: "2026-10-22", centre: "Welding", rows: 2, absent: 2, overtimeH: 0 },
      { dateISO: "2026-10-22", centre: "Painting", rows: 1, absent: 1, overtimeH: 0 },
    ], ["Welding"], "2026-10-20", "2026-10-24");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ dateISO: "2026-10-20", rows: 3, absent: 1, overtimeH: 2, workedH: 8 });
    expect(out[1]).toMatchObject({ dateISO: "2026-10-22", centre: "Welding", workedH: 0, rows: 2, absent: 2 });
    const s = floorStat(out);
    expect(s.days).toBe(1);
    expect(s.attendance).toBeCloseTo(2 / 5, 10);
  });
  it("counts a painted piece for shot blast as well as painting, as the Shifts page does", () => {
    expect(ledgerGroups("Painting")).toEqual(["ShotBlast", "Painting"]);
    expect(ledgerGroups("ShotBlast")).toEqual(["ShotBlast"]);
    expect(ledgerGroups("Cut")).toEqual(["Fabrication"]);
    expect(ledgerGroups("Delivered")).toEqual([]);
  });
  it("sets each record's pieces against the departments kept, and prices each record once", () => {
    const { pieces, pricedShare } = floorPieces([
      { dateISO: "2026-10-20", groups: ["ShotBlast", "Painting"], pieces: 10, priced: true },
      { dateISO: "2026-10-21", groups: ["Fabrication"], pieces: 30, priced: false },
      { dateISO: "2026-10-30", groups: ["Painting"], pieces: 99, priced: false },
    ], ["ShotBlast", "Painting", "Fabrication"], "2026-10-20", "2026-10-24");
    expect(pieces).toEqual([
      { dateISO: "2026-10-20", group: "ShotBlast", pieces: 10 },
      { dateISO: "2026-10-20", group: "Painting", pieces: 10 },
      { dateISO: "2026-10-21", group: "Fabrication", pieces: 30 },
    ]);
    expect(pricedShare).toBe(0.25);
    expect(floorPieces([], ["Welding"], "2026-10-20", "2026-10-24").pricedShare).toBeNull();
  });
});

describe("the floor's figures, at their edges", () => {
  it("counts no earned hours, machine hours or people on a day without booked hours", () => {
    const s = floorStat([
      day("2026-10-20", "Welding", { workedH: 20, people: 2, earnedH: 15, machineH: 16 }),
      day("2026-10-21", "Welding", { workedH: 0, earnedH: 5, machineH: 16, people: 3, rows: 0 }),
    ]);
    expect(s.efficiency).toBe(0.75);
    expect(s.personDays).toBe(2);
    expect(s.availability).toBe(1);
  });
  it("never reads machines as less than none available", () => {
    expect(floorStat([day("2026-10-20", "Welding", { machineH: 8, downtimeH: 12 })]).availability).toBe(0);
  });
  it("keeps a department that only stopped, and nets corrections in its pieces", () => {
    const [weld] = groupProductivity([day("2026-10-20", "Welding", { workedH: 0, people: 0, earnedH: 0, downtimeH: 3, rows: 0 })], [], ["Welding"]);
    expect(weld).toMatchObject({ group: "Welding", days: 0, downtimeH: 3, piecesPerPersonDay: null });
    const [fab] = groupProductivity([day("2026-10-20", "Cutting", { people: 2 })], [
      { dateISO: "2026-10-20", group: "Fabrication", pieces: 30 },
      { dateISO: "2026-10-20", group: "Fabrication", pieces: -10 },
    ], ["Fabrication"]);
    expect(fab.pieces).toBe(20);
    expect(fab.piecesPerPersonDay).toBe(10);
  });
  it("puts the trend in date order whatever order the days come in, over 7 recorded days by default", () => {
    const days = Array.from({ length: 9 }, (_, i) => day(`2026-10-${String(20 - i).padStart(2, "0")}`, "Welding", { workedH: 10, earnedH: i === 8 ? 100 : 10 }));
    const t = productivityTrend(days);
    expect(FLOOR_TREND_WINDOW).toBe(7);
    expect(t.map((p) => p.dateISO)).toEqual([...t.map((p) => p.dateISO)].sort());
    expect(t[0]).toMatchObject({ dateISO: "2026-10-12", efficiency: 10 });
    // the 8th day's line no longer carries the first day
    expect(t[7].rolling).toBe(1);
    expect(t[6].rolling).toBeCloseTo(160 / 70, 10);
    expect(recordedDates(days)).toHaveLength(9);
  });
});
