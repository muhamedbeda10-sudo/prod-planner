import { describe, it, expect, vi } from "vitest";

// ---- an account the Shifts screen is closed to gets none of the panels' shift-log figures ----

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { lvWithoutFloor, type LvPlanningData } from "@/lib/server/lvKpis";

describe("lvWithoutFloor", () => {
  it("drops the departments' pace, who is present and the shift log's decisions, and keeps the month, the chain and the hours needed", () => {
    const d = {
      todayISO: "2026-10-25", lastDayISO: "2026-10-24",
      month: { monthLabel: "October 2026", monthWd: 25, leftWd: 5, orders: 3, panels: 30, complete: 18, remaining: 12 },
      open: { orders: 3, panels: 30, urgent: 1, onHold: 0 },
      wip: { notStarted: 0, waitingBend: 2, waitingWeld: 3, waitingPaint: 7, waitingDelivery: 5, onHold: 0, orders: 3, heldOrders: 0 },
      urgentStuck: [],
      manpower: { hoursPerPersonDay: 8, coverage: { orders: 3, priced: 3, panels: 30, pricedPanels: 30 }, rows: [{ centre: "WeldingLV", requiredH: 120, doneH: 60, doneBeforeH: 0, leftH: 60, needed: 0.6, neededNow: 1.5, present: 0.5, gap: -1, tone: "bad" }] },
      depts: [{ dept: "WeldingLV", days: 4, efficiency: 0.5, workedH: 100, earnedH: 50, people: 3 }],
      actions: [{ tone: "bad", text: "plan behind", href: "/tracker" }, { tone: "bad", text: "short of people", href: "/shifts", floor: true }],
    } as unknown as LvPlanningData;
    const out = lvWithoutFloor(d);
    expect(out.depts).toEqual([]);
    expect(out.manpower.rows[0]).toMatchObject({ requiredH: 120, neededNow: 1.5, present: null, gap: null, tone: null });
    expect(out.actions.map((a) => a.text)).toEqual(["plan behind"]);
    expect(JSON.stringify(out)).not.toContain("short of people");
    expect(out.month).toEqual(d.month);
    expect(out.wip).toEqual(d.wip);
  });
});
