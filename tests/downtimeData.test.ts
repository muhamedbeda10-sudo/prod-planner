import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ stops: vi.fn(), machines: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { machineDowntime: { findMany: h.stops }, machine: { findMany: h.machines } } }));
import { getDowntimeDay } from "@/lib/server/downtime";
it("reads a timed unlisted asset and a historical registered-machine stop without inventing old times", async () => {
  h.machines.mockResolvedValue([]);
  h.stops.mockResolvedValue([
    { id: 1, date: new Date("2026-10-24T00:00:00Z"), machineId: null, machine: null, customName: "Compressor", customDept: "Cut", customCentre: "Cutting", hours: 85 / 60, startTime: "08:10", endTime: "09:35", endsNextDay: false, reasonCode: "MECH", reason: null, recordedBy: "Planner" },
    { id: 2, date: new Date("2026-10-24T00:00:00Z"), machineId: 3, machine: { code: "LSR-1", name: "Laser", dept: "Cut", center: "Cutting" }, hours: 2, startTime: null, endTime: null, endsNextDay: false, reasonCode: "OTHER", reason: null, recordedBy: "Planner" },
  ]);
  const data = await getDowntimeDay("2026-10-24");
  expect(data.rows[0]).toMatchObject({ machineId: null, machineCode: "Compressor", dept: "Cut", centre: "Cutting", hours: 85 / 60, startTime: "08:10", endTime: "09:35" });
  expect(data.rows[1]).toMatchObject({ machineId: 3, machineCode: "LSR-1", hours: 2, startTime: null, endTime: null });
});

it("includes an incident opened days ago and reports elapsed hours separately from its stored open duration", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-25T09:00:00Z"));
  try {
    h.machines.mockResolvedValue([]);
    h.stops.mockResolvedValue([{ id: 9, date: new Date("2026-10-23T00:00:00Z"), machineId: null, machine: null, customName: "Water treatment line", customDept: "Painting", customCentre: "Painting", hours: 0, startTime: "10:15", endTime: null, endDate: null, endsNextDay: false, isOpen: true, reasonCode: "OTHER", reason: "Need mechanic", recordedBy: "Planner" }]);
    const data = await getDowntimeDay("2026-10-25");
    expect(data.rows[0]).toMatchObject({ dateISO: "2026-10-23", isOpen: true, hours: 49.75, storedHours: 0, dayHours: 12, endTime: null, endDateISO: null });
    const where = h.stops.mock.calls.at(-1)![0].where;
    expect(where.OR).toContainEqual({ isOpen: true });
    expect(where.date.lte).toEqual(new Date("2026-10-25T00:00:00Z"));
  } finally { vi.useRealTimers(); }
});
