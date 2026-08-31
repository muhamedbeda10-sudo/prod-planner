import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the weekly plan tracker loader --------------------------
// The loader is pure shaping around four Prisma reads. We stub those reads and
// assert on the shape it hands the table: which promises count as work owed,
// which stay visible as N/A, and how outsourced (OSP) pieces are credited.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      plan: { findMany: fn() },
      planSchedule: { findMany: fn() },
      masterOrder: { findMany: fn() },
      handoverEntry: { groupBy: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import { utcDate } from "@/lib/domain/dates";

const D1 = utcDate(2026, 8, 10);
const D2 = utcDate(2026, 8, 12);

function order(mo: string, extra: Record<string, unknown> = {}) {
  return { mo, soi: null, urgent: false, excludedItems: null, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, ...extra };
}
function sched(mo: string, item: string, qty: number, ovenDate: Date, bom = "B-1") {
  return { bom, mo, soi: null, description: null, item, ovenDate, qty };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.plan.findMany.mockResolvedValue([{ planNo: 34 }]);
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
});

describe("getWeeklyPlanTracker — N/A (excludedItems) promises", () => {
  it("keeps a fully N/A promise visible but out of every total", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { excludedItems: "CB" })]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "CB", 10, D1)]);

    const t = await getWeeklyPlanTracker(34);
    const day = t.days[0];
    const cell = day.rows[0].items.CB!;

    // the plan's ask stays on the sheet…
    expect(day.rows).toHaveLength(1);
    expect(cell.req).toBe(10);
    expect(cell.na).toBe(10);
    // …but it is not work owed: no total, no coverage, no row requirement
    expect(day.rows[0].req).toBe(0);
    expect(day.req).toBe(0);
    expect(t.req).toBe(0);
    expect(t.covered).toBe(0);
  });

  it("counts only the non-N/A components of a mixed project row", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { excludedItems: "CB" })]);
    h.prisma.planSchedule.findMany.mockResolvedValue([
      sched("MO-1", "CF", 10, D1),
      sched("MO-1", "CB", 10, D1),
    ]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { mo: "MO-1", dept: "Welding", item: "CF", _sum: { qty: 4 } },
      // output logged against the N/A component must not resurrect it
      { mo: "MO-1", dept: "Welding", item: "CB", _sum: { qty: 3 } },
    ]);

    const t = await getWeeklyPlanTracker(34);
    const row = t.days[0].rows[0];

    expect(row.req).toBe(10); // the CF promise only
    expect(row.items.CF).toMatchObject({ req: 10, na: 0, weld: 4 });
    expect(row.items.CB).toMatchObject({ req: 10, na: 10, weld: 0 });
    expect(t.req).toBe(10);
  });

  it("does not flag the same component on an order that still needs it", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([
      order("MO-1", { excludedItems: "CB" }),
      order("MO-2"),
    ]);
    h.prisma.planSchedule.findMany.mockResolvedValue([
      sched("MO-1", "CB", 10, D1),
      sched("MO-2", "CB", 6, D1),
    ]);

    const t = await getWeeklyPlanTracker(34);
    const cell = t.days[0].rows[0].items.CB!;

    // MO-1's 10 are N/A, MO-2's 6 are real work — the cell says both
    expect(cell).toMatchObject({ req: 16, na: 10 });
    expect(t.days[0].req).toBe(6);
  });
});

describe("getWeeklyPlanTracker — outsourced (OSP) pieces", () => {
  it("credits OSP as covered and says how many pieces were OSP", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { ospCB: 5 })]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "CB", 5, D1)]);

    const t = await getWeeklyPlanTracker(34);
    const cell = t.days[0].rows[0].items.CB!;

    expect(cell).toMatchObject({ req: 5, na: 0, osp: 5, weld: 5, finish: 5, cut: 0 });
    expect(t.days[0].covered).toBe(5); // arrives without our departments working
  });

  it("waterfalls the OSP credit to the earliest promise first", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { ospCB: 5 })]);
    h.prisma.planSchedule.findMany.mockResolvedValue([
      sched("MO-1", "CB", 3, D1),
      sched("MO-1", "CB", 4, D2),
    ]);

    const t = await getWeeklyPlanTracker(34);
    const [day1, day2] = t.days;

    expect(day1.rows[0].items.CB).toMatchObject({ osp: 3, finish: 3 });
    expect(day2.rows[0].items.CB).toMatchObject({ osp: 2, finish: 2 });
  });
});

// ---- output logged against the PROJECT, with no order number ----------------
// The Daily Logs form has no MO field and older log files have no MO column, so
// a lot of genuine output carries bom + item and nothing else. Reading progress
// by MO alone made that work invisible: finished promises showed as untouched.

/** a ledger group; `mo: null` = recorded on the project, not on an order */
function log(dept: string, item: string, qty: number, opts: { mo?: string | null; bom?: string } = {}) {
  return { mo: opts.mo ?? null, bom: opts.bom ?? "B-1", dept, item, _sum: { qty } };
}

describe("getWeeklyPlanTracker — output logged without an order number", () => {
  it("counts it against the project's promise", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "TC", 6, D1)]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      log("Cut", "TC", 6),
      log("Welding", "TC", 6),
      log("Painting", "TC", 6),
    ]);

    const t = await getWeeklyPlanTracker(34);

    expect(t.days[0].rows[0].items.TC).toMatchObject({ req: 6, cut: 6, weld: 6, finish: 6 });
    expect(t.covered).toBe(6); // finished, and now it reads finished
  });

  it("fills only what the order-tagged figures left short", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "TC", 10, D1)]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      log("Welding", "TC", 4, { mo: "MO-1" }), // 4 on the order…
      log("Welding", "TC", 6), // …6 more on the project alone
    ]);

    const t = await getWeeklyPlanTracker(34);

    expect(t.days[0].rows[0].items.TC).toMatchObject({ req: 10, weld: 10 });
  });

  it("waterfalls to the earliest promise and never counts the same piece twice", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([
      sched("MO-1", "TC", 3, D1),
      sched("MO-1", "TC", 4, D2),
    ]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([log("Welding", "TC", 5)]);

    const t = await getWeeklyPlanTracker(34);

    expect(t.days[0].rows[0].items.TC).toMatchObject({ weld: 3 }); // filled first
    expect(t.days[1].rows[0].items.TC).toMatchObject({ weld: 2 }); // only the overflow
  });

  it("splits it across the projects that own it, never across other projects", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1"), order("MO-2")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([
      sched("MO-1", "TC", 5, D1, "B-1"),
      sched("MO-2", "TC", 5, D1, "B-2"),
    ]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([log("Welding", "TC", 5, { bom: "B-1" })]);

    const t = await getWeeklyPlanTracker(34);
    const rows = Object.fromEntries(t.days[0].rows.map((r) => [r.bom, r]));

    expect(rows["B-1"].items.TC).toMatchObject({ weld: 5 });
    expect(rows["B-2"].items.TC).toMatchObject({ weld: 0 });
  });

  it("reads the core's finish as shot blast, not painting", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1")]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "CF", 4, D1)]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      log("ShotBlast", "CF", 4), // the core's real final stage
      log("Painting", "CF", 4), // the core is never painted — must not count
    ]);

    const t = await getWeeklyPlanTracker(34);

    expect(t.days[0].rows[0].items.CF).toMatchObject({ finish: 4 });
    expect(t.covered).toBe(4);
  });

  it("cannot resurrect a promise the order marked N/A", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([order("MO-1", { excludedItems: "CB" })]);
    h.prisma.planSchedule.findMany.mockResolvedValue([sched("MO-1", "CB", 10, D1)]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([log("Welding", "CB", 10)]);

    const t = await getWeeklyPlanTracker(34);

    expect(t.days[0].rows[0].items.CB).toMatchObject({ req: 10, na: 10, weld: 0 });
    expect(t.req).toBe(0);
  });
});
