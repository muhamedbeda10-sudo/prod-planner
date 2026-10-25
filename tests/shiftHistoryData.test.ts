import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ totals: vi.fn(), entries: vi.fn(), stops: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { deptDayHours: { findMany: h.totals }, shiftEntry: { groupBy: h.entries }, machineDowntime: { groupBy: h.stops } } }));
vi.mock("@/lib/server/data", () => ({ getShiftHours: async () => ({ short: 8, long: 8, overtime: 3, nightOvertime: 3 }) }));
vi.mock("@/lib/server/workers", () => ({ getAllWorkers: vi.fn() }));
vi.mock("@/lib/server/standardTimes", () => ({ getStageCapacity: vi.fn() }));
import { getShiftHistory } from "@/lib/server/shifts";
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const group = (date: string, present: boolean, shift: string, overtimeH: number, count = 1, dept = "Punching") => ({ date: day(date), dept, present, shift, overtimeH, _count: { _all: count } });
beforeEach(() => { vi.resetAllMocks(); h.totals.mockResolvedValue([]); h.stops.mockResolvedValue([]); h.entries.mockResolvedValue([]); });
it("includes stop-only days, old dates and attendance priced with current shift hours", async () => {
  h.totals.mockResolvedValue([{ date: day("2026-10-21"), dept: "Punching", hours: 99, people: 9 }, { date: day("2020-01-02"), dept: "Punching", hours: 20, people: 2 }]);
  h.stops.mockResolvedValue([{ date: day("2026-10-22"), _count: { _all: 2 } }]);
  h.entries.mockResolvedValue([group("2026-10-21", true, "S9", 0), group("2026-10-21", true, "S11", 3), group("2026-10-21", false, "S9", 0)]);
  expect(await getShiftHistory(["Punching"])).toEqual([
    { dateISO: "2026-10-22", hours: 0, people: 0, day: 0, night: 0, entries: 0, stops: 2 },
    { dateISO: "2026-10-21", hours: 19, people: 2, day: 1, night: 1, entries: 3, stops: 0 },
    { dateISO: "2020-01-02", hours: 20, people: 2, day: 0, night: 0, entries: 0, stops: 0, legacyHours: 20 },
  ]);
  expect(h.entries.mock.calls[0][0].where).toEqual({ dept: { in: ["Punching"] } });
  expect(h.stops.mock.calls[0][0].where).toEqual({ OR: [{ machine: { dept: { in: ["Punching"] } } }, { machineId: null, customDept: { in: ["Punching"] } }] });
});
it("keeps empty/deleted history empty", async () => {
  expect(await getShiftHistory(["Punching"])).toEqual([]);
});
it("retains legacy totals for departments without attendance while pricing other departments from their groups", async () => {
  h.totals.mockResolvedValue([{ date: day("2026-10-21"), dept: "Punching", hours: 99, people: 9 }, { date: day("2026-10-21"), dept: "Bending", hours: 16, people: 2 }]);
  h.entries.mockResolvedValue([group("2026-10-21", true, "S9", 0)]);
  expect((await getShiftHistory(["Punching", "Bending"]))[0]).toMatchObject({ hours: 24, people: 3, day: 1, night: 0, entries: 1, legacyHours: 16 });
});
it("returns every recorded date beyond 14 days, including attendance-only dates without a totals row", async () => {
  const dates = Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  h.entries.mockResolvedValue(dates.map((date) => group(date, true, "S9", 3, 20)));
  const history = await getShiftHistory(["Punching"]);
  expect(history).toHaveLength(80);
  expect(history[0]).toMatchObject({ dateISO: dates[79], hours: 220, people: 20, day: 20, entries: 20 });
  expect(history[79].dateISO).toBe(dates[0]);
  for (const mock of [h.totals, h.entries, h.stops]) expect(mock.mock.calls[0][0]).not.toHaveProperty("take");
});
it("counts absent groups without hours and keeps day/night overtime and fallback shifts consistent with lineHours", async () => {
  h.entries.mockResolvedValue([group("2026-10-21", true, "S9", 3, 10), group("2026-10-21", true, "S11", 3, 5), group("2026-10-21", false, "S11", 3, 4), group("2026-10-21", true, "legacy", -1, 2)]);
  expect((await getShiftHistory(["Punching"]))[0]).toMatchObject({ hours: 181, people: 17, day: 12, night: 5, entries: 21 });
});
it("does not query an empty department scope", async () => {
  expect(await getShiftHistory([])).toEqual([]);
  expect(h.entries).not.toHaveBeenCalled();
});
it("rounds hours after summing all attendance groups so quarter-hour overtime is preserved", async () => {
  h.entries.mockResolvedValue([group("2026-10-21", true, "S9", 0.25), group("2026-10-21", true, "S11", 0.25)]);
  expect((await getShiftHistory(["Punching"]))[0].hours).toBe(16.5);
});
