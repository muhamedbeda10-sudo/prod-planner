import { describe, it, expect } from "vitest";
import {
  simulate, defaultScenario, optimizeQueue, deriveJobs,
  dateForOffsetISO, offsetForDateISO, countWorkingDaysISO, blackoutsOf, releaseOf,
  type WhatIfInputs, type WhatIfJob,
} from "./whatif";

// Mon 2026-08-03 as "today"; Fridays 07/08 and 14/08 are the days off
const job = (over: Partial<WhatIfJob> & { id: string }): WhatIfJob => ({
  mo: over.id.split("|")[0],
  bom: `B-${over.id}`,
  item: over.id.split("|")[1] ?? "TC",
  dueISO: null,
  left: { cut: 1, weld: 1, finish: 1 },
  perPc: { cut: 100, weld: 50, finish: 100 },
  baselineDays: null,
  blockedBy: null,
  ...over,
});

const INPUTS: WhatIfInputs = {
  todayISO: "2026-08-03",
  holidayISOs: [],
  rates: { cut: 100, weld: 50, finish: 100 },
  rateSigma: { cut: 0, weld: 0, finish: 0 },
  rateWindowDays: 14,
  capacity: { Cut: 200, Welding: 100, ShotBlast: 40, Painting: 160 },
  jobs: [
    // one piece per stage at these perPc = the old A/B orders exactly
    job({ id: "MO-A|TC", dueISO: "2026-08-10", baselineDays: 3 }),
    job({ id: "MO-B|TC", dueISO: "2026-08-12", baselineDays: 4 }),
  ],
  plan: {
    planNo: 40,
    minISO: "2026-08-03",
    maxISO: "2026-08-08", // Mon..Sat — contains Friday 07/08
    requiredByStage: { Cut: 600, Welding: 550, ShotBlast: 100, Painting: 400 },
  },
};

describe("simulate — capacity and rates", () => {
  it("the do-nothing scenario reproduces the baseline exactly", () => {
    const r = simulate(INPUTS, defaultScenario(INPUTS));
    expect(r.jobs.map((o) => o.etaISO)).toEqual(r.jobs.map((o) => o.baselineISO));
    expect(r.planWorkingDays).toBe(5); // 6 calendar days minus the Friday
    const weld = r.stages.find((s) => s.dept === "Welding")!;
    expect(weld.available).toBe(weld.baselineAvailable);
    expect(weld.available).toBeCloseTo(100 * 5, 6);
  });

  it("extra workers raise capacity AND speed their stations up", () => {
    // welding 100→200 mh/day (rate 50→100) and finishing 200→400 (rate 100→200)
    const sc = { ...defaultScenario(INPUTS), workersDelta: { Cut: 0, Welding: 10, ShotBlast: 0, Painting: 20 }, shiftHours: 10 };
    const r = simulate(INPUTS, sc);
    const weld = r.stages.find((s) => s.dept === "Welding")!;
    expect(weld.available).toBeCloseTo((100 + 100) * 5, 6); // capacity doubled
    // A: 1 + 0.5 + 0.5 = 2 wd; B: cut 2, weld 2.5, finish 3 wd (was 4)
    const b = r.jobs.find((o) => o.id === "MO-B|TC")!;
    expect(b.etaISO).toBe("2026-08-05");
    expect(b.deltaDays).toBe(-1); // Thu → Wed
  });

  it("working Fridays adds a plan day and pulls calendar ETAs closer", () => {
    const inputs: WhatIfInputs = {
      ...INPUTS,
      jobs: [job({ id: "MO-L|CF", left: { cut: 10, weld: 0, finish: 0 }, perPc: { cut: 100, weld: 0, finish: 0 }, baselineDays: 10 })],
    };
    const r = simulate(inputs, { ...defaultScenario(inputs), workFridays: true });
    expect(r.planWorkingDays).toBe(6); // the Friday now counts
    const base = dateForOffsetISO(10, inputs.todayISO, new Set(), false); // skips 2 Fridays
    expect(r.jobs[0].baselineISO).toBe(base);
    expect(r.jobs[0].etaISO! < base).toBe(true);
  });

  it("a job with nothing left stays done under every scenario", () => {
    const inputs: WhatIfInputs = {
      ...INPUTS,
      jobs: [job({ id: "MO-D|TC", left: { cut: 0, weld: 0, finish: 0 }, baselineDays: 0 })],
    };
    const r = simulate(inputs, { ...defaultScenario(inputs), workersDelta: { Cut: 5, Welding: 5, ShotBlast: 5, Painting: 5 }, shiftHours: 11 });
    expect(r.jobs[0].done).toBe(true);
    expect(r.jobs[0].etaISO).toBeNull();
  });

  it("the items of one order pipeline through the stations independently", () => {
    // TC and TN of the same MO: while TC welds, TN cuts — the MO clears in
    // 3 wd, not the 4 a single monolithic block would take
    const inputs: WhatIfInputs = {
      ...INPUTS,
      jobs: [
        job({ id: "MO-X|TC", dueISO: "2026-08-10" }),
        job({ id: "MO-X|TN", dueISO: "2026-08-10" }),
      ],
    };
    const r = simulate(inputs, defaultScenario(inputs));
    const ends = r.jobs.map((o) => o.segments[o.segments.length - 1].end);
    // TC: 1+1+1; TN waits one day at each shared station → 4 wd. A monolithic
    // MO-X block (2 wd per stage, no overlap) would take 6.
    expect(Math.max(...ends)).toBe(4);
  });
});

describe("deriveJobs — quantity splits", () => {
  // 20 pieces owed at finishing; 10 already welded, 15 already cut →
  // left = { cut: 5, weld: 10, finish: 20 }
  const base = job({ id: "MO-S|TC", left: { cut: 5, weld: 10, finish: 20 } });
  const inputs: WhatIfInputs = { ...INPUTS, jobs: [base] };

  it("hands the first batch the most-advanced pieces", () => {
    const sc = { ...defaultScenario(inputs), splits: { "MO-S|TC": [10, 10] } };
    const [b1, b2] = deriveJobs(inputs, sc);
    // the 10 most advanced pieces owe nothing at cut/weld — 10 behind them
    // carry all the arrears
    expect(b1.left).toEqual({ cut: 0, weld: 0, finish: 10 });
    expect(b2.left).toEqual({ cut: 5, weld: 10, finish: 10 });
    expect(b1.id).toBe("MO-S|TC#1");
    expect(b2.batch).toBe(2);
    // conservation: nothing appears or disappears
    expect(b1.left.cut + b2.left.cut).toBe(base.left.cut);
    expect(b1.left.weld + b2.left.weld).toBe(base.left.weld);
    expect(b1.left.finish + b2.left.finish).toBe(base.left.finish);
  });

  it("a rushed batch really does land earlier than the unsplit job", () => {
    const whole = simulate(inputs, defaultScenario(inputs));
    const sc = { ...defaultScenario(inputs), splits: { "MO-S|TC": [10, 10] }, queue: ["MO-S|TC#1", "MO-S|TC#2"] };
    const split = simulate(inputs, sc);
    // the whole job: cut 0→5, weld 5→15, finish 15→35 (one block, no overlap)
    const wholeEnd = whole.jobs[0].segments[whole.jobs[0].segments.length - 1].end;
    expect(wholeEnd).toBeCloseTo(35, 6);
    // batch 1 (already cut & welded) goes straight to finishing: done day 10
    const b1 = split.jobs.find((o) => o.id === "MO-S|TC#1")!;
    expect(b1.segments[b1.segments.length - 1].end).toBeCloseTo(10, 6);
    expect(b1.etaISO! < whole.jobs[0].etaISO!).toBe(true);
    // and the second batch ends day 25 — splitting exposes the advanced
    // pieces to the finishing station, so even the LAST piece lands earlier
    const b2 = split.jobs.find((o) => o.id === "MO-S|TC#2")!;
    expect(b2.segments[b2.segments.length - 1].end).toBeCloseTo(25, 6);
  });

  it("ignores a split that doesn't add up", () => {
    const sc = { ...defaultScenario(inputs), splits: { "MO-S|TC": [10, 5] } }; // 15 ≠ 20
    const derived = deriveJobs(inputs, sc);
    expect(derived).toHaveLength(1);
    expect(derived[0].batch).toBeNull();
  });
});

describe("what-if calendar helpers", () => {
  it("counts working days with and without Fridays", () => {
    expect(countWorkingDaysISO("2026-08-03", "2026-08-08", new Set(), false)).toBe(5);
    expect(countWorkingDaysISO("2026-08-03", "2026-08-08", new Set(), true)).toBe(6);
    expect(countWorkingDaysISO("2026-08-03", "2026-08-08", new Set(["2026-08-04"]), false)).toBe(4);
  });

  it("offsetForDateISO inverts the offset→date mapping", () => {
    for (const off of [1, 3, 5, 8]) {
      const iso = dateForOffsetISO(off, "2026-08-03", new Set(), false);
      expect(offsetForDateISO(iso, "2026-08-03", new Set(), false)).toBe(off);
    }
    expect(offsetForDateISO("2026-07-30", "2026-08-03", new Set(), false)).toBe(0); // in the past
  });
});

describe("optimizeQueue", () => {
  it("rescues a late job the due-date queue sacrifices", () => {
    const inputs: WhatIfInputs = {
      todayISO: "2026-08-03",
      holidayISOs: [],
      rates: { cut: 100, weld: 0, finish: 0 },
      rateSigma: { cut: 0, weld: 0, finish: 0 },
      rateWindowDays: 14,
      capacity: { Cut: 200 },
      jobs: [
        job({ id: "MO-A|TC", dueISO: "2026-08-08", left: { cut: 4, weld: 0, finish: 0 }, perPc: { cut: 100, weld: 0, finish: 0 }, baselineDays: 4 }),
        job({ id: "MO-B|TC", dueISO: "2026-08-04", left: { cut: 1, weld: 0, finish: 0 }, perPc: { cut: 50, weld: 0, finish: 0 }, baselineDays: 4.5 }),
      ],
      plan: null,
    };
    // EDD (A first, due sooner… actually B due sooner): the baseline queue is
    // as listed; the optimizer must put B first — it saves B's day-2 due and
    // A still lands inside its day-5 due
    expect(optimizeQueue(inputs, { ...defaultScenario(inputs), queue: ["MO-A|TC", "MO-B|TC"] }))
      .toEqual(["MO-B|TC", "MO-A|TC"]);
  });

  it("optimizes split batches like any other job", () => {
    // a split's rush batch can overtake another order to make its due date
    const inputs: WhatIfInputs = {
      todayISO: "2026-08-03",
      holidayISOs: [],
      rates: { cut: 100, weld: 0, finish: 0 },
      rateSigma: { cut: 0, weld: 0, finish: 0 },
      rateWindowDays: 14,
      capacity: { Cut: 200 },
      jobs: [
        job({ id: "MO-BIG|TC", dueISO: "2026-08-13", left: { cut: 3, weld: 0, finish: 3 }, perPc: { cut: 100, weld: 0, finish: 0 }, baselineDays: 3 }),
        job({ id: "MO-RUSH|TC", dueISO: "2026-08-04", left: { cut: 2, weld: 0, finish: 2 }, perPc: { cut: 100, weld: 0, finish: 0 }, baselineDays: 5 }),
      ],
      plan: null,
    };
    const sc = { ...defaultScenario(inputs), splits: { "MO-RUSH|TC": [1, 1] } };
    const q = optimizeQueue(inputs, sc);
    // day-1 due: only one cut-day fits — the optimizer front-loads at least
    // the first rush batch
    expect(q[0]).toBe("MO-RUSH|TC#1");
  });
});

describe("material holds and station downtime", () => {
  const inputs: WhatIfInputs = {
    todayISO: "2026-08-03", // Monday
    holidayISOs: [],
    rates: { cut: 100, weld: 0, finish: 0 },
    rateSigma: { cut: 0, weld: 0, finish: 0 },
    rateWindowDays: 14,
    capacity: { Cut: 200 },
    jobs: [
      job({ id: "MO-H|TC", dueISO: null, left: { cut: 2, weld: 0, finish: 0 }, perPc: { cut: 100, weld: 0, finish: 0 }, baselineDays: 2 }),
    ],
    plan: null,
  };

  it("a held job cannot start before its material arrives", () => {
    // material lands Thursday 06/08 → the job runs days [3,5] instead of [0,2]
    const r = simulate(inputs, { ...defaultScenario(inputs), holds: { "MO-H|TC": "2026-08-06" } });
    expect(r.jobs[0].segments[0].start).toBe(3);
    expect(r.jobs[0].segments[0].end).toBe(5);
  });

  it("a hold on a split applies to every batch", () => {
    const withSplit: WhatIfInputs = {
      ...inputs,
      jobs: [job({ id: "MO-H|TC", dueISO: null, left: { cut: 2, weld: 0, finish: 2 }, perPc: { cut: 100, weld: 0, finish: 0 }, baselineDays: 2 })],
    };
    const r = simulate(withSplit, {
      ...defaultScenario(withSplit),
      splits: { "MO-H|TC": [1, 1] },
      holds: { "MO-H|TC": "2026-08-06" },
    });
    for (const j of r.jobs) expect(j.segments[0]?.start ?? 3).toBeGreaterThanOrEqual(3);
  });

  it("a station stoppage pushes the work around it", () => {
    // cut down Tue 04/08 (occupies axis [1,2]): a 2-day job runs day [0,1],
    // waits the stoppage out, finishes [2,3]
    const r = simulate(inputs, {
      ...defaultScenario(inputs),
      downtimes: [{ stage: "cut", fromISO: "2026-08-04", toISO: "2026-08-04" }],
    });
    const seg = r.jobs[0].segments[0];
    expect(seg.start).toBe(0);
    expect(seg.end).toBe(3); // 2 working days of cutting + 1 day stopped
  });

  it("a stoppage that falls on the day off changes nothing", () => {
    // Friday 07/08 is already off — declaring it 'down' is a no-op
    const r = simulate(inputs, {
      ...defaultScenario(inputs),
      downtimes: [{ stage: "cut", fromISO: "2026-08-07", toISO: "2026-08-07" }],
    });
    expect(r.jobs[0].segments[0].end).toBe(2);
  });

  it("a stoppage that starts on the day off leaves the working day before it alone", () => {
    // down Fri 07/08 – Sat 08/08: only Saturday is lost (axis [4,5]), Thursday still works
    const bl = blackoutsOf({ ...defaultScenario(inputs), downtimes: [{ stage: "cut", fromISO: "2026-08-07", toISO: "2026-08-08" }] }, "2026-08-03", new Set());
    expect(bl.cut).toEqual([{ start: 4, end: 5 }]);
  });

  it("material that lands on the day off is used from the next working day, not the day before", () => {
    // arrives Friday 07/08: Mon–Thu (4 working days) pass without it
    expect(releaseOf("2026-08-07", "2026-08-03", new Set(), false)).toBe(4);
    expect(releaseOf("2026-08-06", "2026-08-03", new Set(), false)).toBe(3);
    expect(releaseOf("2026-08-01", "2026-08-03", new Set(), false)).toBe(0); // already here
  });

  it("slower rates (the pessimistic band) never land earlier", () => {
    const base = simulate(inputs, defaultScenario(inputs));
    const pess = simulate({ ...inputs, rates: { cut: 50, weld: 0, finish: 0 } }, defaultScenario(inputs));
    expect(pess.jobs[0].segments[0].end).toBeGreaterThan(base.jobs[0].segments[0].end);
  });
});
