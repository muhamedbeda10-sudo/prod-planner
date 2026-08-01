import { describe, it, expect } from "vitest";
import { forecastEta, projectPace, type EtaOrder } from "./eta";

const RATES = { cut: 100, weld: 50, finish: 100 };
const order = (id: string, due: string | null, cut: number, weld: number, finish: number): EtaOrder => ({
  id, dueISO: due, hours: { cut, weld, finish },
});

describe("forecastEta — permutation flow shop, FIFO by due date", () => {
  it("a lone order takes the sum of its stage times", () => {
    const [r] = forecastEta([order("A", "2026-08-01", 100, 50, 100)], RATES);
    expect(r.days).toBeCloseTo(3, 6); // 1 + 1 + 1 days
  });

  it("an order with nothing left forecasts 0 days", () => {
    const [r] = forecastEta([order("A", null, 0, 0, 0)], RATES);
    expect(r.days).toBe(0);
  });

  it("the second order WAITS for the first at every shared station", () => {
    const rs = forecastEta(
      [order("A", "2026-08-01", 100, 50, 100), order("B", "2026-08-02", 100, 50, 100)],
      RATES
    );
    // B's cut starts after A's cut (day 1→2), weld after max(own cut done=2,
    // A's weld done=2) → 3, finish after max(3, A's finish done=3) → 4
    expect(rs[0].days).toBeCloseTo(3, 6);
    expect(rs[1].days).toBeCloseTo(4, 6);
  });

  it("queue position follows the DUE DATE, not the array order", () => {
    const rs = forecastEta(
      [order("late", "2026-09-01", 100, 0, 0), order("soon", "2026-08-01", 100, 0, 0)],
      RATES
    );
    expect(rs.find((r) => r.id === "soon")!.days).toBeCloseTo(1, 6);
    expect(rs.find((r) => r.id === "late")!.days).toBeCloseTo(2, 6);
  });

  it("undated orders queue after every dated one", () => {
    const rs = forecastEta(
      [order("nodate", null, 100, 0, 0), order("dated", "2026-12-31", 100, 0, 0)],
      RATES
    );
    expect(rs.find((r) => r.id === "dated")!.days).toBeCloseTo(1, 6);
    expect(rs.find((r) => r.id === "nodate")!.days).toBeCloseTo(2, 6);
  });

  it("an order skips stages it has finished — no queueing at a stage it never visits", () => {
    const rs = forecastEta(
      [order("A", "2026-08-01", 100, 50, 0), order("B", "2026-08-02", 0, 0, 100)],
      RATES
    );
    // B needs only finishing and A never enters that station
    expect(rs.find((r) => r.id === "B")!.days).toBeCloseTo(1, 6);
  });

  it("a stage with NO trailing rate blocks the forecast instead of inventing one", () => {
    const [r] = forecastEta([order("A", null, 100, 10, 0)], { cut: 100, weld: 0, finish: 100 });
    expect(r.days).toBeNull();
    expect(r.blockedBy).toBe("weld");
  });
});

describe("projectPace", () => {
  it("projects the week's close from the run-rate so far", () => {
    // 2 of 6 working days done, 200 of 900 hours produced → closes at 600/900
    const p = projectPace(900, 200, 2, 6)!;
    expect(p.projected).toBeCloseTo(600, 6);
    expect(p.coverage).toBeCloseTo(600 / 900, 6);
  });
  it("refuses to project from zero elapsed days", () => {
    expect(projectPace(900, 0, 0, 6)).toBeNull();
  });
});
