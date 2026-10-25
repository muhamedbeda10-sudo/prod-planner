import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ totals: vi.fn(), entries: vi.fn(), stops: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { deptDayHours: { findMany: h.totals }, shiftEntry: { findMany: h.entries }, machineDowntime: { groupBy: h.stops } } }));
vi.mock("@/lib/server/data", () => ({ getShiftHours: async () => ({ short: 8, long: 8, overtime: 3, nightOvertime: 3 }) }));
vi.mock("@/lib/server/workers", () => ({ getRosterFor: vi.fn() }));
vi.mock("@/lib/server/standardTimes", () => ({ getStageCapacity: vi.fn() }));
import { getShiftHistory } from "@/lib/server/shifts";
const day = (s: string) => new Date(`${s}T00:00:00Z`);
beforeEach(() => vi.resetAllMocks());
it("includes stop-only days, a selected old date and current attendance hour totals", async () => {
  h.totals.mockResolvedValueOnce([{ date: day("2026-10-21") }]).mockResolvedValueOnce([{ date: day("2026-10-21"), hours: 99, people: 9 }, { date: day("2020-01-02"), hours: 20, people: 2 }]);
  h.stops.mockResolvedValueOnce([{ date: day("2026-10-22"), _count: { _all: 2 } }]).mockResolvedValueOnce([{ date: day("2026-10-22"), _count: { _all: 2 } }]);
  h.entries.mockResolvedValue([
    { date: day("2026-10-21"), present: true, shift: "S9", overtimeH: 0 },
    { date: day("2026-10-21"), present: true, shift: "S11", overtimeH: 3 },
    { date: day("2026-10-21"), present: false, shift: "S9", overtimeH: 0 },
  ]);
  const result = await getShiftHistory(["Punching"], 14, "2020-01-02");
  expect(result).toEqual([
    { dateISO: "2026-10-22", hours: 0, people: 0, day: 0, night: 0, entries: 0, stops: 2 },
    { dateISO: "2026-10-21", hours: 19, people: 2, day: 1, night: 1, entries: 3, stops: 0 },
    { dateISO: "2020-01-02", hours: 20, people: 2, day: 0, night: 0, entries: 0, stops: 0, legacyHours: 20 },
  ]);
  expect(h.entries.mock.calls[0][0].where.dept).toEqual({ in: ["Punching"] });
  expect(h.entries.mock.calls[0][0].where.date.in).toContainEqual(day("2020-01-02"));
});
it("keeps a deleted selected date out of history when it has no remaining data", async () => {
  h.totals.mockResolvedValue([]); h.stops.mockResolvedValue([]); h.entries.mockResolvedValue([]);
  expect(await getShiftHistory(["Punching"], 14, "2026-10-05")).toEqual([]);
});

it("retains legacy totals for departments without rows while pricing the other departments from attendance", async () => {
  h.totals.mockResolvedValueOnce([{ date: day("2026-10-21") }]).mockResolvedValueOnce([{ date: day("2026-10-21"), dept: "Punching", hours: 99, people: 9 }, { date: day("2026-10-21"), dept: "Bending", hours: 16, people: 2 }]);
  h.stops.mockResolvedValue([]);
  h.entries.mockResolvedValue([{ date: day("2026-10-21"), dept: "Punching", present: true, shift: "S9", overtimeH: 0 }]);
  expect((await getShiftHistory(["Punching", "Bending"]))[0]).toMatchObject({ hours: 24, people: 3, day: 1, night: 0, entries: 1, legacyHours: 16 });
});
