import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ orders: vi.fn(), totals: vi.fn(), odoo: vi.fn(), ledgers: vi.fn(), settings: vi.fn(), children: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { handoverEntry: { groupBy: h.totals, findMany: h.ledgers }, odooEntry: { findMany: h.odoo }, odooChildMo: { findMany: h.children } } }));
vi.mock("@/lib/server/loads", () => ({ loadMasterOrders: h.orders, loadSettingsRow: h.settings }));
import { getMasterTracker, getTrackerSheet } from "@/lib/server/masterTracker";
const order = (mo: string, months: string) => ({ mo, bom: "BOM-A", soi: "SO-1", line: "TR", planQty: 3, kva: "1000", rating: "", excludedItems: "", months, status: "open", pendingPlanQty: null });
beforeEach(() => {
  vi.resetAllMocks(); h.settings.mockResolvedValue({ odooTrackingFrom: "2026-09-06" }); h.totals.mockResolvedValue([]); h.children.mockResolvedValue([]);
  h.ledgers.mockResolvedValue([{ id: 9, mo: "PLAN-MO", bom: "BOM-A", item: "TN" }]);
});
it("allocates Odoo quantities to the original plan requirement of an order planned before October 2026", async () => {
  h.orders.mockResolvedValue([order("PLAN-MO", "September 2026")]);
  h.odoo.mockResolvedValue([{ id: 1, date: new Date("2026-09-06T00:00:00Z"), line: "TR", ledgerId: 9, soi: "SO-1", fgCode: "FB-022-BOM-A", product: "Tank", qty: 7, status: "Done", odooMo: "" }]);
  const rows = await getMasterTracker();
  expect(rows[0].items.TN.odooClosed).toBe(3); expect(rows[0].items.TN.delivered).toBe(0); expect(rows[0].complete).toBe(0);
  expect(rows[0].odooPlanMonth).toBe("September 2026"); expect(rows[0].odooUnallocated?.[0].qty).toBe(4); expect(rows[0].odooExact).toBe(false);
  expect(h.odoo).toHaveBeenCalledWith(expect.objectContaining({ where: { line: "TR" } }));
});
it("counts an October 2026 order exactly, the same on the screen and for the auto-close", async () => {
  h.orders.mockResolvedValue([order("PLAN-MO", "October 2026"), order("OLD-MO", "August 2026")]);
  h.odoo.mockResolvedValue([{ id: 1, date: new Date("2026-10-06T00:00:00Z"), line: "TR", ledgerId: 9, soi: "SO-1", fgCode: "FB-022-BOM-A", product: "Tank", qty: 7, status: "Done", odooMo: "" }]);
  const all = await getMasterTracker();
  expect(all[0].items.TN.odooClosed).toBe(7); expect(all[0].odooExact).toBe(true); expect(all[0].odooUnallocated).toEqual([]);
  const sheet = await getTrackerSheet();
  expect(sheet[0].items.TN).toMatchObject({ odooClosed: 7, odooTracked: true });
  // the older order is not counted on the screen, and the log is not read whole for it
  expect(sheet[1].odooExact).toBe(false); expect(sheet[1].items.TN.odooTracked).toBe(false);
  expect(h.ledgers).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ mo: { in: ["PLAN-MO"] } }) }));
  expect(h.odoo).toHaveBeenLastCalledWith(expect.objectContaining({ where: { line: "TR", OR: [{ ledgerId: { in: [9] } }] } }));
  expect(h.settings).toHaveBeenCalledTimes(1); // the screen does not read the tracking start
});
