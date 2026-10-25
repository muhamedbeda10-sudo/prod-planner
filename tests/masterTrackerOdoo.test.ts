import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ orders: vi.fn(), totals: vi.fn(), odoo: vi.fn(), ledgers: vi.fn(), settings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { handoverEntry: { groupBy: h.totals, findMany: h.ledgers }, odooEntry: { findMany: h.odoo } } }));
vi.mock("@/lib/server/loads", () => ({ loadMasterOrders: h.orders, loadSettingsRow: h.settings }));
import { getMasterTracker } from "@/lib/server/masterTracker";
beforeEach(() => {
  vi.resetAllMocks(); h.settings.mockResolvedValue({ odooTrackingFrom: "2026-09-06" }); h.orders.mockResolvedValue([{ mo: "PLAN-MO", bom: "BOM-A", soi: "SO-1", line: "TR", planQty: 3, kva: "1000", rating: "", excludedItems: "", months: "October 2026", status: "open", pendingPlanQty: null }]); h.totals.mockResolvedValue([]);
  h.odoo.mockResolvedValue([{ id: 1, date: new Date("2026-09-06T00:00:00Z"), line: "TR", ledgerId: 9, soi: "SO-1", fgCode: "FB-022-BOM-A", product: "Tank", qty: 7, status: "Done" }]); h.ledgers.mockResolvedValue([{ id: 9, mo: "PLAN-MO", bom: "BOM-A", item: "TN" }]);
});
it("allocates Odoo quantities to the original plan requirement, keeping excess and stage production separate", async () => {
  const rows = await getMasterTracker();
  expect(rows[0].items.TN.odooClosed).toBe(3); expect(rows[0].items.TN.delivered).toBe(0); expect(rows[0].complete).toBe(0);
  expect(rows[0].odooPlanMonth).toBe("October 2026"); expect(rows[0].odooUnallocated?.[0].qty).toBe(4);
  expect(h.odoo).toHaveBeenCalledWith(expect.objectContaining({ where: { line: "TR" } }));
  expect(h.ledgers).toHaveBeenCalledTimes(1);
});
