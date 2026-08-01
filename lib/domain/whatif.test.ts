import { describe, it, expect } from "vitest";
import { simulate, defaultScenario, dateForOffsetISO, countWorkingDaysISO, type WhatIfInputs } from "./whatif";

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
});
