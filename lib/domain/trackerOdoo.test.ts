import { describe, expect, it } from "vitest";
import { ITEMS } from "./constants";
import { closedInOdoo, closesByItself, finishedAndClosedInOdoo, normalizeOdooTrackingStart, odooPlanMonth, trackerOdooQuantities as allocateOdoo, trackerOdooTotal } from "./trackerOdoo";
const order = (mo = "MO-1", bom = "BOM-A", soi: string | null = "SO-1", month = "October 2026", planQty = 100) => ({ mo, bom, soi, line: "TR", source: month, months: month, planQty });
const trackerOdooQuantities = (...args: Parameters<typeof allocateOdoo>) => allocateOdoo(args[0], args[1], args[2], args[3] === undefined ? "2000-01" : args[3]);
const entry = (extra = {}) => ({ id: 1, date: "2026-09-06", line: "TR", ledgerId: null as number | null, soi: "SO-1", fgCode: "FB-022-BOM-A", product: "Tank", qty: 5, status: "Done", ...extra });
describe("Odoo closed quantities on the plan tracker", () => {
  it("reads quantities only from Done/Closed TR log rows, not pending attempts or LV", () => {
    const result = trackerOdooQuantities([order()], [entry(), entry({ status: " Closed ", qty: 3 }), ...["Pending", "Blocked", "Cancelled", "MO to be close"].map((status) => entry({ status, qty: 100 })), entry({ line: "LV", qty: 100 }), entry({ qty: 0 })], []);
    expect(result.counts.get("MO-1")?.TN).toBe(8);
  });
  it("keeps each component independent, supporting the Odoo tab's product aliases", () => {
    const result = trackerOdooQuantities([order()], ["CF", "top cover", "Tank", "cable-box", "Arrestor Bracket", "Mono Box"].map((product, i) => entry({ product, qty: i + 1 })), []);
    expect(ITEMS.map((it) => result.counts.get("MO-1")?.[it])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("uses the linked planner MO when available, without confusing it with Odoo's MO", () => {
    const result = trackerOdooQuantities([order(), order("MO-2")], [entry({ ledgerId: 7, soi: "OTHER-SOI", fgCode: "FB-022-OTHER", qty: 42 })], [{ id: 7, mo: "MO-2", bom: "BOM-A", item: "TN" }]);
    expect(result.counts.get("MO-2")?.TN).toBe(42);
    expect(result.counts.has("MO-1")).toBe(false);
  });
  it("resolves an imported drawing code through a unique SOI, as the Odoo tab does", () => {
    const result = trackerOdooQuantities([order()], [entry({ fgCode: "FB-022-DRAWING-REV-2" })], []);
    expect(result.counts.get("MO-1")?.TN).toBe(5);
  });
  it("uses the BOM’s linked On Odoo records instead of adding imported project duplicates", () => {
    const orders = [order("MO-1", "BOM-A", "SO-1", "September 2026", 4), order("MO-2")];
    const progress = trackerOdooQuantities(orders, [entry(), entry({ ledgerId: 7, qty: 2 })], [{ id: 7, mo: "MO-1", bom: "BOM-A", item: "TN" }]);
    const rows = viewRows(orders, progress);
    expect(trackerOdooTotal(rows, "TN")).toEqual({ qty: 2, unallocated: 0 });
    expect(trackerOdooTotal([rows[0]], "TN")).toEqual({ qty: 2, unallocated: 0 });
    expect(trackerOdooTotal([rows[1]], "TN")).toEqual({ qty: 0, unallocated: 0 });
  });
  it("does not guess a project when an SOI names several BOMs and the FG code cannot distinguish them", () => {
    expect(trackerOdooQuantities([order(), order("MO-2", "BOM-B")], [entry({ fgCode: "FB-022-UNKNOWN" })], []).counts.size).toBe(0);
    expect(trackerOdooQuantities([order(), order("MO-2", "BOM-B")], [entry({ fgCode: "FB-022-BOM-B" })], []).counts.get("MO-2")?.TN).toBe(5);
  });
  it("follows status and quantity changes on the next read", () => {
    expect(trackerOdooQuantities([order()], [entry({ qty: 9 })], []).counts.get("MO-1")?.TN).toBe(9);
    expect(trackerOdooQuantities([order()], [entry({ status: "Pending" })], []).counts.size).toBe(0);
  });
  it("splits the same BOM's 28 closed cable boxes into 14 for the old plan and 14 for the new one", () => {
    const orders = [order("NEW", "10017E11M11", "SO-1", "October 2026", 16), order("OLD", "10017E11M11", "SO-1", "September 2026", 14)];
    const progress = trackerOdooQuantities(orders, [entry({ product: "Cable Box", qty: 28 }), entry({ product: "Tank", qty: 14 })], []);
    const rows = viewRows(orders, progress);
    expect(trackerOdooTotal(rows, "CB", "September 2026").qty).toBe(14);
    expect(trackerOdooTotal(rows, "CB", "October 2026").qty).toBe(14);
    expect(trackerOdooTotal(rows, "TN", "September 2026").qty).toBe(14);
    expect(trackerOdooTotal(rows, "TN", "October 2026").qty).toBe(0);
    expect(trackerOdooTotal([rows[0]], "CB", "October 2026").qty).toBe(14);
    expect(trackerOdooTotal(rows, "CB").qty).toBe(28);
  });
  it("does not create new demand for an MO carried across two plan months", () => {
    const orders = [{ ...order("OLD", "BOM-A", "SO-1", "September 2026", 10), months: "September 2026,October 2026" }, order("NEW", "BOM-A", "SO-1", "October 2026", 10)];
    const rows = viewRows(orders, trackerOdooQuantities(orders, [entry({ qty: 14 })], []));
    expect(trackerOdooTotal(rows, "TN", "September 2026").qty).toBe(10);
    expect(trackerOdooTotal(rows, "TN", "October 2026").qty).toBe(4);
    expect(trackerOdooTotal([rows[0]], "TN", "October 2026").qty).toBe(0);
    expect(odooPlanMonth({ months: "October 2026,September 2026" })).toBe("September 2026");
  });
  it("keeps overflow separate instead of inflating a month or reassigning a linked order to another plan", () => {
    const orders = [order("OLD", "BOM-A", "SO-1", "September 2026", 5), order("NEW", "BOM-A", "SO-1", "October 2026", 5)];
    const progress = trackerOdooQuantities(orders, [entry({ ledgerId: 7, qty: 8 }), entry({ qty: 6 })], [{ id: 7, mo: "NEW", bom: "BOM-A", item: "TN" }]);
    const rows = viewRows(orders, progress);
    expect(trackerOdooTotal(rows, "TN")).toEqual({ qty: 5, unallocated: 3 });
    expect(trackerOdooTotal(rows, "TN", "October 2026")).toEqual({ qty: 5, unallocated: 3 });
    expect(progress.unallocated.reduce((n, p) => n + p.qty, 0)).toBe(3);
  });
  it("respects customer SOIs and does not fill a component excluded from an older plan", () => {
    const orders = [{ ...order("OLD", "BOM-A", "SO-1", "September 2026", 10), eligibleItems: ["CF"] as (typeof ITEMS)[number][] }, order("NEW", "BOM-A", "SO-1", "October 2026", 10), order("OTHER", "BOM-A", "SO-2", "August 2026", 10)];
    const progress = trackerOdooQuantities(orders, [entry({ qty: 7 })], []);
    expect(progress.counts.get("NEW")?.TN).toBe(7);
    expect(progress.counts.has("OLD")).toBe(false);
    expect(progress.counts.has("OTHER")).toBe(false);
    expect(trackerOdooQuantities(orders, [entry({ soi: "UNKNOWN" })], []).counts.size).toBe(0);
  });
  it("sorts January after the preceding December and is independent of registry/input order", () => {
    const orders = [order("JAN", "BOM-A", "SO-1", "January 2027", 10), order("DEC", "BOM-A", "SO-1", "December 2026", 10)];
    const entries = [entry({ id: 2, qty: 3 }), entry({ id: 1, qty: 9 })];
    const a = trackerOdooQuantities(orders, entries, []), b = trackerOdooQuantities([...orders].reverse(), [...entries].reverse(), []);
    expect(a.counts.get("DEC")?.TN).toBe(10);
    expect(a.counts.get("JAN")?.TN).toBe(2);
    expect(a.counts).toEqual(b.counts);
  });
  it("does not allocate new closings to four months of imported, untracked backlog", () => {
    const orders = [order("JUN", "BOM-A", "SO-1", "June 2026", 20), order("JUL", "BOM-A", "SO-1", "July 2026", 20), order("AUG", "BOM-A", "SO-1", "August 2026", 20), order("SEP", "BOM-A", "SO-1", "September 2026", 10), order("OCT", "BOM-A", "SO-1", "October 2026", 10)];
    const progress = trackerOdooQuantities(orders, [entry({ qty: 14 })], [], "2026-09");
    expect(progress.counts.get("SEP")?.TN).toBe(10);
    expect(progress.counts.get("OCT")?.TN).toBe(4);
    for (const mo of ["JUN", "JUL", "AUG"]) {
      expect(progress.counts.has(mo)).toBe(false);
      expect(progress.tracked.has(JSON.stringify([mo, "TN"]))).toBe(false);
    }
  });
  it("leaves project quantities unallocated until tracking starts, but retains an older linked closing", () => {
    const orders = [order("OLD", "BOM-A", "SO-1", "June 2026", 10), order("NEW")];
    const unknown = trackerOdooQuantities(orders, [entry({ qty: 14 })], [], null);
    expect(unknown.counts.size).toBe(0); expect(unknown.unallocated[0].qty).toBe(14);
    const linked = trackerOdooQuantities(orders, [entry({ qty: 7, ledgerId: 7 })], [{ id: 7, mo: "OLD", bom: "BOM-A", item: "TN" }], "2026-09");
    expect(linked.counts.get("OLD")?.TN).toBe(7);
    expect(linked.tracked.has(JSON.stringify(["OLD", "TN"]))).toBe(true);
  });
  it("matches the BOM trace's component through the ledger even when the typed product and FG are wrong", () => {
    const progress = trackerOdooQuantities([order()], [entry({ product: "Cable Box", fgCode: "FB-024-WRONG", ledgerId: 7, qty: 7 })], [{ id: 7, mo: "MO-1", bom: "BOM-A", item: "TN" }]);
    expect(progress.counts.get("MO-1")).toEqual({ TN: 7 });
  });
  it("does not use a closed import to override a pending linked production closing", () => {
    const progress = trackerOdooQuantities([order()], [entry({ ledgerId: 7, status: "Pending" }), entry({ qty: 14 })], [{ id: 7, mo: "MO-1", bom: "BOM-A", item: "TN" }]);
    expect(progress.counts.size).toBe(0);
  });
  it("fills oldest tracked plans for a BOM-level linked closing without an MO", () => {
    const orders = [order("OLD", "BOM-A", "SO-1", "September 2026", 10), order("NEW", "BOM-A", "SO-1", "October 2026", 10)];
    const progress = trackerOdooQuantities(orders, [entry({ ledgerId: 7, qty: 14 })], [{ id: 7, mo: null, bom: "BOM-A", item: "TN" }], "2026-09");
    expect(progress.counts.get("OLD")?.TN).toBe(10); expect(progress.counts.get("NEW")?.TN).toBe(4);
  });
  it("matches the existing BOM On Odoo totals instead of doubling tank, cable-box and mono-box imports", () => {
    const items = [["CF", 14], ["TC", 14], ["CB", 14], ["TN", 7], ["MB", 7]] as const;
    const ledgers = items.map(([item], i) => ({ id: i + 1, mo: "MO-1", bom: "BOM-A", item }));
    const entries = items.map(([product, qty], i) => entry({ id: i + 1, ledgerId: i + 1, product, qty }));
    entries.push(...[entry({ product: "Tank", qty: 7 }), entry({ product: "Cable Box", qty: 14 }), entry({ product: "Mono Box", qty: 7 })]);
    const progress = trackerOdooQuantities([order("MO-1", "BOM-A", "SO-1", "September 2026", 16)], entries, ledgers);
    expect(progress.counts.get("MO-1")).toEqual({ CF: 14, TC: 14, CB: 14, TN: 7, MB: 7 });
    expect(Object.values(progress.counts.get("MO-1")!).reduce((sum, qty) => sum + qty, 0)).toBe(56);
  });
  it("starts inclusively on 6 September, excluding the first five days from automatic allocation", () => {
    const orders = [order("AUG", "BOM-A", "SO-1", "August 2026", 100), order("SEP", "BOM-A", "SO-1", "September 2026", 10), order("OCT", "BOM-A", "SO-1", "October 2026", 10)];
    const entries = [entry({ date: "2026-09-01", qty: 100 }), entry({ date: "2026-09-05", qty: 100 }), entry({ date: new Date("2026-09-06T00:00:00Z"), qty: 7 }), entry({ date: "2026-09-07", qty: 7 })];
    const progress = trackerOdooQuantities(orders, entries, [], "2026-09-06");
    expect(progress.counts.get("SEP")?.TN).toBe(10);
    expect(progress.counts.get("OCT")?.TN).toBe(4);
    expect(progress.counts.has("AUG")).toBe(false);
    expect(progress.unallocated).toEqual([]);
  });
  it("keeps an explicitly linked historical closing on its own order before the recording start", () => {
    const progress = trackerOdooQuantities([order("OLD", "BOM-A", "SO-1", "August 2026", 10)], [entry({ date: "2026-09-05", ledgerId: 7, qty: 7 })], [{ id: 7, mo: "OLD", bom: "BOM-A", item: "TN" }], "2026-09-06");
    expect(progress.counts.get("OLD")?.TN).toBe(7);
    expect(progress.tracked.has(JSON.stringify(["OLD", "TN"]))).toBe(true);
  });
  it("supports saved month-only starts and rejects impossible dates", () => {
    expect(normalizeOdooTrackingStart("2026-09")).toBe("2026-09-01");
    expect(normalizeOdooTrackingStart("2026-09-06")).toBe("2026-09-06");
    expect(normalizeOdooTrackingStart("2026-09-31")).toBe(null);
  });
});

function viewRows(orders: ReturnType<typeof order>[], progress: ReturnType<typeof trackerOdooQuantities>) {
  return orders.map((o) => ({ mo: o.mo, odooPlanMonth: odooPlanMonth(o), items: Object.fromEntries(ITEMS.map((it) => [it, { odooClosed: progress.counts.get(o.mo)?.[it] ?? 0 }])) as Record<(typeof ITEMS)[number], { odooClosed: number }>, odooUnallocated: progress.unallocated.filter((pool) => pool.mos.includes(o.mo)) }));
}

describe("closedInOdoo — an order that closes by itself", () => {
  const needed = [{ item: "TN" as const, osp: 0 }, { item: "TC" as const, osp: 0 }, { item: "CF" as const, osp: 2 }];
  it("is closed once every needed component's plan quantity is closed in Odoo, outsourced pieces counted", () => {
    expect(closedInOdoo(5, needed, { TN: 5, TC: 5, CF: 3 })).toBe(true);
    expect(closedInOdoo(5, needed, { TN: 5, TC: 4, CF: 3 })).toBe(false);
    expect(closedInOdoo(5, needed, { TN: 5, TC: 5 })).toBe(false);
  });
  it("never closes an order with nothing to close, nothing needed, or nothing closed in Odoo", () => {
    expect(closedInOdoo(0, needed, { TN: 5, TC: 5, CF: 5 })).toBe(false);
    expect(closedInOdoo(5, [], { TN: 5 })).toBe(false);
    expect(closedInOdoo(3, [{ item: "TN", osp: 3 }], {})).toBe(false);
    expect(closedInOdoo(3, [{ item: "TN", osp: 3 }], undefined)).toBe(false);
  });
});

describe("closesByItself — read off a Plan Tracker row", () => {
  // an order of 2 needing its tank and top cover (core frame and cable box N/A)
  const item = (o: Record<string, unknown> = {}) => ({ osp: 0, excluded: false, eligible: true, odooClosed: 0, ...o });
  const row = (o: { status?: string; complete?: number; tn?: number; tc?: number; tnOsp?: number; onHold?: boolean; pendingQty?: unknown } = {}) => ({
    status: o.status ?? "open", required: 2, complete: o.complete ?? 2, hold: { onHold: o.onHold ?? false }, pendingQty: o.pendingQty ?? null,
    items: { TN: item({ odooClosed: o.tn ?? 2, osp: o.tnOsp ?? 0 }), TC: item({ odooClosed: o.tc ?? 2 }), CF: item({ excluded: true }), CB: item({ excluded: true }), AR: item({ eligible: false }), MB: item({ eligible: false }) },
  });

  it("an open order finished and closed in full in Odoo, outsourced pieces counted", () => {
    expect(closesByItself(row())).toBe(true);
    expect(closesByItself(row({ tn: 1, tnOsp: 1 }))).toBe(true);
  });

  it("never one short in Odoo, unfinished, on hold, with a plan qty waiting, or closed already", () => {
    expect(closesByItself(row({ tc: 1 }))).toBe(false);
    expect(closesByItself(row({ complete: 1 }))).toBe(false);
    expect(closesByItself(row({ onHold: true }))).toBe(false);
    expect(closesByItself(row({ pendingQty: { to: 4, month: "November 2026" } }))).toBe(false);
    expect(closesByItself(row({ status: "closed" }))).toBe(false);
    // what a reopen by hand reads, whatever the status
    expect(finishedAndClosedInOdoo(row({ status: "closed" }))).toBe(true);
    expect(finishedAndClosedInOdoo(row({ status: "closed", tc: 1 }))).toBe(false);
  });
});
