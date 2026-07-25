import { describe, it, expect } from "vitest";
import { computePlanVsActual, stageOfEntry, type PvaScheduleRow, type PvaEntryRow } from "./planVsActual";
import { dayNumber, utcDate, toISODate, dateFromDayNumber } from "./dates";

// oven date = Wed 8 July 2026; with the default leads Fabrication is due 4 days
// earlier (Sat 4th) and Welding 1 day earlier (Tue 7th), finishing on the 8th.
const oven = utcDate(2026, 7, 8);
const ovenD = dayNumber(oven);

const base = {
  fromDay: ovenD - 6,
  toDay: ovenD + 1,
  isoOf: (d: number) => toISODate(dateFromDayNumber(d)),
  holidays: new Map<number, string>(),
  leadCut: 4,
  leadWeld: 1,
};

const sched = (over: Partial<PvaScheduleRow> = {}): PvaScheduleRow => ({
  planNo: 1, bom: "A11E11M11", mo: "MO-1", item: "TC", ovenDate: oven, qty: 10, ...over,
});
const entry = (over: Partial<PvaEntryRow> = {}): PvaEntryRow => ({
  date: oven, dept: "Painting", bom: "A11E11M11", mo: "MO-1", item: "TC", qty: 4, ...over,
});
const dayOf = (r: ReturnType<typeof computePlanVsActual>, d: number) => r.days.find((x) => x.iso === toISODate(dateFromDayNumber(d)))!;

describe("computePlanVsActual — the plan's promise per day", () => {
  it("dates each stage by its own lead time off the oven date", () => {
    const r = computePlanVsActual({ ...base, schedules: [sched()], entries: [] });
    expect(dayOf(r, ovenD - 4).perStage.Cut.scheduled).toBe(10); // Fabrication, 4 days before
    expect(dayOf(r, ovenD - 1).perStage.Welding.scheduled).toBe(10); // Welding, 1 day before
    expect(dayOf(r, ovenD).perStage.Painting.scheduled).toBe(10); // finishing, on the oven date
    // no stage is promised on a day it isn't due
    expect(dayOf(r, ovenD).perStage.Cut.scheduled).toBe(0);
  });

  it("delivery is never plan-dated — actual only", () => {
    const r = computePlanVsActual({
      ...base,
      schedules: [sched()],
      entries: [entry({ dept: "Delivered", qty: 3 })],
    });
    expect(r.totals.Delivered.scheduled).toBe(0);
    expect(r.totals.Delivered.done).toBe(3);
  });

  it("only the NEWEST plan's promise counts — a re-import supersedes the old dates", () => {
    const older = sched({ planNo: 1, qty: 10, ovenDate: utcDate(2026, 7, 6) });
    const newer = sched({ planNo: 2, qty: 7, ovenDate: oven });
    const r = computePlanVsActual({ ...base, schedules: [older, newer], entries: [] });
    expect(r.totals.Painting.scheduled).toBe(7); // the newer promise, not 17
    expect(dayOf(r, dayNumber(utcDate(2026, 7, 6))).perStage.Painting.scheduled).toBe(0);
  });

  it("counts actual output on the day it was recorded and nets corrections", () => {
    const r = computePlanVsActual({
      ...base,
      schedules: [sched()],
      entries: [entry({ qty: 6 }), entry({ qty: -2 })], // a tracker correction
    });
    expect(dayOf(r, ovenD).perStage.Painting.done).toBe(4);
    expect(r.totals.Painting.done).toBe(4);
  });

  it("the core's Shot Blast counts as finishing, and never for a painted item", () => {
    expect(stageOfEntry("ShotBlast", "CF")).toBe("Painting");
    expect(stageOfEntry("ShotBlast", "TC")).toBeNull();
    const r = computePlanVsActual({
      ...base,
      schedules: [],
      entries: [entry({ dept: "ShotBlast", item: "CF", qty: 5 })],
    });
    expect(r.totals.Painting.done).toBe(5);
  });

  it("the stage filter scopes both sides and the totals", () => {
    const r = computePlanVsActual({
      ...base,
      schedules: [sched()],
      entries: [entry({ dept: "Cut", qty: 3 }), entry({ dept: "Painting", qty: 9 })],
      stages: ["Cut"],
    });
    expect(Object.keys(r.totals)).toEqual(["Cut"]);
    expect(r.scheduled).toBe(10); // Fabrication's promise only
    expect(r.done).toBe(3); // painting output is out of scope
  });

  it("breaks each day AND each project down per component", () => {
    const r = computePlanVsActual({
      ...base,
      schedules: [sched({ item: "TC", qty: 10 }), sched({ item: "CB", qty: 6 })],
      entries: [
        entry({ item: "TC", qty: 4 }), // finishing, on the oven day
        entry({ item: "CB", qty: 6 }),
        entry({ item: "AR", qty: 2 }), // never in the weekly grid — actual only
      ],
    });
    const d = dayOf(r, ovenD);
    expect(d.items.map((i) => i.item)).toEqual(["TC", "CB", "AR"]); // pipeline order
    const tc = d.items.find((i) => i.item === "TC")!;
    expect(tc.perStage.Painting.scheduled).toBe(10);
    expect(tc.perStage.Painting.done).toBe(4);
    expect(d.items.find((i) => i.item === "AR")!.scheduled).toBe(0); // no promise, output only
    // the same split inside the project row
    const p = r.projects[0];
    expect(p.items.find((i) => i.item === "CB")!.done).toBe(6);
    // the components add up to the row totals — no number can disagree
    expect(p.items.reduce((s, i) => s + i.scheduled, 0)).toBe(p.scheduled);
    expect(p.items.reduce((s, i) => s + i.done, 0)).toBe(p.done);
    expect(d.items.reduce((s, i) => s + i.done, 0)).toBe(d.done);
  });

  it("rolls up per project and marks Fridays as days off", () => {
    const r = computePlanVsActual({
      ...base,
      schedules: [sched(), sched({ bom: "B22", mo: "MO-2", qty: 4 })],
      entries: [entry({ qty: 6 })],
    });
    const a = r.projects.find((p) => p.bom === "A11E11M11")!;
    expect(a.mos).toEqual(["MO-1"]);
    expect(a.perStage.Painting.scheduled).toBe(10);
    expect(a.perStage.Painting.done).toBe(6);
    expect(r.projects[0].bom).toBe("A11E11M11"); // biggest promise first
    // 3 July 2026 is a Friday — the weekly day off
    expect(dayOf(r, dayNumber(utcDate(2026, 7, 3))).isOff).toBe(true);
  });
});
