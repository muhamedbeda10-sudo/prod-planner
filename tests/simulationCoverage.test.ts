import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ tracker: vi.fn(), orders: vi.fn(), schedules: vi.fn(), std: vi.fn(), entries: vi.fn(), line: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { handoverEntry: { findMany: h.entries } } }));
vi.mock("@/lib/server/line", () => ({ withLine: h.line }));
vi.mock("@/lib/server/loads", () => ({ loadAllSchedules: h.schedules, loadMasterOrders: h.orders, loadHolidays: async () => [] }));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: h.tracker }));
vi.mock("@/lib/server/standardTimes", () => ({ getStdData: h.std }));
import { getEtaBase } from "@/lib/server/eta";
import { TRANSFORMERS } from "@/evals/planning/fixtures";
beforeEach(() => {
  vi.clearAllMocks();
  h.line.mockImplementation((_line, run) => run());
  h.std.mockResolvedValue({ tiers: { 1000: { cut: 10, weld: 10, shb: 5, paint: 5 } }, fgMap: {} });
  h.entries.mockResolvedValue([]);
  h.orders.mockResolvedValue([{ mo: "MO-A", kva: "1000" }, { mo: "MO-C", kva: null }]);
  h.schedules.mockResolvedValue([]);
});
it("reports unresolved required components excluded from the forecast, plus holds and pending quantities", async () => {
  const a = structuredClone(TRANSFORMERS[0]); a.pendingQty = { to: 12, month: "October 2026" };
  const c = structuredClone(TRANSFORMERS[2]); c.hold.onHold = false; c.kva = null;
  const held = structuredClone(TRANSFORMERS[2]); held.mo = "HELD";
  h.tracker.mockResolvedValue([a, c, held]);
  const result = await getEtaBase();
  expect(result.coverage).toMatchObject({ openOrders: 3, heldOrders: 1, pendingQuantityOrders: 1 });
  expect(result.coverage?.missingTimes).toHaveLength(4);
  expect(result.coverage?.missingTimes.every((r) => r.mo === "MO-C")).toBe(true);
  expect(result.jobs.every((j) => j.mo === "MO-A")).toBe(true);
  expect(h.line).toHaveBeenCalledWith("TR", expect.any(Function));
});
it("does not turn zero standard time into a zero-duration delivery forecast", async () => {
  h.std.mockResolvedValue({ tiers: { 1000: { cut: 0, weld: 10, shb: 5, paint: 5 } }, fgMap: {} });
  const c = structuredClone(TRANSFORMERS[2]); c.hold.onHold = false; c.kva = "1000";
  h.orders.mockResolvedValue([{ mo: c.mo, kva: "1000" }]);
  h.tracker.mockResolvedValue([c]);
  const result = await getEtaBase();
  expect(result.coverage?.missingTimes).toHaveLength(4);
  expect(result.jobs).toHaveLength(0);
});

afterEach(() => vi.useRealTimers());
it("uses the factory day after Cairo midnight, and rates exclude that unfinished day", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T22:30:00Z"));
  h.tracker.mockResolvedValue([]);
  const result = await getEtaBase();
  expect(result.todayISO).toBe("2026-10-24");
  expect(h.entries.mock.calls[0][0].where.date.lt).toEqual(new Date("2026-10-24T00:00:00Z"));
});
