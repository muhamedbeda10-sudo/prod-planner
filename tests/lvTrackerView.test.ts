import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LvTrackerTable } from "@/components/LvTrackerTable";
import { MasterTrackerTable } from "@/components/MasterTrackerTable";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { ITEMS } from "@/lib/domain/constants";
import type { LvTrackerRow } from "@/lib/server/lvTracker";

const { filters, cards, exported } = vi.hoisted(() => ({
  filters: {} as Record<string, string>,
  cards: vi.fn(),
  exported: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/tracker" }));
vi.mock("@/app/lv/actions", () => ({ recordLvGroupTotal: vi.fn(), recordLvTotal: vi.fn() }));
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
vi.mock("@/components/ProgressRing", () => ({ RING_GRID: "", RingCard: cards }));
vi.mock("@/components/ExportButton", () => ({ ExportButton: exported }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => null }));

const row = (mo: string, required: number, paint: number, extra: Partial<LvTrackerRow> = {}): LvTrackerRow => ({
  mo, bom: `BOM-${mo}`, soi: null, urgent: false, customer: null, product: "USS", family: "",
  fgCode: null, secItem: null, ospEncloser: 0, remarks: null, materialsRemarks: null,
  state: { required, punch: required, bend: required, weld: required, paint, delivered: 0 },
  complete: paint, remaining: required - paint, achievement: paint / required, status: "open",
  hold: { onHold: false, holdNote: null, holdSinceISO: null, holdBy: null },
  priority: false, months: ["October 2026"], ...extra,
});
const rows = [
  row("A", 10, 5, { urgent: true }),
  row("B", 20, 20, { product: "LSS", family: "MB", months: ["September 2026"] }),
  row("C", 30, 0, { status: "closed" }),
];

function render() {
  return renderToStaticMarkup(createElement(LvTrackerTable, { rows, editableStages: [], canStatus: false }));
}
function paintCard() {
  return cards.mock.calls.map(([props]) => props).find((props) => props.label === "Paint");
}

beforeEach(() => {
  for (const key of Object.keys(filters)) delete filters[key];
  cards.mockReset().mockReturnValue(null);
  exported.mockReset().mockReturnValue(null);
});

describe("LV tracker view", () => {
  it("keeps selected filters visible outside the phone's folded toolbar", () => {
    filters["lvtracker.q"] = "BOM-A";
    filters["lvtracker.month"] = "October 2026";
    const html = render();
    expect(html).toContain('aria-label="Active tracker filters"');
    expect(html).toContain('aria-label="Clear Search: BOM-A"');
    expect(html).toContain('aria-label="Clear Plan month: October 2026"');
    expect(html.indexOf('aria-label="Active tracker filters"')).toBeLessThan(html.indexOf('aria-expanded="false"'));
    expect(html).toContain("Open orders");
  });
  it("shows only the four making stages in the cards, columns, column menu and export", () => {
    const html = render();
    expect(cards.mock.calls.map(([props]) => props.label)).toEqual(["Punch", "Bend", "Weld", "Paint"]);
    expect(html).not.toMatch(/Deliver|Dlvd/);
    expect(exported.mock.calls[0][0].rows[0]).not.toHaveProperty("Delivered");
    expect(paintCard()).toMatchObject({ done: 25, need: 30 });
  });

  it.each([
    ["q", "BOM-A", 5, 10],
    ["product", "LSS", 20, 20],
    ["family", "MB", 20, 20],
    ["month", "September 2026", 20, 20],
    ["urgent", "yes", 5, 10],
    ["progress", "partial", 5, 10],
    ["status", "closed", 0, 30],
    ["status", "all", 25, 60],
    ["q", "no match", 0, 0],
  ])("keeps cards and exported rows aligned with the %s filter", (key, value, done, need) => {
    filters[`lvtracker.${key}`] = value;
    render();
    expect(paintCard()).toMatchObject({ done, need });
    const visible = exported.mock.calls[0][0].rows as { Required: number; Painted: number }[];
    expect(visible.reduce((sum, r) => sum + r.Required, 0)).toBe(need);
    expect(visible.reduce((sum, r) => sum + r.Painted, 0)).toBe(done);
  });

  it("combines filters instead of adding their scopes together", () => {
    filters["lvtracker.product"] = "LSS";
    filters["lvtracker.urgent"] = "yes";
    render();
    expect(paintCard()).toMatchObject({ done: 0, need: 0 });
    expect(exported.mock.calls[0][0].rows).toEqual([]);
  });
});

describe("transformer tracker summary", () => {
  const transformerRows: MasterTrackerRow[] = rows.map((r) => ({
    ...r, kva: "1000", rating: null, fins: null, crcSize: null, colorRal: null, sfm: null,
    required: r.state.required, welded: r.state.weld, pendingQty: null,
    items: Object.fromEntries(ITEMS.map((it) => [it, {
      cut: r.state.punch, weld: r.state.weld, paint: r.state.paint, shp: r.state.paint,
      delivered: 0, osp: 0, excluded: false, eligible: true,
    }])) as MasterTrackerRow["items"],
  }));
  it.each([
    ["q", "BOM-A", 5, 10],
    ["status", "closed", 0, 30],
    ["progress", "complete", 20, 20],
    ["urgent", "yes", 5, 10],
    ["q", "no match", 0, 0],
  ])("scopes component cards to the %s filter", (key, value, done, need) => {
    filters[`tracker.${key}`] = value;
    renderToStaticMarkup(createElement(MasterTrackerTable, { rows: transformerRows }));
    expect(cards.mock.calls.map(([props]) => props)).toHaveLength(ITEMS.length);
    for (const [props] of cards.mock.calls) expect(props).toMatchObject({ done, need, compact: true });
  });
});
