import { describe, it, expect, vi } from "vitest";

// ---- an account the Shifts screen is closed to gets none of the shift log's figures ----

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { withoutFloor, type CockpitData } from "@/lib/server/kpis";

const stat = { centre: "Welding", days: 4, workedH: 100, earnedH: 90, efficiency: 0.9, downtimeH: 2, availability: null, people: 12 } as const;

describe("withoutFloor", () => {
  it("drops the centres, the losses and the shift log's decisions, and keeps the plan, the load and welding's coverage", () => {
    const c = {
      todayISO: "2026-10-25", lastDayISO: "2026-10-24",
      week: { planNo: 43, req: 280, covered: 28, days: [], adherence: [], late: [], lateCount: 0 },
      centres: [{ centre: "Welding", last: stat, recent: stat, trend: [] }],
      fabrication: { workedH: 300, earnedH: 240, efficiency: 0.8 },
      load: [{ centre: "Welding", measured: true, days: [], loadRate: 0.7, behindH: 0, shortFromISO: null, clearsISO: null, shortH: 0 }],
      coverage: { wipH: 30, ratePerDay: 10, days: 3, band: "ok", byItem: [] },
      manpower: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, hoursPerPersonDay: 8, pieces: 120, rows: [{ centre: "Welding", requiredH: 4000, doneH: 3000, leftH: 1000, needed: 20, neededNow: 25, present: 22, gap: -3, tone: "bad" }] },
      losses: { causes: [{ code: "MECH", label: "Breakdown", planned: false, hours: 3, stops: 1, share: 1 }], unplannedH: 3, plannedH: 0, absentRate: 0.1, overtimeH: 12, fromISO: "2026-10-18" },
      pricedShare: 0.9,
      actions: [{ tone: "bad", text: "plan", href: "/tracker" }, { tone: "warn", text: "slow", href: "/shifts", floor: true }],
      snapshot: { late: 0, adherence: { cut: 1 }, coverageDays: 3, efficiency: { Welding: 0.9 }, fabEfficiency: 0.7, unplannedH: 3 },
      trend: [{ dateISO: "2026-10-25", late: 0, adherence: { cut: 1 }, coverageDays: 3, efficiency: { Welding: 0.9 }, fabEfficiency: 0.7, unplannedH: 3 }],
    } as unknown as CockpitData;
    const out = withoutFloor(c);
    expect(out.centres).toEqual([]);
    expect(out.fabrication.efficiency).toBeNull();
    expect(out.losses).toMatchObject({ causes: [], unplannedH: 0, absentRate: null, overtimeH: 0 });
    expect(out.pricedShare).toBeNull();
    expect(out.actions.map((a) => a.text)).toEqual(["plan"]);
    expect(out.trend[0]).toMatchObject({ efficiency: {}, fabEfficiency: null, unplannedH: null, coverageDays: 3, adherence: { cut: 1 } });
    expect(out.snapshot).toMatchObject({ efficiency: {}, fabEfficiency: null });
    expect(out.manpower.rows[0]).toMatchObject({ requiredH: 4000, needed: 20, neededNow: 25, present: null, gap: null, tone: null });
    expect(out.load).toBe(c.load);
    expect(out.coverage).toBe(c.coverage);
    expect(JSON.stringify(out)).not.toContain("Breakdown");
  });
});
