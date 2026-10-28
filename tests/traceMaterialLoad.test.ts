import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  usage: vi.fn(), odoo: vi.fn(), orders: vi.fn(), handover: vi.fn(), group: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/line", () => ({ getActiveLine: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    materialUsage: { findMany: h.usage },
    odooEntry: { findMany: h.odoo },
    masterOrder: { findMany: h.orders },
    handoverEntry: { findMany: h.handover, groupBy: h.group },
  },
}));
import { getTraceMaterial } from "@/lib/server/material";

const row = (over: Record<string, unknown>) => ({
  id: 1, month: "", bom: "B-1", mo: "SF01/MO/9", units: 10, partCode: "FB-022", partName: "TANK", materialCode: "T", material: "Steel",
  thicknessMm: 5, sheetSize: "1220*2440", sheetsPerUnit: 1, actualPerUnit: 1, actualPerUnitManual: false, sheetsUsed: 10, producedQty: null,
  soi: "S1", mtr: "", weightKg: null, utilization: null, note: null, recordedBy: null, updatedAt: new Date("2026-10-01"), ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  // the order's daily-log closing, and the ODOO row born of it with the part's MO
  h.handover.mockImplementation(async (a: { where: { id?: unknown } }) =>
    a.where.id ? [{ id: 77, mo: "PF01/MO/1", item: "TN" }] : [{ id: 77 }]);
  h.odoo.mockImplementation(async (a: { select: Record<string, boolean> }) =>
    a.select.status
      ? [{ odooMo: "SF01/MO/9", status: "Done", qty: 4, date: new Date("2026-10-20"), ledgerId: 77 }]
      : [{ odooMo: "SF01/MO/9" }]);
  h.usage.mockResolvedValue([row({})]);
  h.orders.mockImplementation(async (a: { where: { soi?: unknown } }) =>
    a.where.soi ? [{ mo: "PF01/MO/1", soi: "S1", bom: "B-1" }] : [{ mo: "PF01/MO/1", soi: "S1", bom: "B-1", months: "October 2026", source: null, planQty: 10 }]);
});

it("reads only the log and registry rows that touch the order's lines, never the whole line", async () => {
  const m = await getTraceMaterial("TR", { scope: "mo", mos: ["PF01/MO/1"], sois: ["S1"], bom: "B-1" });
  expect(m.lines.map((l) => [l.mo, l.orderMos, l.planMonths, l.producedUsed])).toEqual([["SF01/MO/9", ["PF01/MO/1"], ["October 2026"], 4]]);
  // the line's ODOO rows by its part MO, not every row of the line
  const odooForLines = h.odoo.mock.calls.map((c) => c[0]).find((a) => a.select.status);
  expect(odooForLines.where).toEqual({
    line: "TR", odooMo: { not: "" },
    OR: [{ odooMo: { in: ["SF01/MO/9"], mode: "insensitive" } }, { ledgerId: { in: [77] } }],
  });
  // the registry by the lines' keys, not every order of the line
  const registry = h.orders.mock.calls.map((c) => c[0]).find((a) => a.select.months);
  expect(registry.where.OR).toEqual([
    { mo: { in: ["SF01/MO/9", "PF01/MO/1"], mode: "insensitive" } },
    { soi: { in: ["S1"], mode: "insensitive" } },
    { bom: { in: ["B-1"], mode: "insensitive" } },
  ]);
  // the transformers count no painted panels
  expect(h.group).not.toHaveBeenCalled();
});
