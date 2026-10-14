import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The monthly plan import is "add and update only": new MOs are added, MOs
// in the sheet get its changes, and the month's MOs the sheet does not list
// are never touched — unless taking them out is chosen on purpose. Against a
// stubbed database.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
      masterOrder: { findMany: fn(), createMany: fn(), update: fn(), updateMany: fn(), deleteMany: fn(), count: fn() },
      handoverEntry: { groupBy: fn() },
      tankUnit: { groupBy: fn() },
      worklistDateOverride: { deleteMany: fn() },
      worklistLineHide: { deleteMany: fn() },
      worklistPush: { deleteMany: fn() },
      worklistMachine: { deleteMany: fn() },
      runOrderEntry: { deleteMany: fn() },
      queueNote: { deleteMany: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

import { importMonthlyPlan } from "@/lib/server/importMonthly";

const MONTH = "October 2026";

function sheet(mos: string[]): ArrayBuffer {
  const rows: unknown[][] = [
    ["LV Production Plan 10-2026"],
    ["MO.", "BoM Ref.", "Customer", "Planned Qty", "Product"],
    ...mos.map((mo) => [mo, "R2.3_IH", "SEC", 10, "FP 5W GI"]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "10-2026");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

/** An open LV order already in the registry for the month. */
const existing = (mo: string, family = "") => ({
  mo, line: "LV", family, status: "open", months: MONTH, source: MONTH, priority: false,
  soi: null, urgent: false, customer: "SEC", fgCode: null, bom: "R2.3_IH", kva: null, rating: null, secItem: null,
  planQty: 10, remarks: null, product: "FP 5W GI", ospEncloser: 0, materialsRemarks: null,
  ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, pendingPlanQty: null,
});

const oldMos = Array.from({ length: 18 }, (_, i) => `SF01/MO/OLD-${i + 1}`);
const newMos = Array.from({ length: 12 }, (_, i) => `SF01/MO/NEW-${i + 1}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.masterOrder.findMany.mockResolvedValue(oldMos.map((mo) => existing(mo)));
  h.prisma.masterOrder.count.mockResolvedValue(30);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: oldMos[0], _count: { _all: 2 } }]);
  h.prisma.tankUnit.groupBy.mockResolvedValue([]);
});

const nothingTakenOut = () => {
  expect(h.prisma.masterOrder.deleteMany).not.toHaveBeenCalled();
  expect(h.prisma.masterOrder.updateMany).not.toHaveBeenCalled();
  expect(h.prisma.masterOrder.update).not.toHaveBeenCalled();
  expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
  for (const t of ["worklistDateOverride", "worklistLineHide", "worklistPush", "worklistMachine", "runOrderEntry", "queueNote"] as const) {
    expect(h.prisma[t].deleteMany).not.toHaveBeenCalled();
  }
};

describe("the monthly plan import — add and update only", () => {
  it("adds the 12 new MOs and leaves the 18 the sheet does not list exactly as they are", async () => {
    const r = await importMonthlyPlan(sheet(newMos), MONTH, false, "LV", "");

    expect(r).toMatchObject({ ok: true, added: 12, existing: 0, updatedMos: 0, keepMissing: true, notInSheet: 18, removed: [], qtyProposals: [] });
    expect(h.prisma.masterOrder.createMany).toHaveBeenCalledTimes(1);
    const data = h.prisma.masterOrder.createMany.mock.calls[0][0].data as { mo: string; line: string; family: string; months: string; source: string }[];
    expect(data.map((d) => d.mo)).toEqual(newMos);
    expect(data.every((d) => d.line === "LV" && d.family === "" && d.months === MONTH && d.source === MONTH)).toBe(true);
    nothingTakenOut();
  });

  it("says the same in its dry run, and writes nothing", async () => {
    const r = await importMonthlyPlan(sheet(newMos), MONTH, true, "LV", "");
    expect(r).toMatchObject({ ok: true, preview: true, added: 12, keepMissing: true, notInSheet: 18, removed: [] });
    expect(h.prisma.masterOrder.createMany).not.toHaveBeenCalled();
    nothingTakenOut();
  });

  it("still updates an MO the sheet lists, and holds a changed quantity", async () => {
    const changed = { ...existing(oldMos[0]), customer: "Old customer", planQty: 5 };
    h.prisma.masterOrder.findMany.mockResolvedValue([changed, ...oldMos.slice(1).map((mo) => existing(mo))]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: oldMos[0], dept: "Cut", item: "CF", _sum: { qty: 3 } }]);
    const r = await importMonthlyPlan(sheet([oldMos[0]]), MONTH, false, "LV", "");

    expect(r).toMatchObject({ ok: true, added: 0, existing: 1, updatedMos: 1, notInSheet: 17, removed: [] });
    expect(r.qtyProposals).toEqual([expect.objectContaining({ mo: oldMos[0], from: 5, to: 10, produced: 3 })]);
    const updates = h.prisma.masterOrder.update.mock.calls.map((c) => c[0] as { where: { mo: string }; data: Record<string, unknown> });
    expect(updates.every((u) => u.where.mo === oldMos[0])).toBe(true);
    expect(updates.some((u) => u.data.customer === "SEC")).toBe(true);
    expect(updates.some((u) => u.data.pendingPlanQty === 10)).toBe(true);
    expect(updates.some((u) => "planQty" in u.data)).toBe(false);
    expect(h.prisma.masterOrder.deleteMany).not.toHaveBeenCalled();
    expect(h.prisma.masterOrder.updateMany).not.toHaveBeenCalled();
  });

  it("takes the missing MOs out only when that is chosen on purpose — and only the sheet's own plan's", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([...oldMos.map((mo) => existing(mo)), existing("SF01/MO/MB-1", "MB")]);
    const r = await importMonthlyPlan(sheet(newMos), MONTH, false, "LV", "", { keepMissing: false });

    expect(r.keepMissing).toBe(false);
    expect(r.notInSheet).toBe(18);
    expect(r.removed).toHaveLength(18);
    expect(r.removed).toContainEqual({ mo: oldMos[0], action: "closed" });
    expect(r.removed?.map((x) => x.mo)).not.toContain("SF01/MO/MB-1");
    expect(h.prisma.masterOrder.updateMany).toHaveBeenCalledWith({ where: { mo: { in: [oldMos[0]] } }, data: { status: "closed", closedAt: expect.any(Date) } });
    expect(h.prisma.masterOrder.deleteMany).toHaveBeenCalledWith({ where: { mo: { in: oldMos.slice(1) } } });
  });
});
