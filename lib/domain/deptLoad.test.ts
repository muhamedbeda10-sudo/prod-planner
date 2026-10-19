import { describe, expect, it } from "vitest";
import { buildDeptLoad, type LoadInput } from "./deptLoad";

const DAYS = ["2026-09-10", "2026-09-11", "2026-09-13", "2026-09-14"]; // the 12th is a Friday
const CAP = [100, 100, 100, 100];
const l = (hours: number | null, dueISO: string | null): LoadInput => ({ hours, dueISO });

describe("buildDeptLoad", () => {
  it("adds the hours owed onto the day they are owed, and carries both totals", () => {
    const load = buildDeptLoad([l(60, "2026-09-10"), l(30, "2026-09-10"), l(50, "2026-09-13")], DAYS, CAP);
    expect(load.days.map((d) => [d.owedH, d.cumOwedH, d.cumCapH])).toEqual([
      [90, 90, 100],
      [0, 90, 200],
      [50, 140, 300],
      [0, 140, 400],
    ]);
    expect(load.shortFromISO).toBeNull();
    expect(load.spareH).toBe(260);
  });

  it("owes work due on a Friday by the Thursday before, not past the picture", () => {
    // a Saturday delivery less one day of lead lands on the Friday
    const load = buildDeptLoad([l(250, "2026-09-12")], DAYS, CAP);
    expect(load.days[1]).toMatchObject({ owedH: 250, shortH: 50 });
    expect(load.beyondH).toBe(0);
    expect(load.shortFromISO).toBe("2026-09-11");
  });

  it("names the day the running total of work passes the running total of hours", () => {
    // 150 h owed today against 100 — the department is already 50 h behind
    const load = buildDeptLoad([l(150, "2026-09-10"), l(120, "2026-09-11")], DAYS, CAP);
    expect(load.days[0]).toMatchObject({ owedH: 150, over: true, shortH: 50 });
    expect(load.days[1]).toMatchObject({ shortH: 70 });
    expect(load.days[2].shortH).toBe(0); // the following days catch it up
    expect(load.shortFromISO).toBe("2026-09-10");
    expect(load.spareH).toBe(130);
  });

  it("marks a day that owes more than it can work even while the week is fine", () => {
    const load = buildDeptLoad([l(180, "2026-09-13")], DAYS, CAP);
    expect(load.days[2]).toMatchObject({ over: true, shortH: 0 }); // one heavy day, but the days before carry it
    expect(load.shortFromISO).toBeNull();
  });

  it("puts work that is already overdue on today", () => {
    const load = buildDeptLoad([l(40, "2026-08-01")], DAYS, CAP);
    expect(load.days[0].owedH).toBe(40);
  });

  it("keeps dated work past the picture, work with no date, and unpriced lines out of the curve — and says so", () => {
    const load = buildDeptLoad([l(70, "2026-12-01"), l(25, null), l(null, "2026-09-11"), l(10, "2026-09-11")], DAYS, CAP);
    expect(load.days[1].owedH).toBe(10);
    expect(load.beyondH).toBe(70);
    expect(load.undatedH).toBe(25);
    expect(load.unpricedLines).toBe(1);
    expect(load.totalOwedH).toBe(10);
  });

  it("takes each day's own capacity, so today's downtime counts", () => {
    const load = buildDeptLoad([l(90, "2026-09-10")], DAYS, [60, 100, 100, 100]);
    expect(load.days[0]).toMatchObject({ capacityH: 60, over: true, shortH: 30 });
    expect(load.days[1].shortH).toBe(0);
    expect(load.peakH).toBe(100);
  });

  it("says nothing is owed when there is no work", () => {
    const load = buildDeptLoad([], DAYS, CAP);
    expect(load.totalOwedH).toBe(0);
    expect(load.spareH).toBe(400);
    expect(load.days.every((d) => d.owedH === 0 && !d.over)).toBe(true);
  });
});
