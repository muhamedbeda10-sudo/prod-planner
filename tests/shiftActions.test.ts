import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the SHIFTS tab's save: a worker the page still shows as not set is
// refused, never saved as absent; a row is recorded only under a department
// the worker is registered in, unless the day already has it -----------------

const h = vi.hoisted(() => ({
  prisma: {
    worker: { findMany: vi.fn() },
    shiftEntry: { findMany: vi.fn(), upsert: vi.fn() },
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
const NAMES: Record<number, string> = { 1: "Ahmed", 2: "Mohamed" };
const worker = (id: number, depts: string, active = true) => ({ id, empId: `10${id}`, name: NAMES[id], active, depts });

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: { name: "Sara" } });
  // 1 is a laser operator who also welds; 2 is a welder (stored as the bare
  // department, as rows from before the sections are)
  h.prisma.worker.findMany.mockResolvedValue([worker(1, "LaserCutTX,WeldingTX"), worker(2, "Welding")]);
  h.prisma.shiftEntry.findMany.mockResolvedValue([]);
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
});

describe("saveShiftRoster", () => {
  it("saves one department independently without requiring, writing or recalculating any other department", async () => {
    // Worker 1 also belongs to Fabrication; recording Welding does not book that other row.
    expect(await saveShiftRoster(form([line(1), line(2)]))).toEqual({ ok: true });
    expect(h.requirePerm.mock.calls).toEqual([["shifts.welding"]]);
    expect(h.prisma.shiftEntry.upsert.mock.calls.map(([args]) => args.create.dept)).toEqual(["Welding", "Welding"]);
    expect(h.syncDeptDayHours).toHaveBeenCalledTimes(1);
    expect(h.syncDeptDayHours).toHaveBeenCalledWith(h.prisma, new Date("2026-10-12T00:00:00Z"), "Welding");
  });
  it("accepts today's roster after midnight Cairo while UTC is still yesterday, and refuses tomorrow", async () => {
    // 01:30 on 26 Oct in Cairo = 22:30 UTC on 25 Oct — the night shift is recorded now
    vi.useFakeTimers({ now: new Date("2026-10-25T22:30:00Z"), toFake: ["Date"] });
    try {
      const today = form([line(1), line(2)]);
      today.set("date", "2026-10-26");
      expect(await saveShiftRoster(today)).toEqual({ ok: true });
      const tomorrow = form([line(1), line(2)]);
      tomorrow.set("date", "2026-10-27");
      expect(await saveShiftRoster(tomorrow)).toEqual({ ok: false, error: "That day has not come yet." });
    } finally {
      vi.useRealTimers();
    }
  });
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

  it("refuses a row under a department the worker is not registered in, and writes nothing for the day", async () => {
    // Fabrication's log cannot book a welder — that would inflate Fabrication's man-hours
    const r = await saveShiftRoster(form([line(1, { dept: "Cut" }), line(2, { dept: "Cut" })]));
    expect(r).toEqual({ ok: false, error: "102 — Mohamed is not registered in Fabrication — reload the page." });
    expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
    expect(h.syncDeptDayHours).not.toHaveBeenCalled();
    // only the rows outside their department are looked up, inside the transaction
    expect(h.prisma.shiftEntry.findMany).toHaveBeenCalledWith({
      where: { date: new Date("2026-10-12T00:00:00.000Z"), dept: { in: ["Cut"] }, workerId: { in: [2] } },
      select: { dept: true, workerId: true },
    });
  });

  it("reads only the day's own rows when everyone is in his department", async () => {
    expect(await saveShiftRoster(form([line(1), line(2)]))).toEqual({ ok: true });
    // one read of the day's stored overtime — no lookup of the workers' departments
    expect(h.prisma.shiftEntry.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { date: new Date("2026-10-12T00:00:00.000Z"), dept: { in: ["Welding"] }, workerId: { in: [1, 2] } },
      select: { dept: true, workerId: true, overtimeH: true },
    });
  });

  describe("overtime is the fixed period of Settings", () => {
    it("accepts the configured period to the hundredth — a 2.25 h setting is not rounded to 2.5", async () => {
      vi.doMock("@/lib/server/data", () => ({ getShiftHours: async () => ({ short: 8, long: 8, overtime: 2.25, nightOvertime: 3 }) }));
      vi.resetModules();
      const { saveShiftRoster: save } = await import("@/app/shifts/actions");
      expect(await save(form([line(1, { overtimeH: 2.25 }), line(2)]))).toEqual({ ok: true });
      expect(h.prisma.shiftEntry.upsert.mock.calls.map(([a]) => a.create.overtimeH)).toEqual([2.25, 0]);
      vi.doUnmock("@/lib/server/data");
      vi.resetModules();
    });
    it("refuses another figure, names the period, and writes nothing", async () => {
      expect(await saveShiftRoster(form([line(1, { overtimeH: 1.5 }), line(2)]))).toEqual({ ok: false, error: "Overtime is the fixed 2-hour period (16:00–19:00)." });
      expect(await saveShiftRoster(form([line(1, { shift: "S11", overtimeH: 2 }), line(2)]))).toEqual({ ok: false, error: "Overtime is the fixed 3-hour period (04:00–07:00)." });
      expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
    });
    it("keeps the overtime a row already holds from before the period changed, so the day can be re-saved", async () => {
      // the day was saved with 3 h when the day period was 3; it is 2 now, and one man is marked absent
      h.prisma.shiftEntry.findMany.mockResolvedValue([{ dept: "Welding", workerId: 1, overtimeH: 3 }, { dept: "Welding", workerId: 2, overtimeH: 3 }]);
      expect(await saveShiftRoster(form([line(1, { overtimeH: 3 }), line(2, { present: false, overtimeH: 0 })]))).toEqual({ ok: true });
      expect(h.prisma.shiftEntry.upsert.mock.calls.map(([a]) => a.create.overtimeH)).toEqual([3, 0]);
      // but a NEW figure that is neither the period nor the row's is still refused
      expect(await saveShiftRoster(form([line(1, { overtimeH: 2.5 }), line(2)]))).toEqual({ ok: false, error: "Overtime is the fixed 2-hour period (16:00–19:00)." });
    });
  });

  // worker 2 welded on that day and was moved to Fabrication afterwards
  const moved = () => h.prisma.worker.findMany.mockResolvedValue([worker(1, "LaserCutTX"), worker(2, "LaserCutTX")]);

  it("keeps a row the day already has for a worker who moved or retired since", async () => {
    moved();
    h.prisma.shiftEntry.findMany.mockResolvedValue([{ dept: "Welding", workerId: 2 }]);
    expect(await saveShiftRoster(form([line(2, { present: false })]))).toEqual({ ok: true });
    expect(h.prisma.shiftEntry.upsert).toHaveBeenCalledTimes(1);
  });

  it("still refuses a worker who never had a row under that department on that day", async () => {
    moved();
    h.prisma.shiftEntry.findMany.mockResolvedValue([{ dept: "Welding", workerId: 2 }]);
    expect(await saveShiftRoster(form([line(1), line(2)]))).toEqual({ ok: false, error: "101 — Ahmed is not registered in Welding — reload the page." });
    expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
  });

  it("does not let a worker's row under one department open another department to him", async () => {
    moved();
    h.prisma.shiftEntry.findMany.mockResolvedValue([{ dept: "Cut", workerId: 2 }]);
    expect(await saveShiftRoster(form([line(2, { dept: "Cut", center: "Cutting" }), line(2)]))).toEqual({ ok: false, error: "102 — Mohamed is not registered in Welding — reload the page." });
    expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
  });

  it("refuses a worker deactivated or deleted since the page was opened", async () => {
    h.prisma.worker.findMany.mockResolvedValue([worker(1, "WeldingTX"), worker(2, "WeldingTX", false)]);
    expect(await saveShiftRoster(form([line(1), line(2)]))).toEqual({ ok: false, error: "A worker on the page is no longer on the list — reload the page." });
    expect(await saveShiftRoster(form([line(1), line(3)]))).toEqual({ ok: false, error: "A worker on the page is no longer on the list — reload the page." });
    expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
  });

  it("keeps a deactivated worker on the days he was still on the list", async () => {
    h.prisma.worker.findMany.mockResolvedValue([worker(1, "WeldingTX"), worker(2, "WeldingTX", false)]);
    h.prisma.shiftEntry.findMany.mockResolvedValue([{ dept: "Welding", workerId: 2 }]);
    expect(await saveShiftRoster(form([line(1), line(2)]))).toEqual({ ok: true });
    expect(h.prisma.shiftEntry.upsert).toHaveBeenCalledTimes(2);
  });

  it("reads a section stored as the bare department, as rows from before the sections are", async () => {
    h.prisma.worker.findMany.mockResolvedValue([worker(1, "Cut"), worker(2, "Welding")]);
    expect(await saveShiftRoster(form([line(1, { dept: "Cut", center: "Cutting" }), line(2)]))).toEqual({ ok: true });
    expect(h.prisma.shiftEntry.upsert).toHaveBeenCalledTimes(2);
  });
});


it("records night overtime with the night setting and rejects the day duration", async () => {
  expect(await saveShiftRoster(form([line(1, { shift: "S11", overtimeH: 3 })]))).toEqual({ ok: true });
  expect(h.prisma.shiftEntry.upsert.mock.calls[0][0].create).toMatchObject({ shift: "S11", overtimeH: 3 });
  vi.clearAllMocks();
  expect(await saveShiftRoster(form([line(1, { shift: "S11", overtimeH: 2 })]))).toEqual({ ok: false, error: expect.stringContaining("3-hour period (04:00–07:00)") });
  expect(h.prisma.shiftEntry.upsert).not.toHaveBeenCalled();
});
