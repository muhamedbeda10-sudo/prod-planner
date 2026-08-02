import { describe, it, expect } from "vitest";
import { simulate, defaultScenario, optimizeQueue, dateForOffsetISO, offsetForDateISO, countWorkingDaysISO, type WhatIfInputs } from "./whatif";

// Mon 2026-08-03 as "today"; Fridays 07/08 and 14/08 are the days off
const INPUTS: WhatIfInputs = {
  todayISO: "2026-08-03",
  holidayISOs: [],
  rates: { cut: 100, weld: 50, finish: 100 },
  rateWindowDays: 14,
  capacity: { Cut: 200, Welding: 100, ShotBlast: 40, Painting: 160 },
  orders: [
    { id: "A", bom: "B-A", dueISO: "2026-08-10", hours: { cut: 100, weld: 50, finish: 100 }, baselineDays: 3, blockedBy: null },
    { id: "B", bom: "B-B", dueISO: "2026-08-12", hours: { cut: 100, weld: 50, finish: 100 }, baselineDays: 4, blockedBy: null },
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
    expect(r.orders.map((o) => o.etaISO)).toEqual(r.orders.map((o) => o.baselineISO));
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
    const a = r.orders.find((o) => o.id === "A")!;
    const b = r.orders.find((o) => o.id === "B")!;
    expect(a.etaISO! <= a.baselineISO!).toBe(true);
    expect(b.etaISO).toBe("2026-08-05");
    expect(b.deltaDays).toBe(-1); // Thu → Wed
  });

  it("working Fridays adds a plan day and pulls calendar ETAs closer", () => {
    // long order: 10 working days → baseline crosses two Fridays
    const inputs: WhatIfInputs = {
      ...INPUTS,
      orders: [{ id: "L", bom: "B-L", dueISO: null, hours: { cut: 1000, weld: 0, finish: 0 }, baselineDays: 10, blockedBy: null }],
    };
    const r = simulate(inputs, { ...defaultScenario(inputs), workFridays: true });
    expect(r.planWorkingDays).toBe(6); // the Friday now counts
    const base = dateForOffsetISO(10, inputs.todayISO, new Set(), false); // skips 2 Fridays
    expect(r.orders[0].baselineISO).toBe(base);
    expect(r.orders[0].etaISO! < base).toBe(true);
  });

  it("moving an order to the front of the queue makes it finish first", () => {
    const sc = { ...defaultScenario(INPUTS), queue: ["B", "A"] };
    const r = simulate(INPUTS, sc);
    const a = r.orders.find((o) => o.id === "A")!;
    const b = r.orders.find((o) => o.id === "B")!;
    expect(b.etaISO! < a.etaISO!).toBe(true); // B overtook A
    expect(a.deltaDays).toBeGreaterThan(0); // and A paid for it: Wed 05/08 → Thu 06/08
    expect(a.etaISO).toBe("2026-08-06");
    expect(a.late).toBe(false); // still inside its 10/08 due date
  });

  it("an order with nothing left stays done under every scenario", () => {
    const inputs: WhatIfInputs = {
      ...INPUTS,
      orders: [{ id: "D", bom: "B-D", dueISO: null, hours: { cut: 0, weld: 0, finish: 0 }, baselineDays: 0, blockedBy: null }],
    };
    const r = simulate(inputs, { ...defaultScenario(inputs), workersDelta: { Cut: 5, Welding: 5, ShotBlast: 5, Painting: 5 }, shiftHours: 11 });
    expect(r.orders[0].done).toBe(true);
    expect(r.orders[0].etaISO).toBeNull();
  });
});

describe("what-if calendar helpers", () => {
  it("counts working days with and without Fridays", () => {
    expect(countWorkingDaysISO("2026-08-03", "2026-08-08", new Set(), false)).toBe(5);
    expect(countWorkingDaysISO("2026-08-03", "2026-08-08", new Set(), true)).toBe(6);
    expect(countWorkingDaysISO("2026-08-03", "2026-08-08", new Set(["2026-08-04"]), false)).toBe(4);
  });

  it("maps offsets over the day off", () => {
    // 5 working days from Mon 03/08 = Sat 08/08 (Friday skipped)
    expect(dateForOffsetISO(5, "2026-08-03", new Set(), false)).toBe("2026-08-08");
    // with Fridays working, day 5 is Friday 07/08 itself
    expect(dateForOffsetISO(5, "2026-08-03", new Set(), true)).toBe("2026-08-07");
  });

  it("offsetForDateISO inverts the offset→date mapping", () => {
    for (const off of [1, 3, 5, 8]) {
      const iso = dateForOffsetISO(off, "2026-08-03", new Set(), false);
      expect(offsetForDateISO(iso, "2026-08-03", new Set(), false)).toBe(off);
    }
    expect(offsetForDateISO("2026-07-30", "2026-08-03", new Set(), false)).toBe(0); // in the past
    // the due marker for a Friday sits at the last working day before it
    expect(offsetForDateISO("2026-08-07", "2026-08-03", new Set(), false)).toBe(4);
  });
});

describe("simulate — timeline segments", () => {
  it("emits per-station occupancy the Gantt can draw", () => {
    const r = simulate(INPUTS, defaultScenario(INPUTS));
    const a = r.orders.find((o) => o.id === "A")!;
    // A: cut 0→1, weld 1→2, finish 2→3 at the baseline rates
    expect(a.segments).toEqual([
      { stage: "cut", start: 0, end: 1 },
      { stage: "weld", start: 1, end: 2 },
      { stage: "finish", start: 2, end: 3 },
    ]);
    const b = r.orders.find((o) => o.id === "B")!;
    // B waits for A at every station
    expect(b.segments[0]).toEqual({ stage: "cut", start: 1, end: 2 });
    expect(r.makespan).toBe(b.segments[b.segments.length - 1].end);
    // due markers land on the shared axis
    expect(a.dueOffset).toBeGreaterThan(0);
  });
});

describe("optimizeQueue", () => {
  it("rescues a late order the due-date queue sacrifices", () => {
    // EDD runs A (huge, due first) ahead of B (small, due later): A ends day 4
    // on time, but B waits until 4.5 and misses its day-2 due... whereas B
    // first ends day 0.5 on time AND A still lands inside day 5.
    const inputs: WhatIfInputs = {
      todayISO: "2026-08-03",
      holidayISOs: [],
      rates: { cut: 100, weld: 0, finish: 0 },
      rateWindowDays: 14,
      capacity: { Cut: 200 },
      orders: [
        { id: "A", bom: "B-A", dueISO: "2026-08-08", hours: { cut: 400, weld: 0, finish: 0 }, baselineDays: 4, blockedBy: null },
        { id: "B", bom: "B-B", dueISO: "2026-08-13", hours: { cut: 50, weld: 0, finish: 0 }, baselineDays: 4.5, blockedBy: null },
      ],
      plan: null,
    };
    // hand the optimizer a scenario whose queue the user already mangled —
    // it must return the best order regardless
    const sc = { ...defaultScenario(inputs), queue: ["A", "B"] };
    // due-date order IS [A, B]: A 0→4 (due offset 5, fine), B 4→4.5 (due 9, fine)
    // — nothing late, so the optimizer keeps it (no worse than EDD)
    expect(optimizeQueue(inputs, sc)).toEqual(["A", "B"]);

    // tighten B's due date to day 2: EDD (A first) makes B late; B-first saves
    // it and A still lands by its day-5 due
    const tight: WhatIfInputs = {
      ...inputs,
      orders: [
        inputs.orders[0],
        { ...inputs.orders[1], dueISO: "2026-08-04" },
      ],
    };
    expect(optimizeQueue(tight, { ...defaultScenario(tight), queue: ["A", "B"] })).toEqual(["B", "A"]);
  });

  it("breaks ties toward less total lateness", () => {
    // both queues leave one order late either way; the optimizer picks the
    // one that is less late in total
    const inputs: WhatIfInputs = {
      todayISO: "2026-08-03",
      holidayISOs: [],
      rates: { cut: 100, weld: 0, finish: 0 },
      rateWindowDays: 14,
      capacity: { Cut: 200 },
      orders: [
        { id: "big", bom: "B-1", dueISO: "2026-08-05", hours: { cut: 300, weld: 0, finish: 0 }, baselineDays: 3, blockedBy: null },
        { id: "small", bom: "B-2", dueISO: "2026-08-05", hours: { cut: 100, weld: 0, finish: 0 }, baselineDays: 4, blockedBy: null },
      ],
      plan: null,
    };
    // big first: big ends 3 (due 3, ok), small ends 4 → late 1. small first:
    // small ends 1 (ok), big ends 4 → late 1. Same late count, same total
    // lateness (1) — then the makespan ties too; either is acceptable, but the
    // result must be one of the two optima, deterministically
    const q = optimizeQueue(inputs, defaultScenario(inputs));
    expect([["big", "small"], ["small", "big"]]).toContainEqual(q);
    expect(optimizeQueue(inputs, defaultScenario(inputs))).toEqual(q);
  });
});
