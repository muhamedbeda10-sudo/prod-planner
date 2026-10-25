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
vi.mock("@/lib/server/data", () => ({ getShiftHours: async () => ({ short: 8, long: 11, overtime: 3 }) }));

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

  it("looks nothing up when everyone is in his department", async () => {
    expect(await saveShiftRoster(form([line(1), line(2)]))).toEqual({ ok: true });
    expect(h.prisma.shiftEntry.findMany).not.toHaveBeenCalled();
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
