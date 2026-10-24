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
      load: [{ centre: "Welding", days: [], loadRate: 0.734, behindH: 256.1, shortFromISO: "2026-10-25", clearsISO: "2026-11-02", shortH: 0 }],
      coverage: { wipH: 306.2, ratePerDay: 137.9, days: 2.2, band: "ok", byItem: [] },
      losses: { causes: [], unplannedH: 6.5, plannedH: 4, absentRate: 0.1111, overtimeH: 126, fromISO: "2026-10-18" },
      pricedShare: 1, actions: [{ tone: "bad", text: "29 plan line(s) are behind", href: "/tracker?view=weekly" }], trend: [],
    });
    const out = await getKpisTool.run({}, {} as never);
    const j = JSON.parse(out.text);
    expect(j.decisions).toEqual(["bad: 29 plan line(s) are behind"]);
    expect(j.weeklyPlan).toMatchObject({ planNo: 43, behindCount: 29, adherence: [{ stage: "finish", rate: 0.2 }] });
    expect(j.centres[0].lastDay.efficiency).toBe(0.53);
    expect(j.loadAhead[0]).toMatchObject({ centre: "Welding", loadRate: 0.73, behindH: 256.1, clears: "2026-11-02", shortAtEndH: 0 });
    expect(j.losses.absentRate).toBe(0.11);
    expect(out.links).toEqual([{ label: "Planning cockpit", href: "/cockpit" }]);
  });
});
