import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ orders: vi.fn(), sums: vi.fn(), ledgers: vi.fn(), odoo: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { handoverEntry: { groupBy: h.sums, findMany: h.ledgers }, odooEntry: { findMany: h.odoo } } }));
vi.mock("@/lib/server/loads", () => ({ loadMasterOrdersOf: h.orders }));
import { getLvTracker, getLvTrackerWithOdoo } from "@/lib/server/lvTracker";

const order = (mo: string, months: string) => ({
  mo, bom: `PNL-${mo}`, soi: null, urgent: false, customer: null, product: "USS", family: "", fgCode: null, secItem: null, ospEncloser: 0,
  remarks: null, materialsRemarks: null, planQty: 10, status: "open", priority: false, months, source: months,
  holdAt: null, holdNote: null, holdBy: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.sums.mockResolvedValue([]);
  h.ledgers.mockResolvedValue([{ id: 5, mo: "SF01/MO/1", bom: "PNL-SF01/MO/1", item: "PNL" }]);
  h.odoo.mockResolvedValue([{ id: 1, ledgerId: 5, status: "Done", qty: 6 }, { id: 2, ledgerId: 5, status: "Cancelled", qty: 4 }]);
});

it("counts a panel order's Odoo closings from October 2026 on, born from its own painting; older orders are not counted", async () => {
  h.orders.mockResolvedValue([order("SF01/MO/1", "October 2026"), order("SF01/MO/2", "September 2026")]);
  const rows = await getLvTrackerWithOdoo();
  expect(rows[0].odooClosed).toBe(6);
  expect(rows[1].odooClosed).toBeNull();
  expect(h.ledgers).toHaveBeenCalledWith(expect.objectContaining({ where: { mo: { in: ["SF01/MO/1"] }, dept: { in: ["Painting", "ShotBlast"] } } }));
  expect(h.odoo).toHaveBeenCalledWith(expect.objectContaining({ where: { line: "LV", ledgerId: { in: [5] } } }));
});

it("leaves the Odoo log alone for the screens that never show it (the Floor, the KPIs, the dashboards)", async () => {
  h.orders.mockResolvedValue([order("SF01/MO/1", "October 2026")]);
  const rows = await getLvTracker();
  expect(rows[0].odooClosed).toBeUndefined();
  expect(h.odoo).not.toHaveBeenCalled();
});

it("takes the enclosures bought in (OSP Encloser) off what the panels' stages owe", async () => {
  h.orders.mockResolvedValue([
    { ...order("SF01/MO/1", "October 2026"), planQty: 8, ospEncloser: 7 },
    { ...order("SF01/MO/2", "October 2026"), planQty: 8320, ospEncloser: 8320 },
  ]);
  h.sums.mockResolvedValue([{ mo: "SF01/MO/1", dept: "Painting", _sum: { qty: 1 } }]);
  const [one, bought] = await getLvTracker();
  expect([one.state.required, one.complete, one.remaining, one.achievement]).toEqual([1, 1, 0, 1]);
  // wholly bought in: nothing left for our stages
  expect([bought.state.required, bought.remaining, bought.achievement]).toEqual([0, 0, 1]);
});
