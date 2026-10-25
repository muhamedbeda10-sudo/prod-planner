import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- how the daily screens read the ledger ------------------------------------
// The ledger (HandoverEntry) is the largest table a request touches, and two
// loaders used to read far more of it than they looked at: the per-line daily
// log pulled every column of every row, and the weekly tracker summed EVERY
// group on the ledger to read only the active plan's orders and projects.
// These tests pin the shape of both reads.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      plan: { findMany: fn() },
      planSchedule: { findMany: fn() },
      masterOrder: { findMany: fn() },
      handoverEntry: { findMany: fn(), groupBy: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
// outside a request there is no cookie jar — the real helper falls back to
// transformers, but `next/headers` cannot be imported under vitest at all
vi.mock("next/headers", () => ({ cookies: async () => { throw new Error("outside a request"); } }));

import { loadAllHandover, loadAllHandoverOf } from "@/lib/server/loads";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import { utcDate } from "@/lib/domain/dates";

const D1 = utcDate(2026, 8, 10);
const QUEUE_FIELDS = { planNo: true, dept: true, bom: true, mo: true, item: true, qty: true, date: true };

function order(mo: string, extra: Record<string, unknown> = {}) {
  return { mo, soi: null, urgent: false, excludedItems: null, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, ...extra };
}
function sched(mo: string, item: string, qty: number, ovenDate: Date, bom = "B-1") {
  return { bom, mo, soi: null, description: null, item, ovenDate, qty };
}
function log(dept: string, item: string, qty: number, opts: { mo?: string | null; bom?: string } = {}) {
  return { mo: opts.mo ?? null, bom: opts.bom ?? "B-1", dept, item, _sum: { qty } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.plan.findMany.mockResolvedValue([{ planNo: 34 }]);
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.planSchedule.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
});

describe("loadAllHandoverOf — the per-line daily log", () => {
  it("selects only the fields the queue maths read, and keeps the line filter", async () => {
    await loadAllHandoverOf("LV");
    expect(h.prisma.handoverEntry.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.handoverEntry.findMany.mock.calls[0][0]).toEqual({ where: { item: "PNL" }, select: QUEUE_FIELDS });
  });

  it("reads transformers as every row that is not a panel", async () => {
    await loadAllHandoverOf("TR");
    expect(h.prisma.handoverEntry.findMany.mock.calls[0][0]).toEqual({ where: { item: { not: "PNL" } }, select: QUEUE_FIELDS });
  });

  it("hands the rows through untouched for the line on screen", async () => {
    const row = { planNo: 34, dept: "Cut", bom: "B-1", mo: "MO-1", item: "TC", qty: 3, date: D1 };
    h.prisma.handoverEntry.findMany.mockResolvedValue([row]);
    expect(await loadAllHandover()).toEqual([row]);
    expect(h.prisma.handoverEntry.findMany.mock.calls[0][0].select).toEqual(QUEUE_FIELDS);
  });
});

describe("getWeeklyPlanTracker — what it asks the ledger for", () => {
  it("sums only the plan's orders, plus order-less rows of the plan's projects", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1"), order("MO-2")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([
      sched("MO-1", "TC", 6, D1, "B-1"),
      sched("MO-1", "CB", 2, D1, "B-1"),
      sched("MO-2", "TC", 4, D1, "B-2"),
    ]);

    await getWeeklyPlanTracker(34);

    expect(h.prisma.handoverEntry.groupBy).toHaveBeenCalledTimes(1);
    const args = h.prisma.handoverEntry.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(["mo", "bom", "dept", "item"]);
    expect(args._sum).toEqual({ qty: true });
    // the loader only ever looks up "mo|dept|item" for the plan's MOs and
    // "bom|item" (for rows with no MO) for the plan's BOMs — nothing else
    expect(args.where).toEqual({
      OR: [
        { mo: { in: ["MO-1", "MO-2"] } },
        { OR: [{ mo: null }, { mo: "" }], bom: { in: ["B-1", "B-2"] } },
      ],
    });
  });

  it("asks for the plan's keys only after the plan's schedules are known", async () => {
    const seen: string[] = [];
    h.prisma.planSchedule.findMany.mockImplementation(async () => {
      seen.push("schedules");
      return [sched("MO-1", "TC", 6, D1)];
    });
    h.prisma.handoverEntry.groupBy.mockImplementation(async () => {
      seen.push("groupBy");
      return [];
    });

    await getWeeklyPlanTracker(34);

    expect(seen).toEqual(["schedules", "groupBy"]);
    expect(h.prisma.handoverEntry.groupBy.mock.calls[0][0].where.OR[0]).toEqual({ mo: { in: ["MO-1"] } });
  });

  it("still reads order-tagged and project-level output exactly as before", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "TC", 10, D1)]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      log("Welding", "TC", 4, { mo: "MO-1" }), // 4 on the order…
      log("Welding", "TC", 10), // …and 10 on the project: only the 6 missing are taken
      log("Cut", "TC", 10, { mo: "MO-1" }),
    ]);

    const t = await getWeeklyPlanTracker(34);

    expect(t.days[0].rows[0].items.TC).toMatchObject({ req: 10, cut: 10, weld: 10, finish: 0 });
  });

  it("does not hit the ledger when there are no weekly plans", async () => {
    h.prisma.plan.findMany.mockResolvedValue([]);
    const t = await getWeeklyPlanTracker();
    expect(t.planNo).toBeNull();
    expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
  });
});
