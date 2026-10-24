import { describe, it, expect } from "vitest";
import {
  byStage, centreStat, cockpitActions, combinedStat, workingDaysFrom, earnedOfRecord, efficiencyBand, isFloorAction, lateLines, loadAhead, loadTone, parseKpiSnapshot,
  planAdherence, stageDueISO, weldingCoverage, zeroCentres, type CentreDay, type PlanCell,
} from "./kpis";

const per = { ...zeroCentres(), Cutting: 1, Bending: 0.5, Fins: 0.25, Welding: 4, ShotBlast: 0.2, Painting: 0.8 };

describe("what a record earns at each centre", () => {
  it("credits a fabricated piece to every centre of its route", () => {
    const e = earnedOfRecord("Cut", 2, per);
    expect([e.Cutting, e.Bending, e.Fins, e.Welding]).toEqual([2, 1, 0.5, 0]);
  });
  it("credits a painted piece's blast to shot blast, and a shot-blast record to shot blast", () => {
    const paint = earnedOfRecord("Painting", 1, per);
    expect([paint.ShotBlast, paint.Painting]).toEqual([0.2, 0.8]);
    expect(earnedOfRecord("ShotBlast", 3, per).ShotBlast).toBeCloseTo(0.6, 10);
    expect(earnedOfRecord("Delivered", 1, per)).toEqual(zeroCentres());
    expect(earnedOfRecord("Cut", 1, undefined)).toEqual(zeroCentres());
    expect(byStage(earnedOfRecord("Cut", 2, per)).Cut).toBeCloseTo(3.5, 10);
  });
  it("takes a correction's hours back, so +10 then −3 earns what 7 pieces are worth", () => {
    const day = [earnedOfRecord("Welding", 10, per), earnedOfRecord("Welding", -3, per)].reduce((s, e) => s + e.Welding, 0);
    expect(day).toBe(28);
    expect(earnedOfRecord("Welding", Number.NaN, per)).toEqual(zeroCentres());
  });
});

describe("a centre over a window", () => {
  const d = (dateISO: string, o: Partial<CentreDay>): CentreDay => ({ dateISO, centre: "Cutting", workedH: 0, people: 0, earnedH: 0, machineH: 0, downtimeH: 0, ...o });
  it("efficiency is earned ÷ worked over the recorded days; stops on any day count", () => {
    const s = centreStat("Cutting", [
      d("2026-10-10", { workedH: 80, people: 10, earnedH: 72, machineH: 100, downtimeH: 5 }),
      d("2026-10-11", { workedH: 120, people: 14, earnedH: 108, machineH: 100, downtimeH: 15 }),
      d("2026-10-12", { downtimeH: 2 }), // not recorded on the shift log
      d("2026-10-10", { centre: "Welding", workedH: 50, earnedH: 10 }),
    ]);
    expect(s).toMatchObject({ days: 2, workedH: 200, earnedH: 180, downtimeH: 22, people: 12 });
    expect(s.efficiency).toBeCloseTo(0.9, 10);
    expect(s.availability).toBeCloseTo(1 - 22 / 200, 10);
    expect(efficiencyBand(s.efficiency)).toBe("ok");
    // the Shifts page's own bands: 90% on the standard, 70% short of it
    expect(efficiencyBand(0.72)).toBe("warn");
    expect(efficiencyBand(0.5)).toBe("bad");
    expect(efficiencyBand(null)).toBeNull();
    expect(centreStat("Fins", []).efficiency).toBeNull();
  });
  it("adds centres up as one — Fabrication's three", () => {
    const st = (centre: "Cutting" | "Bending", workedH: number, earnedH: number) => ({ centre, days: 3, workedH, earnedH, efficiency: earnedH / workedH, downtimeH: 0, availability: null, people: 2 });
    expect(combinedStat([st("Cutting", 60, 54), st("Bending", 40, 26)])).toEqual({ workedH: 100, earnedH: 80, efficiency: 0.8 });
    expect(combinedStat([]).efficiency).toBeNull();
  });
});

describe("welding coverage", () => {
  it("is the welding hours cut-and-waiting over the welders' recent daily output", () => {
    const c = weldingCoverage([{ item: "TN", pcs: 10, weldH: 120 }, { item: "TC", pcs: 0, weldH: 0 }, { item: "CB", pcs: 6, weldH: 30 }], [50, 0, 70, 60]);
    expect(c).toMatchObject({ wipH: 150, ratePerDay: 60, days: 2.5, band: "ok" });
    expect(c.byItem.map((b) => b.item)).toEqual(["TN", "CB"]);
    expect(weldingCoverage([{ item: "TN", pcs: 1, weldH: 20 }], [60]).band).toBe("short");
    expect(weldingCoverage([{ item: "TN", pcs: 1, weldH: 300 }], [60]).band).toBe("heavy");
    expect(weldingCoverage([{ item: "TN", pcs: 1, weldH: 30 }], []).days).toBeNull();
  });
});

describe("the weekly plan's adherence", () => {
  const leads = { cut: 4, weld: 1 };
  const cell = (dayISO: string, owed: number, cut: number, weld: number, finish: number): PlanCell => ({ dayISO, bom: "B1", item: "TN", owed, done: { cut, weld, finish } });
  it("a stage owes a day's pieces its lead days before the oven date", () => {
    expect(stageDueISO("2026-10-20", "cut", leads)).toBe("2026-10-16");
    expect(stageDueISO("2026-10-20", "weld", leads)).toBe("2026-10-19");
    expect(stageDueISO("2026-10-20", "finish", leads)).toBe("2026-10-20");
  });
  it("counts what each stage has done of what it owed by today, and names the late lines by the stage they are stuck at", () => {
    const cells = [cell("2026-10-18", 10, 10, 8, 6), cell("2026-10-22", 5, 3, 0, 0), cell("2026-10-30", 4, 0, 0, 0)];
    const a = planAdherence(cells, "2026-10-19", leads);
    // cut owes both early days (16th and 18th) — 13 of 15; weld and finish only the 18th
    expect(a.map((s) => [s.stage, s.due, s.done])).toEqual([["cut", 15, 13], ["weld", 10, 8], ["finish", 10, 6]]);
    expect(lateLines(cells, "2026-10-19", leads).map((l) => [l.dayISO, l.stage, l.short])).toEqual([["2026-10-18", "weld", 2], ["2026-10-22", "cut", 2]]);
  });
});

describe("the load ahead", () => {
  it("runs the owed hours against the capacity day by day, overdue work owed on the first day", () => {
    const days = ["2026-10-20", "2026-10-21", "2026-10-22"];
    const l = loadAhead("Welding", days, [{ dayISO: "2026-10-18", dueH: 30 }, { dayISO: "2026-10-20", dueH: 50 }, { dayISO: "2026-10-22", dueH: 40 }], 50);
    expect(l.days.map((d) => d.dueH)).toEqual([80, 0, 40]);
    // 30 h behind on the first day, caught up on the second
    expect(l).toMatchObject({ measured: true, behindH: 30, shortFromISO: "2026-10-20", clearsISO: "2026-10-21", shortH: 0 });
    expect(l.days.map((d) => d.tone)).toEqual(["bad", null, null]);
    expect(l.loadRate).toBeCloseTo(120 / 150, 10);
    // a Friday's hours land on the working day after it; past the horizon they are not its own
    expect(loadAhead("Welding", ["2026-10-22", "2026-10-24"], [{ dayISO: "2026-10-23", dueH: 10 }, { dayISO: "2026-11-30", dueH: 99 }], 50).days.map((d) => d.dueH)).toEqual([0, 10]);
    expect(loadAhead("Welding", days, [{ dayISO: "2026-10-21", dueH: 200 }], 50)).toMatchObject({ shortFromISO: "2026-10-21", clearsISO: null, shortH: 50, behindH: 100 });
  });
  it("names a centre that falls behind mid-horizon and catches up by the end — with the most it fell behind", () => {
    const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-24"];
    const l = loadAhead("Bending", days, [{ dayISO: "2026-10-21", dueH: 200 }], 50);
    expect(l).toMatchObject({ shortFromISO: "2026-10-21", clearsISO: "2026-10-24", shortH: 0, behindH: 100 });
    expect(cockpitActions({ late: [], coverage: { wipH: 0, ratePerDay: 0, days: null, band: null, byItem: [] }, load: [l], centres: [], topLoss: null, todayRecorded: true, ddmm: (iso) => iso })[0].text)
      .toBe("Bending is behind — Bending by up to 100 h from 2026-10-21, caught up by 2026-10-24 at the usual pace.");
  });
  it("judges nothing for a centre with no booked hours", () => {
    const l = loadAhead("Painting", ["2026-10-20", "2026-10-21"], [{ dayISO: "2026-10-20", dueH: 40 }], null);
    expect(l).toMatchObject({ measured: false, loadRate: null, behindH: 0, shortFromISO: null, shortH: 0 });
    expect(l.days.map((d) => [d.dueH, d.tone])).toEqual([[40, null], [0, null]]);
  });
  it("reads a load as over the capacity, within 10% of it, or clear", () => {
    expect([loadTone(101, 100), loadTone(95, 100), loadTone(80, 100), loadTone(10, 0)]).toEqual(["bad", "warn", null, null]);
    // rounding is not a shortfall
    expect(loadTone(100.04, 100)).toBe("warn");
  });
});

describe("working days ahead", () => {
  it("skips Fridays and the calendar's holidays", () => {
    // 2026-10-23 is a Friday
    expect(workingDaysFrom("2026-10-22", 4, new Set(["2026-10-25"]))).toEqual(["2026-10-22", "2026-10-24", "2026-10-26", "2026-10-27"]);
  });
});

describe("what to do today", () => {
  it("lists the late lines, a short centre, thin welding coverage, a slow centre, the top loss and an unrecorded day — worst first", () => {
    const a = cockpitActions({
      late: [{ dayISO: "2026-10-18", bom: "B1", item: "TN", owed: 4, stage: "weld", short: 2 }],
      coverage: { wipH: 10, ratePerDay: 60, days: 0.2, band: "short", byItem: [{ item: "TN", pcs: 1, weldH: 10 }] },
      load: [
        { centre: "Welding", measured: true, days: [], loadRate: 1.2, behindH: 30, shortFromISO: "2026-10-21", clearsISO: null, shortH: 30 },
        { centre: "Bending", measured: true, days: [], loadRate: 0.5, behindH: 12, shortFromISO: "2026-10-20", clearsISO: "2026-10-22", shortH: 0 },
      ],
      centres: [{ centre: "Bending", days: 5, workedH: 100, earnedH: 50, efficiency: 0.5, downtimeH: 0, availability: null, people: 3 }],
      topLoss: { label: "No material", hours: 6 },
      todayRecorded: false,
      ddmm: (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7),
    });
    expect(a.map((x) => x.tone)).toEqual(["bad", "bad", "warn", "bad", "warn", "warn"]);
    expect(a[0].text).toContain("B1 TN due 18/10, is 2 pc short at Welding");
    expect(a[1].text).toContain("Welding owes 30 h more");
    expect(a[2].text).toContain("Bending is behind — Bending by up to 12 h from 20/10, caught up by 22/10");
    expect(a[3].text).toContain("cut TN next");
    // no more than six: the unrecorded day falls off here
    expect(a).toHaveLength(6);
    // the shift log's own — a slow centre, the top loss — are marked for the people who see Shifts
    expect(a.map(isFloorAction)).toEqual([false, false, false, false, true, true]);
  });
});

describe("the stored trend", () => {
  it("reads a day back, a field an older day lacks as unknown — never zero", () => {
    expect(parseKpiSnapshot({ late: 4, adherence: { cut: 0.5, weld: null, bogus: 1 }, coverageDays: 2.2, efficiency: { Welding: 0.9 }, unplannedH: 3 }))
      .toEqual({ late: 4, adherence: { cut: 0.5, weld: null }, coverageDays: 2.2, efficiency: { Welding: 0.9 }, unplannedH: 3 });
    expect(parseKpiSnapshot({ late: 4 })).toEqual({ late: 4, adherence: {}, coverageDays: null, efficiency: {}, unplannedH: null });
    expect(parseKpiSnapshot(null).late).toBeNull();
  });
});
