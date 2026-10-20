import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the sheet jobs' cut history, read for the board -----------------------
// getJobCuts is shaping around one Prisma read: we stub it and check which
// jobs it asks about, how it asks, and how the rows come back by job.

const h = vi.hoisted(() => ({ prisma: { sheetCutLog: { findMany: vi.fn() } } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

import { getJobCuts } from "@/lib/server/manualJobs";
import type { ManualJobView } from "@/lib/domain/manualJob";

function job(id: number, extra: Partial<ManualJobView> = {}): ManualJobView {
  return {
    id, dept: "Cut", title: "", bom: "", item: "", qty: 10, doneQty: 2, bySheet: true, parts: [], material: "MS", thicknessMm: 5, sheetSize: "1220*2440",
    sheets: null, note: null, onMachines: [], lastMachine: null, createdBy: null, createdAtISO: "2026-10-19T08:00:00.000Z", doneAtISO: null, ...extra,
  };
}
const row = (id: number, mo: string, qty: number, machine: string | null, at: string) =>
  ({ id, mo, qty, createdBy: "Sara", at: new Date(at), machine: machine === null ? null : { code: machine } });

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.sheetCutLog.findMany.mockResolvedValue([]);
});

describe("getJobCuts", () => {
  it("asks nothing when no open sheet job has sheets cut", async () => {
    const jobs = [job(1, { doneQty: 0 }), job(2, { doneAtISO: "2026-10-19T10:00:00.000Z" }), job(3, { bySheet: false })];
    expect(await getJobCuts("Cut", jobs)).toEqual({});
    expect(h.prisma.sheetCutLog.findMany).not.toHaveBeenCalled();
  });

  it("reads the log of the open sheet jobs with sheets cut only, newest first", async () => {
    await getJobCuts("Cut", [job(7), job(8, { doneQty: 0 }), job(9)]);
    expect(h.prisma.sheetCutLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { dept: "Cut", bom: "MANUAL", item: "JOB", mo: { in: ["MANUAL-7", "MANUAL-9"] } },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    }));
  });

  it("hands the rows back by job, in the order read, a gone machine as null", async () => {
    h.prisma.sheetCutLog.findMany.mockResolvedValue([
      row(31, "MANUAL-7", 2.5, "B4-10", "2026-10-20T08:00:00.000Z"),
      row(30, "MANUAL-9", 1, null, "2026-10-20T07:00:00.000Z"),
      row(29, "MANUAL-7", 12, "B4-09", "2026-10-19T09:00:00.000Z"),
      row(28, "S01276-2", 4, "B4-09", "2026-10-19T08:00:00.000Z"),
    ]);
    expect(await getJobCuts("Cut", [job(7), job(9)])).toEqual({
      7: [
        { id: 31, atISO: "2026-10-20T08:00:00.000Z", machine: "B4-10", qty: 2.5, by: "Sara" },
        { id: 29, atISO: "2026-10-19T09:00:00.000Z", machine: "B4-09", qty: 12, by: "Sara" },
      ],
      9: [{ id: 30, atISO: "2026-10-20T07:00:00.000Z", machine: null, qty: 1, by: "Sara" }],
    });
  });
});
