import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  prisma: { shiftEntry: { deleteMany: vi.fn() }, machineDowntime: { deleteMany: vi.fn() }, deptDayHours: { deleteMany: vi.fn() }, $transaction: vi.fn() },
  guard: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.guard }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
import { deleteRecordedShiftDay, deleteRecordedShiftDays } from "@/app/shifts/historyActions";
import { Prisma } from "@prisma/client";
const form = (date = "2026-10-05", depts = "Punching,Bending,WeldingLV,PaintingLV") => { const fd = new FormData(); fd.set("date", date); fd.set("depts", depts); return fd; };
beforeEach(() => {
  vi.resetAllMocks(); h.guard.mockResolvedValue({ user: { name: "Planner" } });
  h.prisma.shiftEntry.deleteMany.mockResolvedValue({ count: 8 });
  h.prisma.machineDowntime.deleteMany.mockResolvedValue({ count: 2 });
  h.prisma.deptDayHours.deleteMany.mockResolvedValue({ count: 4 });
  h.prisma.$transaction.mockImplementation(async (run) => run(h.prisma));
});

const bulk = (dates: unknown = ["2026-10-05", "2020-01-02"], depts = "Punching") => {
  const fd = new FormData(); fd.set("dates", JSON.stringify(dates)); fd.set("depts", depts); return fd;
};
describe("delete multiple recorded shift days", () => {
  it("uses only exact selected dates, deduplicated, in one transaction and one department scope", async () => {
    expect(await deleteRecordedShiftDays(bulk(["2026-10-05", " 2020-01-02 ", "2026-10-05"], "Punching,Punching"))).toEqual({ ok: true, attendance: 8, stops: 2, totals: 4 });
    const date = { in: [new Date("2026-10-05T00:00:00Z"), new Date("2020-01-02T00:00:00Z")] }, dept = { in: ["Punching"] };
    expect(h.prisma.shiftEntry.deleteMany).toHaveBeenCalledWith({ where: { date, dept } });
    expect(h.prisma.machineDowntime.deleteMany).toHaveBeenCalledWith({ where: { date, OR: [{ machine: { dept } }, { machineId: null, customDept: dept }] } });
    expect(h.prisma.deptDayHours.deleteMany).toHaveBeenCalledWith({ where: { date, dept } });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(h.guard).toHaveBeenCalledTimes(1);
  });
  it("rejects the entire selection if any date is invalid, future, empty or not a date string", async () => {
    for (const dates of [[], null, "2026-10-05", ["2026-10-05", "2999-01-01"], ["2026-10-05", "2026-02-30"], [""], ["2026-10-05", 42], ["2026-10-05", {}]]) expect((await deleteRecordedShiftDays(bulk(dates))).ok).toBe(false);
    const badJSON = bulk(); badJSON.set("dates", "[");
    expect((await deleteRecordedShiftDays(badJSON)).ok).toBe(false);
    expect(h.prisma.$transaction).not.toHaveBeenCalled(); expect(h.guard).not.toHaveBeenCalled();
  });
  it("refuses partial department permissions and invalid scopes before deleting any day", async () => {
    h.guard.mockImplementation(async (key) => key === "shifts.lv" ? { error: "No LV access" } : { user: {} });
    expect(await deleteRecordedShiftDays(bulk(undefined, "Cut,Punching"))).toEqual({ ok: false, error: "No LV access" });
    for (const scope of ["", "Punching,Unknown"]) expect((await deleteRecordedShiftDays(bulk(undefined, scope))).ok).toBe(false);
    expect(h.prisma.$transaction).not.toHaveBeenCalled(); expect(h.revalidate).not.toHaveBeenCalled();
  });
  it("does not claim success or revalidate on database failure", async () => {
    h.prisma.machineDowntime.deleteMany.mockRejectedValue(Error("Database failure"));
    await expect(deleteRecordedShiftDays(bulk())).rejects.toThrow("Database failure");
    expect(h.revalidate).not.toHaveBeenCalled();
  });
  it("reports concurrent changes as a failed batch", async () => {
    h.prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Conflict", { code: "P2034", clientVersion: "test" }));
    expect(await deleteRecordedShiftDays(bulk())).toMatchObject({ ok: false, error: expect.stringContaining("changed at the same time") });
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});
describe("delete a recorded shift day", () => {
  it("deletes attendance, stops and totals in one scoped transaction, including older dates", async () => {
    const result = await deleteRecordedShiftDay(form("2020-01-02"));
    expect(result).toEqual({ ok: true, attendance: 8, stops: 2, totals: 4 });
    const date = new Date("2020-01-02T00:00:00Z"), dept = { in: ["Punching", "Bending", "WeldingLV", "PaintingLV"] };
    expect(h.prisma.shiftEntry.deleteMany).toHaveBeenCalledWith({ where: { date, dept } });
    expect(h.prisma.machineDowntime.deleteMany).toHaveBeenCalledWith({ where: { date, OR: [{ machine: { dept } }, { machineId: null, customDept: dept }] } });
    expect(h.prisma.deptDayHours.deleteMany).toHaveBeenCalledWith({ where: { date, dept } });
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(h.revalidate).toHaveBeenCalledWith("/shifts");
    expect(h.revalidate).toHaveBeenCalledWith("/simulate");
  });
  it("checks every department before writing and refuses partial permission", async () => {
    h.guard.mockImplementation(async (key) => key === "shifts.lv" ? { error: "No LV access" } : { user: {} });
    expect(await deleteRecordedShiftDay(form("2026-10-05", "Cut,Punching"))).toEqual({ ok: false, error: "No LV access" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled(); expect(h.revalidate).not.toHaveBeenCalled();
  });
  it("refuses future/invalid dates and unknown or empty scopes", async () => {
    for (const [date, depts] of [["2999-01-01", "Cut"], [" 2999-01-01 ", "Cut"], ["2026-02-30", "Cut"], ["2026-10-05", ""], ["2026-10-05", "Cut,Unknown"]]) expect((await deleteRecordedShiftDay(form(date, depts))).ok).toBe(false);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("does not report success or invalidate pages when the transaction fails", async () => {
    h.prisma.machineDowntime.deleteMany.mockRejectedValue(Error("Database failure"));
    await expect(deleteRecordedShiftDay(form())).rejects.toThrow("Database failure");
    expect(h.prisma.deptDayHours.deleteMany).not.toHaveBeenCalled(); expect(h.revalidate).not.toHaveBeenCalled();
  });
  it("treats an already removed day as an idempotent empty deletion", async () => {
    for (const table of [h.prisma.shiftEntry, h.prisma.machineDowntime, h.prisma.deptDayHours]) table.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteRecordedShiftDay(form())).toEqual({ ok: true, attendance: 0, stops: 0, totals: 0 });
  });
});
