import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ stops: vi.fn(), machines: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { machineDowntime: { findMany: h.stops }, machine: { findMany: h.machines } } }));
import { getDowntimeDay } from "@/lib/server/downtime";
it("reads a timed unlisted asset and a historical registered-machine stop without inventing old times", async () => {
  h.machines.mockResolvedValue([]);
  h.stops.mockResolvedValue([
    { id: 1, machineId: null, machine: null, customName: "Compressor", customDept: "Cut", customCentre: "Cutting", hours: 85 / 60, startTime: "08:10", endTime: "09:35", endsNextDay: false, reasonCode: "MECH", reason: null, recordedBy: "Planner" },
    { id: 2, machineId: 3, machine: { code: "LSR-1", name: "Laser", dept: "Cut", center: "Cutting" }, hours: 2, startTime: null, endTime: null, endsNextDay: false, reasonCode: "OTHER", reason: null, recordedBy: "Planner" },
  ]);
  const data = await getDowntimeDay("2026-10-24");
  expect(data.rows[0]).toMatchObject({ machineId: null, machineCode: "Compressor", dept: "Cut", centre: "Cutting", hours: 85 / 60, startTime: "08:10", endTime: "09:35" });
  expect(data.rows[1]).toMatchObject({ machineId: 3, machineCode: "LSR-1", hours: 2, startTime: null, endTime: null });
});
