import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The weekly plan's capacity check (lib/server/planCapacity.ts): a stage set
// to 0 h/day is an overload, not an unconfigured stage; the pace counts the
// elapsed FULL factory days' output only; "today" is the factory's (Cairo).

const h = vi.hoisted(() => ({
  prisma: { planSchedule: { findMany: vi.fn() }, handoverEntry: { findMany: vi.fn() } },
  orders: vi.fn(), std: vi.fn(), capacity: vi.fn(), holidays: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/standardTimes", () => ({ getStdData: h.std, getStageCapacity: h.capacity }));
vi.mock("@/lib/server/loads", () => ({ loadMasterOrders: h.orders, loadHolidays: h.holidays }));
vi.mock("@/lib/domain/stdEngine", () => ({
  requiredHoursForLines: (_std: unknown, lines: { qty: number }[]) => ({ byStage: { Cut: lines.reduce((s, l) => s + l.qty, 0) * 2, Welding: 0, ShotBlast: 0, Painting: 0 }, uncoveredPcs: 0, totalPcs: lines.reduce((s, l) => s + l.qty, 0) }),
  tierForOrder: () => 1,
  itemHoursFor: () => ({ TN: { cut: 2, weld: 0, shb: 0, paint: 0 } }),
}));

import { getPlanCapacity } from "@/lib/server/planCapacity";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
beforeEach(() => {
  vi.clearAllMocks();
  // Sat 24 Oct – Thu 29 Oct 2026, one order of 10 TN promised on the Saturday
  h.prisma.planSchedule.findMany.mockResolvedValue([{ mo: "A", item: "TN", ovenDate: d("2026-10-24"), qty: 10 }, { mo: "A", item: "TN", ovenDate: d("2026-10-29"), qty: 10 }]);
  h.orders.mockResolvedValue([{ mo: "A", planQty: 10, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, excludedItems: null, includedItems: null, kva: "1000", rating: null }]);
  h.std.mockResolvedValue({});
  h.holidays.mockResolvedValue([]);
  h.prisma.handoverEntry.findMany.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("getPlanCapacity", () => {
  it("reads a stage set to 0 h/day as over capacity, and one with no figure as unset", async () => {
    h.capacity.mockResolvedValue({ Cut: 0, Welding: 8 });
    const r = await getPlanCapacity(41);
    const stage = (dept: string) => r!.stages.find((s) => s.dept === dept)!;
    // the repeat on Thursday is the same 10 pieces: 20 h of Cut, not 40
    expect(stage("Cut")).toMatchObject({ required: 20, available: 0, load: Infinity });
    expect(stage("Welding")).toMatchObject({ required: 0, load: 0 });
    expect(stage("Painting")).toMatchObject({ available: null, load: null });
  });
  it("counts the pace over the elapsed FULL factory days — today's rows are not divided over the days before it", async () => {
    // 01:30 Cairo on Mon 26 Oct = 22:30 UTC on Sun 25 Oct: the factory day is the 26th
    vi.useFakeTimers({ now: new Date("2026-10-25T22:30:00Z"), toFake: ["Date"] });
    h.capacity.mockResolvedValue({ Cut: 10 });
    const r = await getPlanCapacity(41);
    const where = h.prisma.handoverEntry.findMany.mock.calls[0][0].where;
    expect(where.date).toEqual({ gte: d("2026-10-24"), lt: d("2026-10-26") });
    // Saturday and Sunday are the two full days worked
    expect(r!.pace?.elapsedWd).toBe(2);
  });
});
