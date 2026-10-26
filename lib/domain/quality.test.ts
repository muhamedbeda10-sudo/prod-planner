import { describe, it, expect } from "vitest";
import { cycleDays, firstPassRate, returnsByWeek, returnsSummary } from "./quality";

describe("the leak test passed first time", () => {
  it("judges each tank on its FIRST attempt, in the period it fell", () => {
    const r = firstPassRate([
      { tankId: 1, kind: "leak-repair", atISO: "2026-10-10T09:00:00Z" },
      { tankId: 1, kind: "leak-pass", atISO: "2026-10-12T09:00:00Z" }, // a re-test does not flatter
      { tankId: 2, kind: "leak-pass", atISO: "2026-10-11T09:00:00Z" },
      { tankId: 3, kind: "leak-pass", atISO: "2026-09-30T09:00:00Z" }, // first tested before the period
      { tankId: 3, kind: "leak-pass", atISO: "2026-10-11T09:00:00Z" },
    ], "2026-10-01", "2026-10-31");
    expect(r).toEqual({ units: 2, passed: 1, rate: 0.5 });
    expect(firstPassRate([], "2026-10-01", "2026-10-31").rate).toBeNull();
  });
});

describe("the days between welding, test and painting", () => {
  it("takes the median over the tanks that reached the step in the period", () => {
    const c = cycleDays([
      { weldedISO: "2026-10-01", testedISO: "2026-10-03", paintedISO: "2026-10-10" },
      { weldedISO: "2026-10-01", testedISO: "2026-10-08", paintedISO: null },
      { weldedISO: "2026-09-20", testedISO: "2026-09-25", paintedISO: "2026-10-02" }, // tested before the period, painted in it
      { weldedISO: "2026-10-05", testedISO: null, paintedISO: null },
    ], "2026-10-01", "2026-10-31");
    expect(c.weldToTest).toEqual({ n: 2, medianDays: 4.5, maxDays: 7 });
    expect(c.testToPaint).toEqual({ n: 2, medianDays: 7, maxDays: 7 });
  });
});

describe("the pieces sent back", () => {
  it("counts what is open now, what was filed in the period, and the reasons", () => {
    const s = returnsSummary([
      { dateISO: "2026-10-05", qty: 2, reason: "Missing holes", status: "open", urgent: true },
      { dateISO: "2026-10-06", qty: 1, reason: "Missing holes", status: "resolved" },
      { dateISO: "2026-09-01", qty: 4, reason: "Bent", status: "open" },
      { dateISO: "2026-09-02", qty: 9, reason: "Old", status: "resolved" },
    ], "2026-10-01", "2026-10-31");
    expect(s.open).toEqual({ count: 2, qty: 6 });
    expect(s.filed).toEqual({ count: 2, qty: 3 });
    expect(s.openOnUrgent).toBe(1);
    expect(s.byReason).toEqual([{ reason: "Bent", qty: 4, count: 1 }, { reason: "Missing holes", qty: 3, count: 2 }]);
  });
});

describe("returns by week", () => {
  it("buckets the period's returns by the Saturday their week started", () => {
    const rows = [
      { dateISO: "2026-10-24", qty: 1, reason: "a", status: "open" }, // Saturday
      { dateISO: "2026-10-26", qty: 2, reason: "a", status: "open" }, // the Monday after
      { dateISO: "2026-10-20", qty: 5, reason: "b", status: "resolved" },
      { dateISO: "2026-09-01", qty: 9, reason: "c", status: "open" }, // before the period
    ];
    expect(returnsByWeek(rows, "2026-10-01", "2026-10-31")).toEqual([{ weekISO: "2026-10-17", qty: 5, count: 1 }, { weekISO: "2026-10-24", qty: 3, count: 2 }]);
  });
  it("judges a tank's first test, then its waits, at the edges", () => {
    expect(firstPassRate([{ tankId: 1, kind: "leak-pass", atISO: "2026-10-31T23:30:00Z" }], "2026-10-01", "2026-10-31").units).toBe(1);
    expect(firstPassRate([{ tankId: 1, kind: "leak-pass", atISO: "2026-11-01T00:30:00Z" }], "2026-10-01", "2026-10-31").units).toBe(0);
    const c = cycleDays([{ weldedISO: "2026-10-01", testedISO: null, paintedISO: "2026-10-05" }], "2026-10-01", "2026-10-31");
    expect(c.testToPaint).toEqual({ n: 0, medianDays: null, maxDays: null });
    expect(cycleDays([{ weldedISO: "2026-10-01", testedISO: "2026-10-02", paintedISO: null }, { weldedISO: "2026-10-01", testedISO: "2026-10-04", paintedISO: null }, { weldedISO: "2026-10-01", testedISO: "2026-10-09", paintedISO: null }], "2026-10-01", "2026-10-31").weldToTest).toEqual({ n: 3, medianDays: 3, maxDays: 8 });
  });
});
