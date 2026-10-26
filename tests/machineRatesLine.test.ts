import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Admin → Times per machine prices one physical floor ----------------------
// The machine records carry no product line, so the page must read the
// transformer registry whatever line is on screen: with the panels on screen
// every machine row used to come out unpriced and the day's hours were split
// by pieces instead of standard hours. A record whose order is not on the
// master list yet is still priced by its project's class, as the cockpit does.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return { prisma: { handoverEntry: { findMany: fn() }, shiftEntry: { findMany: fn() }, masterOrder: { findMany: fn() } } };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
// outside a request there is no cookie jar — `next/headers` cannot be imported under vitest at all
vi.mock("next/headers", () => ({ cookies: async () => { throw new Error("outside a request"); } }));
vi.mock("@/lib/server/standardTimes", () => ({ getStdData: async () => ({ tiers: TIER_HOURS, fgMap: {} }) }));
vi.mock("@/lib/server/data", () => ({ getShiftHours: async () => ({ short: 8, long: 8, overtime: 3, nightOvertime: 3 }) }));

import { TIER_HOURS } from "@/lib/domain/standardTimes";
import { withLine } from "@/lib/server/line";
import { getMeasuredRates } from "@/lib/server/machineRates";

const day = new Date();
day.setUTCHours(0, 0, 0, 0);
day.setUTCDate(day.getUTCDate() - 3);
const order = (mo: string, bom: string, kva: string) => ({ mo, bom, kva, fgCode: null, line: "TR" });
const entry = (mo: string | null, bom: string, item: string, qty: number) => ({ date: day, dept: "Welding", mo, bom, item, qty, machineId: 1 });

beforeEach(() => {
  vi.resetAllMocks();
  h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", "B1", "1000"), order("MO-2", "B2", "100")]);
  h.prisma.handoverEntry.findMany.mockResolvedValue([entry("MO-1", "B1", "TN", 1), entry("MO-X", "B1", "CB", 2)]);
  h.prisma.shiftEntry.findMany.mockResolvedValue([{ date: day, machineId: 1, shift: "S9", overtimeH: 0 }]);
});

describe("getMeasuredRates", () => {
  it("reads the transformer registry on either line, so the rates do not change with it", async () => {
    const tr = await withLine("TR", () => getMeasuredRates());
    const lv = await withLine("LV", () => getMeasuredRates());
    expect(lv).toEqual(tr);
    expect(tr.rates.length).toBeGreaterThan(0);
    for (const call of h.prisma.masterOrder.findMany.mock.calls) expect(call[0]).toMatchObject({ where: { line: "TR" } });
  });

  it("prices a record whose order is unknown by its project's class, so the day is split by standard hours", async () => {
    const { rates, byMachine } = await getMeasuredRates();
    // both items earned hours — an unpriced CB would have left the day mixed and measured nothing
    expect(rates.map((r) => r.item)).toEqual(["CB", "TN"]);
    const tn = byMachine[1].TN, cb = byMachine[1].CB;
    expect(tn.pieces).toBe(1);
    expect(cb.pieces).toBe(2);
    expect(tn.hours + cb.hours).toBeCloseTo(8, 1);
    // by standard hours a tank weighs far more than a cable box; by pieces it would weigh half as much
    expect(tn.hoursPerPc).toBeGreaterThan(cb.hoursPerPc * 4);
  });
});
