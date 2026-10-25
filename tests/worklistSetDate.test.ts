import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- setWorklistDate: the pool math behind scheduling a date-less part -------
// The AI tool's preflight (set_worklist_date) treats the part already on the
// chosen day as room, because the action REPLACES that day's quantity. This
// runs the action's own arithmetic against the same scenario, so the two can
// never disagree again.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findUnique: fn() },
      handoverEntry: { aggregate: fn() },
      worklistDateOverride: { findMany: fn(), upsert: fn(), deleteMany: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    requireAdmin: vi.fn(),
    requireDeptEdit: vi.fn(),
    requirePerm: vi.fn(),
    getPlanWindows: vi.fn(),
    getSettings: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: vi.fn(), recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/data", () => ({ getPlanWindows: h.getPlanWindows, getSettings: h.getSettings }));
vi.mock("@/lib/server/auth", () => ({
  requireDeptEdit: h.requireDeptEdit,
  requireAdmin: h.requireAdmin,
  requirePerm: h.requirePerm,
}));
vi.mock("@/lib/server/tanks", () => ({ mintTankSerials: vi.fn(), unmintTankSerials: vi.fn() }));
vi.mock("@/lib/server/workers", () => ({ resolveWorker: vi.fn() }));

import { setWorklistDate } from "@/app/worklist/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const LINE = { bom: "B2", mo: "M2", item: "TC", origISO: "" };
const DAY = "2026-11-02";
const ORDER = { mo: "M2", bom: "B2", line: "TR", planQty: 10, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0 };
/** A date-less part already scheduled on `day`. */
const part = (day: string, qty: number, baseDone = 0, id = 1) => ({ id, ...LINE, newDate: new Date(`${day}T00:00:00.000Z`), qty, baseDone });

const schedule = (qty: number, day = DAY) => setWorklistDate(form({ ...LINE, date: day, qty: String(qty) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ user: { name: "admin" } });
  h.prisma.masterOrder.findUnique.mockResolvedValue(ORDER);
  h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  h.prisma.worklistDateOverride.findMany.mockResolvedValue([]);
  h.prisma.worklistDateOverride.upsert.mockResolvedValue({});
});

describe("setWorklistDate — scheduling a part of the date-less pool", () => {
  it("re-scheduling the day already holding a part replaces it — its own pieces count as room", async () => {
    h.prisma.worklistDateOverride.findMany.mockResolvedValue([part(DAY, 6)]);
    expect(await schedule(8)).toEqual({ ok: true });
    expect(h.prisma.worklistDateOverride.upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ update: { qty: 8, createdBy: "admin" } })
    );
    // ...but never past what the order still needs
    h.prisma.worklistDateOverride.upsert.mockClear();
    expect(await schedule(11)).toEqual({ ok: false, error: "Only 10 pcs are still unscheduled on this line (10 open − 0 already scheduled)." });
    expect(h.prisma.worklistDateOverride.upsert).not.toHaveBeenCalled();
  });

  it("the parts on OTHER days still claim their pieces", async () => {
    h.prisma.worklistDateOverride.findMany.mockResolvedValue([part(DAY, 6, 0, 1), part("2026-11-05", 3, 0, 2)]);
    expect(await schedule(8)).toEqual({ ok: false, error: "Only 7 pcs are still unscheduled on this line (10 open − 3 already scheduled)." });
    expect(await schedule(7)).toEqual({ ok: true });
  });

  it("pieces already cut consume the earliest other part first, as the worklist shows", async () => {
    // 2 cut since the parts were scheduled: the 11-05 part's claim shrinks to 1,
    // the order's open pool to 8, so 7 fit on the chosen day
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 2 } });
    h.prisma.worklistDateOverride.findMany.mockResolvedValue([part("2026-11-05", 3, 0, 2), part(DAY, 6, 0, 1)]);
    expect(await schedule(8)).toEqual({ ok: false, error: "Only 7 pcs are still unscheduled on this line (8 open − 1 already scheduled)." });
    expect(await schedule(7)).toEqual({ ok: true });
  });

  it("a fresh day on a line with no parts takes up to the open pool", async () => {
    expect(await schedule(10)).toEqual({ ok: true });
    expect(h.prisma.worklistDateOverride.upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ create: expect.objectContaining({ ...LINE, qty: 10, baseDone: 0, createdBy: "admin" }) })
    );
    expect(await schedule(11)).toEqual({ ok: false, error: "Only 10 pcs are still unscheduled on this line (10 open − 0 already scheduled)." });
  });
});
