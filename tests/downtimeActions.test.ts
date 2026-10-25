import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- recording a machine stop on the shift log --------------------------------

const h = vi.hoisted(() => ({
  prisma: {
    machine: { findUnique: vi.fn() },
    machineDowntime: { aggregate: vi.fn(), create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requirePerm: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm }));
vi.mock("@/lib/server/events", () => ({ emitEvent: vi.fn() }));

import { addDowntime, deleteDowntime, updateDowntime } from "@/app/shifts/downtimeActions";

const form = (f: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(f)) fd.set(k, v);
  return fd;
};
const stop = (o: Record<string, string> = {}) => form({ date: "2026-10-12", machineId: "3", hours: "1.5", reasonCode: "MECH", ...o });

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: { name: "Sara" } });
  h.prisma.machine.findUnique.mockResolvedValue({ id: 3, code: "LSR-1", dept: "Cut", active: true });
  h.prisma.machineDowntime.aggregate.mockResolvedValue({ _sum: { hours: null } });
  h.prisma.machineDowntime.findMany.mockResolvedValue([]);
  h.prisma.machineDowntime.create.mockResolvedValue({ id: 9 });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
});

describe("addDowntime", () => {
  it("records the stop under the department's shift-log permission", async () => {
    expect(await addDowntime(stop({ reason: " belt " }))).toEqual({ ok: true, id: 9, hours: 1.5 });
    expect(h.requirePerm).toHaveBeenCalledWith("shifts.cut");
    expect(h.prisma.machineDowntime.create).toHaveBeenCalledWith({ data: { date: new Date("2026-10-12T00:00:00.000Z"), machineId: 3, hours: 1.5, reasonCode: "MECH", reason: "belt", recordedBy: "Sara" } });
  });

  it("keeps the hours to the quarter hour, and refuses a day after the factory's today", async () => {
    expect(await addDowntime(stop({ hours: "1.1" }))).toMatchObject({ ok: true, hours: 1 });
    expect(await addDowntime(stop({ date: "2999-01-01" }))).toEqual({ ok: false, error: "That day has not come yet." });
  });

  it("refuses a stop with no reason, no hours, or more than the day", async () => {
    expect(await addDowntime(stop({ reasonCode: "" }))).toEqual({ ok: false, error: "Pick why it stopped." });
    expect(await addDowntime(stop({ hours: "0" }))).toMatchObject({ ok: false, error: expect.stringContaining("quarter of an hour") });
    h.prisma.machineDowntime.aggregate.mockResolvedValue({ _sum: { hours: 23 } });
    expect(await addDowntime(stop({ hours: "2" }))).toMatchObject({ ok: false, error: expect.stringContaining("more than the day") });
    expect(h.prisma.machineDowntime.create).not.toHaveBeenCalled();
  });

  it("refuses without the department's permission", async () => {
    h.requirePerm.mockResolvedValue({ error: "No permission." });
    expect(await addDowntime(stop())).toEqual({ ok: false, error: "No permission." });
  });
});

describe("deleteDowntime", () => {
  it("deletes a stop under its machine's department permission", async () => {
    h.prisma.machineDowntime.findUnique.mockResolvedValue({ id: 9, machineId: 3 });
    h.prisma.machineDowntime.deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteDowntime(form({ id: "9" }))).toEqual({ ok: true, id: 9 });
    expect(h.prisma.machineDowntime.deleteMany).toHaveBeenCalledWith({ where: { id: 9 } });
    h.prisma.machineDowntime.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteDowntime(form({ id: "9" }))).toMatchObject({ ok: false, error: expect.stringContaining("already gone") });
  });
});


describe("updateDowntime", () => {
  const before = { hours: 1.5, reasonCode: "MECH", reason: "belt" };
  const edit = (overrides: Record<string, string> = {}) => form({ id: "9", hours: "2", reasonCode: "ELEC", reason: "motor", before: JSON.stringify(before), ...overrides });
  beforeEach(() => {
    h.prisma.machineDowntime.findUnique.mockResolvedValue({ id: 9, date: new Date("2026-10-05T00:00:00Z"), machineId: 3, ...before });
    h.prisma.machineDowntime.updateMany.mockResolvedValue({ count: 1 });
  });
  it("edits the original day and machine without counting the old hours twice", async () => {
    expect(await updateDowntime(edit())).toEqual({ ok: true, id: 9, hours: 2 });
    expect(h.prisma.machineDowntime.aggregate).toHaveBeenCalledWith({ where: { date: new Date("2026-10-05T00:00:00Z"), machineId: 3, id: { not: 9 } }, _sum: { hours: true } });
    expect(h.prisma.machineDowntime.updateMany.mock.calls[0][0].data).toEqual({ hours: 2, reasonCode: "ELEC", reason: "motor", recordedBy: "Sara" });
  });
  it("rejects stale editor data, forbidden departments and totals exceeding a day", async () => {
    expect((await updateDowntime(edit({ before: JSON.stringify({ ...before, hours: 0.5 }) }))).ok).toBe(false);
    expect(h.prisma.machineDowntime.updateMany).not.toHaveBeenCalled();
    h.requirePerm.mockResolvedValueOnce({ error: "Forbidden" });
    expect(await updateDowntime(edit())).toEqual({ ok: false, error: "Forbidden" });
    h.prisma.machineDowntime.aggregate.mockResolvedValue({ _sum: { hours: 23 } });
    expect((await updateDowntime(edit())).ok).toBe(false);
    expect(h.prisma.machineDowntime.updateMany).not.toHaveBeenCalled();
  });
  it("keeps a legacy imported duration exact when only its cause or note changes", async () => {
    h.prisma.machineDowntime.findUnique.mockResolvedValue({ id: 9, date: new Date("2026-10-05T00:00:00Z"), machineId: 3, ...before, hours: 1.42 });
    expect(await updateDowntime(edit({ hours: "1.42", before: JSON.stringify({ ...before, hours: 1.42 }) }))).toMatchObject({ ok: true, hours: 1.42 });
  });
});

const timed = (overrides: Record<string, string> = {}) => stop({ startTime: "08:10", endTime: "09:35", endsNextDay: "false", hours: "23", ...overrides });
describe("clock times and unlisted equipment", () => {
  it("derives exact minute hours on the server, ignores supplied hours and persists both times", async () => {
    const result = await addDowntime(timed());
    expect(result).toMatchObject({ ok: true, hours: 85 / 60 });
    expect(h.prisma.machineDowntime.create.mock.calls[0][0].data).toMatchObject({ hours: 85 / 60, startTime: "08:10", endTime: "09:35", endsNextDay: false });
  });
  it("accepts overnight and minute-long stops but refuses incomplete, zero and over-24h ranges", async () => {
    expect(await addDowntime(timed({ startTime: "23:30", endTime: "01:00", endsNextDay: "true" }))).toMatchObject({ ok: true, hours: 1.5 });
    expect(await addDowntime(timed({ startTime: "08:10", endTime: "08:11" }))).toMatchObject({ ok: true, hours: 1 / 60 });
    h.prisma.machineDowntime.create.mockClear();
    for (const pair of ([{ startTime: "", endTime: "01:00" }, { startTime: "10:00", endTime: "10:00" }, { startTime: "08:00", endTime: "09:00", endsNextDay: "true" }, { startTime: "24:00", endTime: "01:00" }] as Record<string, string>[])) expect((await addDowntime(timed(pair))).ok).toBe(false);
    expect(h.prisma.machineDowntime.create).not.toHaveBeenCalled();
  });
  it("records an unlisted asset with department permission and no machine registry write", async () => {
    const fd = timed({ machineId: "custom", customName: "  Air   compressor  ", customDept: "Punching" });
    expect((await addDowntime(fd)).ok).toBe(true);
    expect(h.requirePerm).toHaveBeenCalledWith("shifts.lv");
    expect(h.prisma.machine.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.machineDowntime.create.mock.calls[0][0].data).toMatchObject({ machineId: null, customName: "Air compressor", customDept: "Punching", customCentre: null });
    expect(h.prisma.machineDowntime.aggregate.mock.calls[0][0].where).toMatchObject({ machineId: null, customDept: "Punching", customName: { equals: "Air compressor", mode: "insensitive" } });
  });
  it("requires an unlisted asset's name, valid department, centre when needed and that department's permission", async () => {
    for (const input of [{ customName: "" }, { customDept: "Unknown" }, { customDept: "Cut", customCentre: "" }, { customDept: "Cut", customCentre: "Painting" }]) expect((await addDowntime(timed({ machineId: "custom", customName: "Compressor", customDept: "Cut", customCentre: "Cutting", ...input }))).ok).toBe(false);
    h.requirePerm.mockResolvedValue({ error: "Forbidden" });
    expect(await addDowntime(timed({ machineId: "custom", customName: "Compressor", customDept: "Punching" }))).toEqual({ ok: false, error: "Forbidden" });
    expect(h.prisma.machineDowntime.create).not.toHaveBeenCalled();
  });
  it("rejects overlapping stops across midnight while allowing touching intervals", async () => {
    h.prisma.machineDowntime.findMany.mockResolvedValue([{ date: new Date("2026-10-11T00:00:00Z"), startTime: "23:00", endTime: "01:00", endsNextDay: true }]);
    expect((await addDowntime(timed({ startTime: "00:30", endTime: "01:30" }))).ok).toBe(false);
    expect(h.prisma.machineDowntime.create).not.toHaveBeenCalled();
    expect((await addDowntime(timed({ startTime: "01:00", endTime: "01:30" }))).ok).toBe(true);
  });
  it("edits a timed unlisted record using its original scope, preserves times in conflict checks and can delete it", async () => {
    const row = { id: 9, date: new Date("2026-10-12T00:00:00Z"), machineId: null, customName: "Air compressor", customDept: "Punching", customCentre: null, hours: 1, startTime: "08:00", endTime: "09:00", endsNextDay: false, reasonCode: "MECH", reason: null };
    h.prisma.machineDowntime.findUnique.mockResolvedValue(row); h.prisma.machineDowntime.updateMany.mockResolvedValue({ count: 1 });
    const before = JSON.stringify({ hours: 1, reasonCode: "MECH", reason: null, startTime: "08:00", endTime: "09:00", endsNextDay: false });
    expect(await updateDowntime(form({ id: "9", startTime: "08:00", endTime: "09:25", endsNextDay: "false", reasonCode: "ELEC", before }))).toMatchObject({ ok: true, hours: 85 / 60 });
    expect(h.prisma.machineDowntime.updateMany.mock.calls[0][0].where).toMatchObject({ machineId: null, startTime: "08:00", endTime: "09:00" });
    expect(h.prisma.machine.findUnique).not.toHaveBeenCalled();
    expect((await updateDowntime(form({ id: "9", hours: "2", reasonCode: "ELEC", before }))).ok).toBe(false);
    h.prisma.machineDowntime.findUnique.mockResolvedValue({ ...row, endTime: "09:30" });
    expect((await updateDowntime(form({ id: "9", startTime: "08:00", endTime: "09:25", reasonCode: "ELEC", before }))).ok).toBe(false);
    h.prisma.machineDowntime.deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteDowntime(form({ id: "9" }))).toMatchObject({ ok: true });
    expect(h.requirePerm).toHaveBeenCalledWith("shifts.lv");
  });
});
