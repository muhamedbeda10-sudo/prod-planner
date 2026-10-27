import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { ITEMS } from "@/lib/domain/constants";
import { masterTrackerRows } from "@/lib/server/sheets";
import { filterMasterTracker } from "@/lib/domain/trackerSummary";

const { filters } = vi.hoisted(() => ({
  filters: {} as Record<string, string>,
}));

vi.mock("server-only", () => ({}));
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
  return renderToStaticMarkup(createElement(MasterTrackerTable, { rows }));
}
/** The cell in the sheet the assistant makes of the tracker, under the screen's month. */
function sheetOdoo(mo: string) {
  const month = filters["tracker.month"] ?? "";
  return masterTrackerRows(filterMasterTracker(rows, { month }), [], month).find((r) => r.MO === mo)?.["TN Odoo closed"];
}

beforeEach(() => {
  for (const key of Object.keys(filters)) delete filters[key];
});

describe("Odoo closings off the Plan Tracker screen, still in the assistant's sheet", () => {
  it("the screen has no Odoo column — its allocation was the sheet's heaviest work", () => {
    const html = render();
    expect(html).not.toContain("Odoo closed");
    expect(html).not.toMatch(/>Odoo</);
  });

  it("the assistant's sheet reads an MO older than the tracking start as unknown, not zero", () => {
    expect(sheetOdoo("OLD")).toBe("Not tracked");
    expect(sheetOdoo("NEW")).toBe(3);
  });

  it("stays unknown under a later month the MO was carried into", () => {
    filters["tracker.month"] = "October 2026";
    expect(sheetOdoo("OLD")).toBe("Not tracked");
    expect(sheetOdoo("NEW")).toBe(3);
  });
});
