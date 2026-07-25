import { describe, it, expect } from "vitest";
import { computePlanVsActual, stageOfEntry, type PvaScheduleRow, type PvaEntryRow, type PvaCumulativeRow } from "./planVsActual";
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
  date: oven, dept: "Painting", bom: "A11E11M11", item: "TC", qty: 4, ...over,
});
const cum = (dept: string, qty: number, over: Partial<PvaCumulativeRow> = {}): PvaCumulativeRow => ({
  bom: "A11E11M11", item: "TC", dept, qty, ...over,
});
const run = (o: Partial<Parameters<typeof computePlanVsActual>[0]> = {}) =>
  computePlanVsActual({ ...base, schedules: [], entries: [], cumulative: [], ...o });
const dayOf = (r: ReturnType<typeof computePlanVsActual>, d: number) =>
  r.days.find((x) => x.iso === toISODate(dateFromDayNumber(d)))!;

describe("computePlanVsActual — what was DUE and how much of it is DONE", () => {
  it("dates each stage by its own lead time off the oven date", () => {
    const r = run({ schedules: [sched()] });
    expect(dayOf(r, ovenD - 4).perStage.Cut.due).toBe(10); // Fabrication, 4 days before
    expect(dayOf(r, ovenD - 1).perStage.Welding.due).toBe(10); // Welding, 1 day before
    expect(dayOf(r, ovenD).perStage.Painting.due).toBe(10); // finishing, on the oven date
    expect(dayOf(r, ovenD).perStage.Cut.due).toBe(0); // not due for Fabrication that day
  });

  it("DONE only ever covers what was due — surplus output never inflates it", () => {
    const r = run({
      schedules: [sched({ qty: 10 })],
      cumulative: [cum("Painting", 25)], // far more made than promised
      entries: [entry({ qty: 25 })],
    });
    const d = dayOf(r, ovenD);
    expect(d.perStage.Painting.due).toBe(10);
    expect(d.perStage.Painting.done).toBe(10); // capped at the promise
    expect(d.perStage.Painting.output).toBe(25); // the real output is still visible
  });

  it("credits output to the OLDEST promise first, so a later date stays short", () => {
    const early = utcDate(2026, 7, 6);
    const r = run({
      schedules: [sched({ ovenDate: early, qty: 10 }), sched({ ovenDate: oven, qty: 10 })],
      cumulative: [cum("Painting", 15)], // covers the first promise and half the second
    });
    expect(dayOf(r, dayNumber(early)).perStage.Painting.done).toBe(10);
    expect(dayOf(r, ovenD).perStage.Painting.done).toBe(5);
  });

  it("a promise with no output at all reads zero done", () => {
    const r = run({ schedules: [sched()] });
    expect(dayOf(r, ovenD).perStage.Painting.done).toBe(0);
    expect(r.due).toBeGreaterThan(0);
    expect(r.done).toBe(0);
  });

  it("only the NEWEST plan's promise counts, and the output it already ate is not re-spent", () => {
    const older = sched({ planNo: 1, qty: 10, ovenDate: utcDate(2026, 7, 6) });
    const newer = sched({ planNo: 2, qty: 7, ovenDate: oven });
    const r = run({ schedules: [older, newer], cumulative: [cum("Painting", 12)] });
    expect(r.totals.Painting.due).toBe(7); // the newer promise, not 17
    // 10 of the 12 pcs paid the superseded promise — only 2 fill the live one
    expect(dayOf(r, ovenD).perStage.Painting.done).toBe(2);
  });

  it("OUTPUT counts what was recorded in the period and nets corrections", () => {
    const r = run({
      schedules: [sched()],
      cumulative: [cum("Painting", 4)],
      entries: [entry({ qty: 6 }), entry({ qty: -2 })], // a tracker correction
    });
    expect(dayOf(r, ovenD).perStage.Painting.output).toBe(4);
  });

  it("the core's Shot Blast counts as finishing, and never for a painted item", () => {
    expect(stageOfEntry("ShotBlast", "CF")).toBe("Painting");
    expect(stageOfEntry("ShotBlast", "TC")).toBeNull();
    expect(stageOfEntry("Delivered", "TC")).toBeNull(); // delivery is out of scope
    const r = run({
      schedules: [sched({ item: "CF", qty: 5 })],
      cumulative: [cum("ShotBlast", 5, { item: "CF" })],
      entries: [entry({ dept: "ShotBlast", item: "CF", qty: 5 })],
    });
    expect(r.totals.Painting.done).toBe(5); // the promise is covered by shot blast
    expect(r.totals.Painting.output).toBe(5);
  });

  it("the stage filter scopes due, done and output alike", () => {
    const r = run({
      schedules: [sched()],
      cumulative: [cum("Cut", 3), cum("Painting", 9)],
      entries: [entry({ dept: "Cut", qty: 3 }), entry({ dept: "Painting", qty: 9 })],
      stages: ["Cut"],
    });
    expect(Object.keys(r.totals)).toEqual(["Cut"]);
    expect(r.due).toBe(10); // Fabrication's promise only
    expect(r.done).toBe(3);
    expect(r.output).toBe(3); // painting output is out of scope
  });

  it("breaks each day AND each project down per component, and the parts add up", () => {
    const r = run({
      schedules: [sched({ item: "TC", qty: 10 }), sched({ item: "CB", qty: 6 })],
      cumulative: [cum("Painting", 4), cum("Painting", 6, { item: "CB" })],
      entries: [
        entry({ item: "TC", qty: 4 }),
        entry({ item: "CB", qty: 6 }),
        entry({ item: "AR", qty: 2 }), // never in the weekly grid — output only
      ],
    });
    const d = dayOf(r, ovenD);
    expect(d.items.map((i) => i.item)).toEqual(["TC", "CB", "AR"]); // pipeline order
    const tc = d.items.find((i) => i.item === "TC")!;
    expect(tc.perStage.Painting.due).toBe(10);
    expect(tc.perStage.Painting.done).toBe(4);
    expect(d.items.find((i) => i.item === "AR")!.due).toBe(0); // no promise, output only
    // the components add up to their parent rows — no number can disagree
    const p = r.projects[0];
    expect(p.items.reduce((s, i) => s + i.due, 0)).toBe(p.due);
    expect(p.items.reduce((s, i) => s + i.done, 0)).toBe(p.done);
    expect(d.items.reduce((s, i) => s + i.output, 0)).toBe(d.output);
  });

  it("marks Fridays as days off", () => {
    // 3 July 2026 is a Friday — the weekly day off
    expect(dayOf(run(), dayNumber(utcDate(2026, 7, 3))).isOff).toBe(true);
  });
});
