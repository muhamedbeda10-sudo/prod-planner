import { describe, expect, it } from "vitest";
import {
  pctText, plantCalendar, dispatchByCurrentStation, windowLoad, stationEvidence, queueNow, stagePerPc, arrivedPcs, availableTime, compareByRule, criticalRatio, dispatchList, dispatchRow, drumTime, ioBacklog, ioReport, loadPct, loadProfile, loadStatus,
  matchedRate, pastPlantWeeks, plantWeeks, rankConstraint, ratedCapacity, releaseChecklist, simulateRush, slackTime, workDaysLeft, workingDaysToDue, withCumulative,
  type ConstraintEvidence, type DispatchRow,
} from "./planningControl";
import type { WhatIfJob } from "./whatif";

const job = (id: string, o: Partial<WhatIfJob> = {}): WhatIfJob => ({
  id, mo: id.split("|")[0], bom: "B1", item: id.split("|")[1] ?? "TN", dueISO: "2026-11-05",
  left: { cut: 0, weld: 10, finish: 10 }, perPc: { cut: 1, weld: 2, finish: 1 }, baselineDays: 5, blockedBy: null, ...o,
});
const rates = { cut: 100, weld: 50, finish: 40 };
// 2026-10-27 is a Tuesday; Fridays are off
const TODAY = "2026-10-27";

describe("the reference cases", () => {
  it("critical ratio: 8 days left, 10 days of lead time → 0.8, behind", () => {
    expect(criticalRatio(60 - 52, 10)).toEqual({ cr: 0.8, status: "behind" });
  });
  it("critical ratio, late: due day 50, today 52, 4 days left → −0.5, ranked before −0.2", () => {
    const late = criticalRatio(50 - 52, 4);
    expect(late).toEqual({ cr: -0.5, status: "late" });
    const less = criticalRatio(-1, 5);
    expect(less.cr).toBe(-0.2);
    const rows = [{ id: "B", cr: less.cr, status: "late" }, { id: "A", cr: late.cr, status: "late" }] as DispatchRow[];
    expect(rows.sort(compareByRule("CR")).map((r) => r.id)).toEqual(["A", "B"]);
  });
  it("slack: 8 days left, 5 days of work, 3 operations → 3, 1.0 each", () => {
    expect(slackTime(8, 5, 3)).toEqual({ slack: 3, perOperation: 1 });
  });
  it("rated capacity: 3 stations × 8 h × 5 days at 85% and 95% → 96.9 h", () => {
    expect(availableTime(3, 8, 1, 5)).toBe(120);
    expect(ratedCapacity(120, 0.85, 0.95)).toBe(96.9);
  });
  it("the drum's time: 40 h less 2 setups of 2 h → 36 h", () => {
    expect(drumTime(40, 2, 2)).toBe(36);
  });
  it("I/O backlog: 40 + 90 − 85 → 45", () => {
    expect(ioBacklog(40, 90, 85)).toBe(45);
  });
  it("load %: 110 h on 96.9 h → 113.5%, overloaded", () => {
    expect(loadPct(110, 96.9)).toBe(113.5);
    expect(loadStatus(113.5)).toBe("overloaded");
  });
  it("rate matching: 4 parts per constraint unit → 4 × the rate", () => {
    expect(matchedRate(6, 4)).toBe(24);
  });
});

describe("the edges", () => {
  it("no remaining lead time is done or unknown, never a division by zero", () => {
    expect(criticalRatio(5, 0)).toEqual({ cr: null, status: "done" });
    expect(criticalRatio(5, null)).toEqual({ cr: null, status: "unknown" });
    expect(criticalRatio(null, 3)).toEqual({ cr: null, status: "unknown" });
    expect(criticalRatio(0, 3).status).toBe("late");
    expect(criticalRatio(10, 10).status).toBe("on_schedule");
    expect(criticalRatio(12, 10).status).toBe("ahead");
  });
  it("load bands and missing capacity", () => {
    expect(loadPct(10, null)).toBeNull();
    expect(loadStatus(null)).toBe("no_capacity");
    expect(loadPct(5, 0)).toBe(Infinity);
    expect(loadPct(0, 0)).toBe(0);
    expect(loadStatus(84.9)).toBe("ok");
    expect(loadStatus(85)).toBe("tight");
    expect(loadStatus(100)).toBe("tight");
    expect(pctText(92.5)).toBe("92.5%");
    expect(pctText(Infinity)).toContain("beyond capacity");
  });
  it("counts working days to due over Fridays and holidays, a passed date at zero or below", () => {
    const off = new Set(["2026-10-29"]);
    expect(workingDaysToDue(TODAY, TODAY, off)).toBe(1);
    // Tue 27, Wed 28, (Thu 29 holiday), (Fri 30), Sat 31
    expect(workingDaysToDue("2026-10-31", TODAY, off)).toBe(3);
    expect(workingDaysToDue("2026-10-26", TODAY, off)).toBe(0);
    // Sat 24 is two working days back (Sun 25, Mon 26 passed)
    expect(workingDaysToDue("2026-10-24", TODAY, off)).toBe(-2);
  });
  it("pure work days need every station's pace", () => {
    expect(workDaysLeft(job("A|TN"), rates)).toBeCloseTo(10 * 2 / 50 + 10 / 40);
    expect(workDaysLeft(job("A|TN"), { ...rates, weld: 0 })).toBeNull();
  });
});

describe("the dispatch list", () => {
  const ctx = { calendar: plantCalendar(TODAY, new Set()), rates };
  it("reads a job's pieces waiting at the station from the station before", () => {
    expect(arrivedPcs({ left: { cut: 2, weld: 10, finish: 10 } }, "weld")).toBe(8);
    expect(arrivedPcs({ left: { cut: 2, weld: 10, finish: 10 } }, "cut")).toBe(2);
    expect(arrivedPcs({ left: { cut: 0, weld: 4, finish: 10 } }, "finish")).toBe(6);
  });
  it("prices a row and its forecast date", () => {
    const r = dispatchRow(job("A|TN", { dueISO: "2026-10-31", baselineDays: 4 }), "weld", ctx);
    expect(r).toMatchObject({ daysToDue: 4, forecastDays: 4, cr: 1, status: "on_schedule", stageHours: 20, totalHours: 30, opsLeft: 2, pcsArrived: 10 });
    expect(r.forecastISO).toBe("2026-10-31");
    expect(r.slack).toBeCloseTo(4 - 0.65, 2);
  });
  it("puts running and waiting jobs first, then the rule; nothing the station does not owe", () => {
    const jobs = [
      job("LATE|TN", { dueISO: "2026-10-20", baselineDays: 3, left: { cut: 10, weld: 10, finish: 10 } }), // not at welding yet
      job("SOON|TN", { dueISO: "2026-10-28", baselineDays: 5 }),
      job("LATER|TN", { dueISO: "2026-11-20", baselineDays: 5 }),
      job("RUN|TN", { dueISO: "2026-12-20", baselineDays: 2 }),
      job("CUTONLY|TN", { left: { cut: 3, weld: 0, finish: 0 } }),
    ];
    const rows = dispatchList(jobs, "weld", "CR", { ...ctx, runningIds: new Set(["RUN|TN"]) });
    expect(rows.map((r) => r.id)).toEqual(["RUN|TN", "SOON|TN", "LATER|TN", "LATE|TN"]);
    expect(dispatchList(jobs, "weld", "EDD", ctx).map((r) => r.id)).toEqual(["SOON|TN", "LATER|TN", "RUN|TN", "LATE|TN"]);
    expect(rows.find((r) => r.id === "LATE|TN")).toMatchObject({ status: "late", action: "Expedite now" });
  });
  it("named orders at their current station, the rule's order, running first", () => {
    const jobs = [
      job("A|TN", { dueISO: "2026-11-20", left: { cut: 4, weld: 10, finish: 10 } }),
      job("B|TC", { dueISO: "2026-10-28" }),
      job("DONE|CB", { left: { cut: 0, weld: 0, finish: 0 } }),
    ];
    const rows = dispatchByCurrentStation(jobs, "EDD", { ...ctx, running: { cut: new Set(["A|TN"]) } });
    expect(rows.map((r) => [r.id, r.station, r.running])).toEqual([["A|TN", "cut", true], ["B|TC", "weld", false]]);
    expect(dispatchByCurrentStation(jobs, "EDD", ctx).map((r) => r.id)).toEqual(["B|TC", "A|TN"]);
  });
  it("the calendar works each date out once and reads a forecast's day", () => {
    const cal = plantCalendar(TODAY, new Set());
    expect(cal.daysToDue("2026-10-31")).toBe(4);
    expect(cal.offsetOf("2026-10-01")).toBe(0);
    expect(cal.dateFor(0)).toBe(TODAY);
    expect(cal.dateFor(3.2)).toBe("2026-10-31");
  });
  it("a blocked job has no forecast and sorts last", () => {
    const rows = dispatchList([job("B|TN", { blockedBy: "weld", baselineDays: null }), job("A|TN")], "weld", "CR", ctx);
    expect(rows.map((r) => r.id)).toEqual(["A|TN", "B|TN"]);
    expect(rows[1]).toMatchObject({ status: "unknown", cr: null, forecastISO: null });
  });
});

describe("the load profile", () => {
  it("buckets due work by plant week, past due in the current one, against capacity", () => {
    const inputs = {
      todayISO: TODAY, holidayISOs: [], rates,
      capacity: { Welding: 20, ShotBlast: 2, Painting: 2 },
      jobs: [
        job("OLD|TN", { dueISO: "2026-10-01" }), // 20 weld h past due
        job("THIS|TN", { dueISO: "2026-10-30" }), // 20 weld h this week
        job("NEXT|TN", { dueISO: "2026-11-02", left: { cut: 0, weld: 50, finish: 0 } }), // 100 weld h next week
        job("FAR|TN", { dueISO: "2027-01-10" }),
        job("NODATE|TN", { dueISO: null }),
      ],
    };
    const [cut, weld, finish] = loadProfile(inputs, 2);
    expect(cut.capacityPerDay).toBeNull();
    expect(cut.weeks[0].status).toBe("no_capacity");
    // Sat 24 – Fri 30: from Tue 27, 3 working days (Tue, Wed, Thu)
    expect(weld.weeks[0]).toMatchObject({ fromISO: "2026-10-24", toISO: "2026-10-30", workingDays: 3, loadH: 40, pastDueH: 20, availableH: 60, demonstratedH: 150, loadPct: 66.7, status: "ok" });
    expect(weld.weeks[1]).toMatchObject({ workingDays: 6, loadH: 100, availableH: 120, loadPct: 83.3, cumShortH: -40 });
    expect(weld.beyondH).toBe(20);
    expect(weld.undatedH).toBe(20);
    expect(finish.capacityPerDay).toBe(4);
    expect(finish.weeks[0]).toMatchObject({ loadH: 20, availableH: 12, loadPct: 166.7 });
    expect(finish.weeks[0].status).toBe("overloaded");
  });
  it("a station's load over the whole window", () => {
    const [, weld, finish] = loadProfile({ todayISO: TODAY, holidayISOs: [], rates, capacity: { Welding: 10 }, jobs: [job("A|TN", { dueISO: "2026-10-28" })] }, 2);
    expect(windowLoad(weld)).toEqual({ loadH: 20, availableH: 90, pct: 22.2, status: "ok" });
    expect(windowLoad(finish)).toMatchObject({ availableH: null, pct: null, status: "no_capacity" });
  });
  it("weeks run Saturday to Friday", () => {
    expect(plantWeeks("2026-10-31", 1, new Set())[0]).toMatchObject({ fromISO: "2026-10-31", toISO: "2026-11-06", workingDays: 6 });
    expect(plantWeeks("2026-10-30", 1, new Set())[0].fromISO).toBe("2026-10-24");
    const past = pastPlantWeeks(TODAY, 2, new Set());
    expect(past.map((w) => [w.fromISO, w.toISO])).toEqual([["2026-10-17", "2026-10-23"], ["2026-10-24", "2026-10-26"]]);
    // on a Saturday the new week has nothing past yet: the weeks asked for are the whole ones before it
    expect(pastPlantWeeks("2026-10-31", 2, new Set()).map((w) => [w.fromISO, w.toISO])).toEqual([["2026-10-17", "2026-10-23"], ["2026-10-24", "2026-10-30"]]);
  });
});

describe("input/output control", () => {
  const w = (plannedInput: number | null, actualInput: number | null, plannedOutput: number | null, actualOutput: number) => ({ fromISO: "x", toISO: "y", workingDays: 6, plannedInput, actualInput, plannedOutput, actualOutput });
  it("walks the backlog back from today's queue and finds the problem upstream", () => {
    const r = ioReport([w(100, 70, 100, 90), w(100, 80, 100, 85)], 45);
    expect(r.weeks[1]).toMatchObject({ backlogEnd: 45, backlogStart: 50 });
    expect(r.weeks[0]).toMatchObject({ backlogEnd: 50, backlogStart: 70, cumInputVariance: -30, cumOutputVariance: -10 });
    expect(r.weeks[1].cumInputVariance).toBe(-50);
    expect(r.diagnosis).toBe("upstream");
    expect(r.backlogGrowing).toBe(false);
    expect(r.backlogTrendH).toBe(-25);
  });
  it("input on plan, output short: inside the station; the queue grows", () => {
    const r = ioReport([w(100, 100, 100, 70), w(100, 100, 100, 75)], 100);
    expect(r.diagnosis).toBe("internal");
    expect(r.backlogGrowing).toBe(true);
  });
  it("no input record (Fabrication) and no plan", () => {
    const r = ioReport([w(null, null, null, 30)], null);
    expect(r.diagnosis).toBe("no_plan");
    expect(r.weeks[0].backlogEnd).toBeNull();
  });
});

describe("the constraint and the Pareto", () => {
  const ev = (stage: ConstraintEvidence["stage"], daysOfWork: number | null, o: Partial<ConstraintEvidence> = {}): ConstraintEvidence => ({ stage, name: stage, openH: 100, ratePerDay: 10, daysOfWork, queueH: 20, queueDays: 2, nearLoadPct: 90, lostH: 0, backlogTrendH: null, ...o });
  it("names the station with the most days of work, and how loaded the rest are against it", () => {
    const r = rankConstraint([ev("cut", 4), ev("weld", 10, { lostH: 6, backlogTrendH: 12 }), ev("finish", null)]);
    expect(r.constraint?.stage).toBe("weld");
    expect(r.ranked.map((x) => x.stage)).toEqual(["weld", "cut", "finish"]);
    expect(r.subordinate).toEqual([{ stage: "cut", name: "cut", shareOfDrum: 0.4 }, { stage: "finish", name: "finish", shareOfDrum: null }]);
    expect(r.evidence.join(" ")).toContain("no recorded pace");
  });
  it("builds a station's evidence from its jobs, queue, load and stops", () => {
    const jobs = [job("A|TN"), job("B|TC", { left: { cut: 4, weld: 10, finish: 10 } })];
    expect(queueNow(jobs)).toEqual({ cut: 4, weld: 32, finish: 0 });
    const [, load] = loadProfile({ todayISO: TODAY, holidayISOs: [], rates, capacity: { Welding: 10 }, jobs }, 2); // both due 2026-11-05, in the second week
    expect(stationEvidence("weld", { jobs, rate: 20, queueH: 32, load, lostH: 3.04, backlogTrendH: 5 })).toEqual({
      stage: "weld", name: "Welding", openH: 40, ratePerDay: 20, daysOfWork: 2, queueH: 32, queueDays: 1.6, nearLoadPct: 44.4, lostH: 3, backlogTrendH: 5,
    });
    // not read (the Shifts screen closed): no stop line in the evidence
    const r = rankConstraint([stationEvidence("weld", { jobs, rate: 20, queueH: 32, load, lostH: null, backlogTrendH: null })]);
    expect(r.constraint?.lostH).toBeNull();
    expect(r.evidence.join(" ")).not.toContain("lost to stops");
  });
  it("prices a piece per station, finishing = shot blast + paint", () => {
    expect(stagePerPc({ cut: 1, weld: 2, shb: 0.5, paint: 1 })).toEqual({ cut: 1, weld: 2, finish: 1.5 });
  });
  it("no work anywhere: no constraint", () => {
    expect(rankConstraint([ev("cut", 0), ev("weld", null, { openH: 0 })]).constraint).toBeNull();
  });
  it("ranks causes with their running share and the vital few", () => {
    const r = withCumulative([{ code: "B", hours: 2 }, { code: "A", hours: 6 }, { code: "C", hours: 2 }]);
    expect(r.map((x) => [x.code, x.share, x.cumShare, x.vital])).toEqual([["A", 0.6, 0.6, true], ["B", 0.2, 0.8, true], ["C", 0.2, 1, false]]);
  });
});

describe("a rush order", () => {
  // A's forecast today: welding day 0–1, finishing 1–2
  const inputs = { todayISO: TODAY, holidayISOs: [], rates: { cut: 10, weld: 10, finish: 10 }, jobs: [job("A|TN", { dueISO: "2026-10-29", left: { cut: 0, weld: 10, finish: 10 }, perPc: { cut: 1, weld: 1, finish: 1 }, baselineDays: 2 })] };
  const rush = [{ id: "NEW|TN", item: "TN", qty: 10, perPc: { cut: 1, weld: 1, finish: 1 } }];
  it("queued by its date behind the earlier order, and expedited ahead of it", () => {
    const r = simulateRush(inputs, rush, "2026-11-02");
    // A: weld 1 day, finish 1 day → day 2. NEW: cut 0–1, weld 1–2 (after A), finish 2–3
    expect(r.atDuePosition).toMatchObject({ finishDays: 3, feasible: true, pushed: [] });
    // expedited, the queue is strict: NEW welds 1–2 first, so A waits and finishes on day 4 — past its date
    expect(r.expedited).toMatchObject({ finishDays: 3, pushed: [{ mo: "A", beforeISO: "2026-10-28", afterISO: "2026-10-31", nowLate: true }] });
    expect(r.blockedBy).toBeNull();
  });
  it("an order that cannot make it, and the jobs it would push", () => {
    const big = [{ id: "NEW|TN", item: "TN", qty: 50, perPc: { cut: 0, weld: 1, finish: 1 } }];
    const r = simulateRush(inputs, big, "2026-10-28");
    expect(r.atDuePosition.feasible).toBe(false);
    expect(r.expedited.pushed[0]).toMatchObject({ mo: "A", nowLate: true });
  });
  it("no pace at a station needed: blocked, no date", () => {
    const r = simulateRush({ ...inputs, rates: { cut: 0, weld: 10, finish: 10 } }, rush, "2026-11-02");
    expect(r.blockedBy).toBe("cut");
    expect(r.atDuePosition).toMatchObject({ finishDays: null, feasible: null });
  });
});

describe("the release checklist", () => {
  it("not found / on hold is not ready", () => {
    expect(releaseChecklist({ found: false }).verdict).toBe("not_ready");
    const r = releaseChecklist({ found: true, status: "open", onHold: { note: "waiting for the drawing" }, nesting: { lines: 2, nested: 2 } });
    expect(r.verdict).toBe("not_ready");
    expect(r.checks.find((c) => c.check === "Not on hold")?.detail).toContain("waiting for the drawing");
  });
  it("stock not connected keeps an otherwise clean order to ready-with-checks", () => {
    const r = releaseChecklist({ found: true, status: "open", onHold: null, pendingQty: null, missingTimes: [], dueISO: "2026-11-05", nesting: { lines: 3, nested: 3 }, stock: null, firstStationLoad: { pct: 70, status: "ok", weeks: "this week" } });
    expect(r.verdict).toBe("ready_with_checks");
    expect(r.checks.find((c) => c.check === "Material stock")?.status).toBe("unknown");
  });
  it("a nesting not checked (the Material screen closed) is a check still to do, not a pass", () => {
    const r = releaseChecklist({ found: true, status: "open", nesting: "not_checked", stock: { status: "ok", detail: "" } });
    expect(r.verdict).toBe("ready_with_checks");
    expect(r.checks.find((c) => c.check === "Nesting / drawings")?.status).toBe("unknown");
  });
  it("reads the stock once a feed fills it in", () => {
    const r = releaseChecklist({ found: true, status: "open", onHold: null, nesting: { lines: 1, nested: 1 }, stock: { status: "ok", detail: "All sheets on hand." } });
    expect(r.verdict).toBe("ready");
  });
  it("no nesting blocks; part-nested and an overload warn", () => {
    expect(releaseChecklist({ found: true, status: "open", nesting: { lines: 0, nested: 0 } }).verdict).toBe("not_ready");
    const r = releaseChecklist({ found: true, status: "open", nesting: { lines: 4, nested: 1 }, stock: { status: "ok", detail: "" }, firstStationLoad: { pct: 120, status: "overloaded", weeks: "this week" } });
    expect(r.verdict).toBe("ready_with_checks");
    expect(r.checks.filter((c) => c.status === "warn").map((c) => c.check)).toEqual(["Nesting / drawings", "Fabrication capacity"]);
  });
});
