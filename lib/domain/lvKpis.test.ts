import { describe, it, expect } from "vitest";
import { LV_FLOOR_DEPTS, lvDeptOfStage, lvDeptsOf, lvFloorDeptOf, lvManpowerInputs, lvMonthProgress, lvPlanningActions, lvRateAt, lvWip } from "./lvKpis";
import { manpowerPlan } from "./kpis";
import type { LvState } from "./lv";
import type { LvRate } from "./lvStd";

const st = (required: number, punch = 0, bend = 0, weld = 0, paint = 0, delivered = 0): LvState => ({ required, punch, bend, weld, paint, delivered });
const rate: LvRate = { fg: "FG-SUSA-1", description: null, kind: "USS", cutH: 2, bendH: 1, weldH: 4, shbH: 0.5, paintH: 1.5, totalH: 20 };

describe("the panels' department filter", () => {
  it("reads a department's own name or the stage it works", () => {
    expect(lvFloorDeptOf("WeldingLV")).toBe("WeldingLV");
    expect(lvFloorDeptOf("Welding")).toBe("WeldingLV");
    expect(lvFloorDeptOf("Painting")).toBe("PaintingLV");
    expect(lvFloorDeptOf("Fabrication")).toBe("all");
    expect(lvFloorDeptOf(undefined)).toBe("all");
    expect(lvDeptsOf("all")).toEqual([...LV_FLOOR_DEPTS]);
    expect(lvDeptsOf("Bending")).toEqual(["Bending"]);
    expect(lvRateAt(rate, "Punching")).toBe(2);
    expect(lvRateAt(rate, "PaintingLV")).toBe(1.5);
    expect(lvDeptOfStage("Welding")).toBe("WeldingLV");
    expect(lvDeptOfStage("Delivered")).toBeNull();
    expect(lvFloorDeptOf("Punching")).toBe("Punching");
    expect(lvFloorDeptOf("welding")).toBe("all");
  });
});

describe("work between the stages", () => {
  it("nets each order along the chain and keeps the held ones apart", () => {
    const w = lvWip([
      { state: st(10, 8, 5, 5, 2, 1), onHold: false },
      { state: st(4, 4, 4, 4, 4, 4), onHold: false },
      { state: st(6, 3, 0, 0, 0, 0), onHold: true },
    ]);
    expect(w).toEqual({ notStarted: 2, waitingBend: 3, waitingWeld: 0, waitingPaint: 3, waitingDelivery: 1, onHold: 6, orders: 3, heldOrders: 1 });
  });
  it("never reads a stage ahead of the one before as negative waiting, and caps an over-recorded stage at the order", () => {
    expect(lvWip([{ state: st(5, 2, 4, 0, 0, 0), onHold: false }]).waitingBend).toBe(0);
    // punched 12 of an order for 10: only one panel of the order is still unbent
    expect(lvWip([{ state: st(10, 12, 9, 0, 0, 0), onHold: false }]).waitingBend).toBe(1);
    const held = lvWip([{ state: st(6, 6, 6, 6, 6, 0), onHold: true }]);
    expect(held).toMatchObject({ onHold: 0, waitingDelivery: 0, heldOrders: 1 });
  });
});

describe("the month's plan on the panels", () => {
  it("counts each stage capped at the order, finishes at painting and judges the pace on working days", () => {
    const m = lvMonthProgress([{ state: st(10, 12, 9, 6, 4) }, { state: st(5, 5, 5, 5, 5, 5) }], "October 2026", { monthWd: 20, leftWd: 10 });
    expect(m.panels).toBe(15);
    expect(m.byStage.map((b) => [b.stage, b.done])).toEqual([["Punching", 15], ["Bending", 14], ["Welding", 11], ["Painting", 9]]);
    expect(m.complete).toBe(9);
    expect(m.remaining).toBe(6);
    expect(m.pace.doneShare).toBeCloseTo(0.6, 10);
    expect(m.pace.expectedShare).toBe(0.5);
    expect(m.pace.tone).toBe("ok");
    expect(m.pace.aheadH).toBeCloseTo(1.5, 10);
  });
  it("has no pace with nothing planned, and leaves an order without a quantity out", () => {
    const m = lvMonthProgress([], "October 2026", { monthWd: 20, leftWd: 10 });
    expect(m.pace.doneShare).toBeNull();
    expect(m.pace.tone).toBeNull();
    const n = lvMonthProgress([{ state: st(10, 10, 10, 10, 10) }, { state: st(0, 3, 3, 3, 3) }], "October 2026", { monthWd: 20, leftWd: 10 });
    expect(n).toMatchObject({ orders: 1, panels: 10, complete: 10, remaining: 0 });
  });
  it("lets work a carried-over order brought from before the month start the pace there", () => {
    // 100 panels, 80 painted in September: the month owes 20, evenly; 10 more by mid-month is on pace
    const m = lvMonthProgress([{ state: st(100, 100, 100, 95, 90), before: { Painting: 80 } }], "October 2026", { monthWd: 20, leftWd: 10 });
    expect(m.paintedBefore).toBe(80);
    expect(m.pace.expectedShare).toBeCloseTo(0.9, 10);
    expect(m.pace.doneShare).toBeCloseTo(0.9, 10);
    expect(m.pace.tone).toBe("ok");
    // without it the same order would read far ahead of a 50% pace
    expect(lvMonthProgress([{ state: st(100, 100, 100, 95, 90) }], "October 2026", { monthWd: 20, leftWd: 10 }).pace.aheadH).toBe(40);
  });
});

describe("the month in people, on the panels", () => {
  it("prices each order by its sheet row, per department, and says what the sheet covers", () => {
    const { inputs, coverage } = lvManpowerInputs([{ state: st(10, 10, 5, 0, 0), rate }, { state: st(4), rate: null }], { WeldingLV: 3 });
    expect(coverage).toEqual({ orders: 2, priced: 1, panels: 14, pricedPanels: 10 });
    expect(inputs.find((i) => i.centre === "Punching")).toEqual({ centre: "Punching", requiredH: 20, doneH: 20, doneBeforeH: 0, present: null });
    expect(inputs.find((i) => i.centre === "Bending")).toMatchObject({ requiredH: 10, doneH: 5 });
    expect(inputs.find((i) => i.centre === "WeldingLV")).toMatchObject({ requiredH: 40, doneH: 0, present: 3 });
    const rows = manpowerPlan(inputs, { hoursPerPersonDay: 8, monthWd: 20, leftWd: 5 });
    const weld = rows.find((r) => r.centre === "WeldingLV")!;
    expect(weld.neededNow).toBe(1);
    expect(weld.gap).toBe(2);
    expect(weld.tone).toBe("ok");
  });
  it("caps an over-recorded stage at the order and carries the hours done before the month", () => {
    const { inputs } = lvManpowerInputs([{ state: st(10, 12, 4, 0, 0), rate, before: { Punching: 12, Bending: 1 } }], {});
    expect(inputs.find((i) => i.centre === "Punching")).toMatchObject({ requiredH: 20, doneH: 20, doneBeforeH: 20 });
    expect(inputs.find((i) => i.centre === "Bending")).toMatchObject({ requiredH: 10, doneH: 4, doneBeforeH: 1 });
  });
});

describe("what needs a decision on the panels", () => {
  const month = lvMonthProgress([{ state: st(20, 10, 6, 4, 2) }], "October 2026", { monthWd: 20, leftWd: 4 });
  const base = { month, wip: lvWip([{ state: st(20, 10, 6, 4, 2), onHold: false }]), urgentStuck: [], manpower: [], depts: [], coverage: { orders: 1, priced: 1, panels: 20, pricedPanels: 20 }, todayRecorded: true };
  it("names a month behind its pace, the urgent orders stuck, the people short and the unrecorded day", () => {
    const a = lvPlanningActions({
      ...base,
      urgentStuck: [{ mo: "WH/MO/1", bom: "LSS-1", remaining: 7, stage: "Welding" }],
      manpower: [{ centre: "WeldingLV", requiredH: 80, doneH: 16, doneBeforeH: 0, leftH: 64, needed: 1, neededNow: 2, present: 0.5, gap: -1.5, tone: "bad" }],
      depts: [{ dept: "Bending", days: 4, efficiency: 0.5 }],
      todayRecorded: false,
    });
    expect(a.map((x) => x.tone)).toEqual(["bad", "bad", "bad", "warn", "info"]);
    expect(a[0].text).toContain("October 2026's plan is behind");
    expect(a[1].text).toContain("WH/MO/1");
    expect(a[1].text).toContain("stuck at welding");
    expect(a[2]).toMatchObject({ floor: true, href: "/shifts" });
    expect(a[2].text).toContain("needs 2 more");
    expect(a[3].text).toContain("Bending worked at 50%");
    expect(a[4].text).toContain("not recorded yet");
  });
  it("says when the timings sheet leaves orders unpriced, and when a queue piles up", () => {
    const a = lvPlanningActions({ ...base, wip: lvWip([{ state: st(40, 40, 10, 10, 10), onHold: false }]), coverage: { orders: 4, priced: 2, panels: 40, pricedPanels: 20 } });
    expect(a.some((x) => x.text.includes("30 panels wait in front of bending"))).toBe(true);
    expect(a.some((x) => x.text.includes("2 of 4 panel orders have no row"))).toBe(true);
  });
  it("names the orders on hold, a queue at the threshold, and a month a little behind", () => {
    const held = lvPlanningActions({ ...base, wip: lvWip([{ state: st(6, 3, 0, 0, 0, 0), onHold: true }]) });
    expect(held.some((x) => x.text === "1 panel order on hold — 6 panels out of every queue until released." && x.href === "/tracker?status=hold")).toBe(true);
    const edge = lvPlanningActions({ ...base, wip: lvWip([{ state: st(10, 10, 0, 0, 0), onHold: false }]) });
    expect(edge.some((x) => x.text.includes("10 panels wait in front of bending"))).toBe(true);
    const m = lvMonthProgress([{ state: st(20, 20, 20, 20, 15) }], "October 2026", { monthWd: 20, leftWd: 4 });
    const warn = lvPlanningActions({ ...base, month: m, wip: lvWip([{ state: st(20, 20, 20, 20, 15), onHold: false }]) });
    expect(warn.map((x) => x.tone)).toEqual(["warn"]);
    expect(warn[0].text).toContain("a little behind its pace");
    // whole panels in the sentence
    expect(lvPlanningActions(base)[0].text).toMatch(/— \d+ panels behind\./);
  });
  it("is quiet when the month is on pace and everything is recorded", () => {
    const m = lvMonthProgress([{ state: st(20, 20, 20, 20, 16) }], "October 2026", { monthWd: 20, leftWd: 4 });
    expect(lvPlanningActions({ ...base, month: m, wip: lvWip([{ state: st(20, 20, 20, 20, 16), onHold: false }]) })).toEqual([]);
  });
});
