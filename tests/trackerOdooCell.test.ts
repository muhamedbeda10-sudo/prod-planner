import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { ITEMS } from "@/lib/domain/constants";

const { filters, exported } = vi.hoisted(() => ({
  filters: {} as Record<string, string>,
  exported: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/tracker" }));
vi.mock("@/app/orders/actions", () => ({
  closeDeliveredOrders: vi.fn(), setOrderHold: vi.fn(), setOrderStatus: vi.fn(),
  decidePlanQty: vi.fn(), setExcludedItems: vi.fn(), setOrderQty: vi.fn(), setOrderSpec: vi.fn(),
  setGroupOrderSpec: vi.fn(), setGroupFins: vi.fn(), setOrderPriority: vi.fn(),
  pushOrderToWorklist: vi.fn(), removeOrderMonth: vi.fn(),
}));
vi.mock("@/app/worklist/actions", () => ({ recordTrackerTotal: vi.fn(), recordGroupOutput: vi.fn() }));
vi.mock("@/app/prefs/actions", () => ({ saveUserPref: vi.fn() }));
vi.mock("@/components/FilterControls", async (original) => ({
  ...await original<typeof import("@/components/FilterControls")>(),
  useSavedFilter: (key: string) => [filters[key] ?? "", vi.fn()],
}));
vi.mock("@/components/ProgressRing", () => ({ RING_GRID: "", RingCard: () => null }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: exported }));

const row = (mo: string, extra: Partial<MasterTrackerRow>, tank: Partial<MasterTrackerRow["items"]["TN"]>): MasterTrackerRow => ({
  mo, bom: `BOM-${mo}`, soi: null, customer: null, urgent: false, kva: "1000", rating: null,
  fins: null, crcSize: null, colorRal: null, sfm: null, required: 10, welded: 0, complete: 0, remaining: 10,
  achievement: 0, status: "open", hold: { onHold: false, holdNote: null, holdSinceISO: null, holdBy: null },
  priority: false, months: ["October 2026"], pendingQty: null,
  items: Object.fromEntries(ITEMS.map((it) => [it, {
    cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true,
    ...(it === "TN" ? tank : {}),
  }])) as MasterTrackerRow["items"],
  ...extra,
});

// OLD was planned before the Odoo tracking start and carried into October:
// its own closing is unknown. NEW is an October plan with a tracked closing.
const rows = [
  row("OLD", { months: ["July 2026", "October 2026"], odooPlanMonth: "July 2026" }, { odooTracked: false, odooClosed: 0 }),
  row("NEW", { odooPlanMonth: "October 2026" }, { odooTracked: true, odooClosed: 3 }),
];

function render() {
  return renderToStaticMarkup(createElement(MasterTrackerTable, { rows, odooTrackingFrom: "2026-09-01" }));
}
function odooCell(html: string, mo: string) {
  const m = new RegExp(`<td[^>]*aria-label="${mo} TN Odoo closed"[^>]*>(.*?)</td>`).exec(html);
  if (!m) throw new Error(`no TN Odoo cell for ${mo}`);
  return m[1].replace(/<[^>]+>/g, "");
}
function exportedOdoo(mo: string) {
  const list = exported.mock.calls[0][0].excel[0].rows as Record<string, string | number>[];
  return list.find((r) => r.MO === mo)?.["TN Odoo closed"];
}

beforeEach(() => {
  for (const key of Object.keys(filters)) delete filters[key];
  exported.mockReset().mockReturnValue(null);
});

describe("tracker Odoo cell for an MO older than the tracking start", () => {
  it("reads unknown, not zero, in the all-months view", () => {
    const html = render();
    expect(odooCell(html, "OLD")).toBe("—");
    expect(odooCell(html, "NEW")).toBe("3");
    expect(exportedOdoo("OLD")).toBe("Not tracked");
  });

  it("stays unknown under a later month it was carried into, matching the export", () => {
    filters["tracker.month"] = "October 2026";
    const html = render();
    expect(html).toContain('aria-label="OLD TN Odoo closed"');
    expect(odooCell(html, "OLD")).toBe("—");
    expect(odooCell(html, "NEW")).toBe("3");
    expect(exportedOdoo("OLD")).toBe("Not tracked");
    expect(exportedOdoo("NEW")).toBe(3);
  });

  it("still shows a tracked zero as 0", () => {
    const tracked = [row("ZERO", { odooPlanMonth: "October 2026" }, { odooTracked: true, odooClosed: 0 })];
    const html = renderToStaticMarkup(createElement(MasterTrackerTable, { rows: tracked }));
    expect(odooCell(html, "ZERO")).toBe("0");
  });
});
