import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the SHIFTS tab's save: a worker the page still shows as not set is
// refused, never saved as absent ----------------------------------------------

const h = vi.hoisted(() => ({
  prisma: {
    worker: { findMany: vi.fn() },
    shiftEntry: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
  requirePerm: vi.fn(),
  syncDeptDayHours: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm }));
vi.mock("@/lib/server/shifts", () => ({ syncDeptDayHours: h.syncDeptDayHours }));
vi.mock("@/lib/server/data", () => ({ getShiftHours: async () => ({ short: 8, long: 8, overtime: 2, nightOvertime: 3 }) }));

import { saveShiftRoster } from "@/app/shifts/actions";

const form = (lines: unknown[]) => {
  const fd = new FormData();
  fd.set("date", "2026-10-12");
  fd.set("lines", JSON.stringify(lines));
  return fd;
};
const line = (workerId: number, o: Record<string, unknown> = {}) => ({ dept: "Welding", workerId, present: true, shift: "S9", overtimeH: 0, note: "", recorded: true, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: { name: "Sara" } });
  h.prisma.worker.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
});

describe("saveShiftRoster", () => {
  it("refuses a day while any worker is not set, and writes nothing", async () => {
    const r = await saveShiftRoster(form([line(1), line(2, { present: false, recorded: false })]));
    expect(r).toEqual({ ok: false, error: "1 worker(s) are not set yet — pick Day, Night or Absent for everyone, then save." });
    expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
  });

  it("saves a day where everyone is set — and lines with no recorded flag, as the assistant sends them", async () => {
    const r = await saveShiftRoster(form([line(1, { shift: "S11" }), { dept: "Welding", workerId: 2, present: false, shift: "S9", overtimeH: 0, note: "" }]));
    expect(r).toEqual({ ok: true });
    expect(h.prisma.shiftEntry.upsert).toHaveBeenCalledTimes(2);
    expect(h.syncDeptDayHours).toHaveBeenCalledTimes(1);
  });

  it("keeps a Fabrication worker's work centre, refuses one that is not Fabrication's, and books none elsewhere", async () => {
    await saveShiftRoster(form([line(1, { dept: "Cut", center: "Bending" }), line(2, { center: "Bending" })]));
    const calls = h.prisma.shiftEntry.upsert.mock.calls.map((c) => c[0].create);
    expect(calls.map((c: { dept: string; center: string | null }) => [c.dept, c.center])).toEqual([["Cut", "Bending"], ["Welding", null]]);
    const r = await saveShiftRoster(form([line(1, { dept: "Cut", center: "Welding" })]));
    expect(r).toEqual({ ok: false, error: '"Welding" is not a work centre of this department.' });
  });
});


it("records night overtime with the night setting and rejects the day duration", async () => {
  expect(await saveShiftRoster(form([line(1, { shift: "S11", overtimeH: 3 })]))).toEqual({ ok: true });
  expect(h.prisma.shiftEntry.upsert.mock.calls[0][0].create).toMatchObject({ shift: "S11", overtimeH: 3 });
  vi.clearAllMocks();
  expect(await saveShiftRoster(form([line(1, { shift: "S11", overtimeH: 2 })]))).toEqual({ ok: false, error: expect.stringContaining("3-hour period (04:00–07:00)") });
  expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
});
