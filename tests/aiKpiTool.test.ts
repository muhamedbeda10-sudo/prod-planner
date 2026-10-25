import { describe, it, expect, vi } from "vitest";

// ---- the assistant reads the cockpit through the very loader the page uses ----

const h = vi.hoisted(() => ({ getCockpit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/kpis", () => ({ getCockpit: h.getCockpit }));

import { getKpisTool } from "@/lib/server/ai/tools/kpis";

const stat = (o = {}) => ({ centre: "Welding", days: 4, workedH: 100, earnedH: 90, efficiency: 0.9, downtimeH: 2, availability: null, people: 12, ...o });

describe("get_kpis", () => {
  it("hands the model the cockpit's own figures, rounded, with a link to the page", async () => {
    h.getCockpit.mockResolvedValue({
      todayISO: "2026-10-25", lastDayISO: "2026-10-24",
      week: { planNo: 43, req: 280, covered: 28, days: [{ iso: "2026-10-22", label: "Thu", req: 45, covered: 9, isPast: true, isToday: false }], adherence: [{ stage: "finish", due: 90, done: 18, rate: 0.2 }], late: [{ dayISO: "2026-10-22", bom: "B1", soi: null, item: "TN", stage: "weld", short: 2, owed: 6 }], lateCount: 29 },
      centres: [{ centre: "Welding", last: stat({ efficiency: 0.5333 }), recent: stat(), trend: [{ dateISO: "2026-10-24", earnedH: 90, workedH: 100, efficiency: 0.9 }] }],
      fabrication: { workedH: 300, earnedH: 240, efficiency: 0.8 },
      load: [{ centre: "Welding", measured: true, days: [{ dayISO: "2026-10-25", dueH: 40, capacityH: 30, tone: "bad" }], loadRate: 0.734, behindH: 256.1, shortFromISO: "2026-10-25", clearsISO: "2026-11-02", shortH: 0 }],
      coverage: { wipH: 306.2, ratePerDay: 137.9, days: 2.2, band: "ok", byItem: [] },
      manpower: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, hoursPerPersonDay: 8, pieces: 120, rows: [{ centre: "Welding", requiredH: 4000, doneH: 3000, leftH: 1000, needed: 20, neededNow: 25, present: 22, gap: -3, tone: "bad" }] },
      losses: { causes: [], unplannedH: 6.5, plannedH: 4, absentRate: 0.1111, overtimeH: 126, fromISO: "2026-10-18" },
      pricedShare: 1,
      actions: [{ tone: "bad", text: "29 plan line(s) are behind", href: "/tracker?view=weekly" }, { tone: "warn", text: "No material cost 6 machine hours", href: "/shifts", floor: true }],
      snapshot: { late: 29, adherence: {}, coverageDays: 2.2, efficiency: {}, unplannedH: 6.5 },
      trend: [{ dateISO: "2026-10-25", late: 29, adherence: { finish: 0.2 }, coverageDays: 2.2, efficiency: { Welding: 0.8999 }, unplannedH: 6.5 }],
    });
    const now = new Date("2026-10-25T08:00:00Z");
    const out = await getKpisTool.run({}, { now, hidden: new Set() } as never);
    expect(h.getCockpit).toHaveBeenCalledWith(now);
    const j = JSON.parse(out.text);
    expect(j.decisions).toEqual(["bad: 29 plan line(s) are behind", "warn: No material cost 6 machine hours"]);
    expect(j.weeklyPlan).toMatchObject({ planNo: 43, behindCount: 29, adherence: [{ stage: "finish", rate: 0.2 }] });
    expect(j.centres[0].lastDay.efficiency).toBe(0.53);
    expect(j.loadAhead[0]).toMatchObject({ centre: "Welding", measured: true, loadRate: 0.73, behindH: 256.1, clears: "2026-11-02", shortAtEndH: 0, days: [{ day: "2026-10-25", dueH: 40, capacityH: 30 }] });
    expect(j.fabrication).toEqual({ earnedH: 240, workedH: 300, efficiency: 0.8 });
    expect(j.manpower).toMatchObject({ month: "October 2026", workingDaysLeft: 5, centres: [{ centre: "Welding", peopleNeeded: 20, peopleNeededFromToday: 25, peoplePresent: 22, gap: -3 }] });
    expect(j.losses).toMatchObject({ unplannedH: 6.5, absentRate: 0.11, overtimeH: 126 });
    expect(j.trend[0]).toMatchObject({ day: "2026-10-25", behind: 29, efficiency: { Welding: 0.9 } });
    expect(out.links).toEqual([{ label: "Cockpit", href: "/" }]);
  });

  it("leaves the shift log's figures out for a person the Shifts screen is closed to", async () => {
    const out = await getKpisTool.run({}, { now: new Date(), hidden: new Set(["shifts"]) } as never);
    const j = JSON.parse(out.text);
    expect(j.centres).toBeUndefined();
    expect(j.losses).toBeUndefined();
    expect(j.fabrication).toBeUndefined();
    expect(j.trend[0].efficiency).toBeUndefined();
    expect(j.manpower.centres[0]).toEqual({ centre: "Welding", requiredH: 4000, doneH: 3000, leftH: 1000, peopleNeeded: 20, peopleNeededFromToday: 25 });
    expect(j.decisions).toEqual(["bad: 29 plan line(s) are behind"]);
    expect(j.weeklyPlan.behindCount).toBe(29);
  });
});
