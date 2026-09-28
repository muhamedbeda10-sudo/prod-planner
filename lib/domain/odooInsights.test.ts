import { describe, expect, it } from "vitest";
import { buildOdooInsights, type OdooInsightRow } from "./odooInsights";
import type { OdooPeriod } from "./odooStats";

const period: OdooPeriod = { range: "custom", fromISO: "2026-09-01", toISO: "2026-09-10" } as OdooPeriod;
const row = (over: Partial<OdooInsightRow>): OdooInsightRow => ({
  dateISO: "2026-09-01", product: "Tank", qty: 1, status: "MO to be close", bom: "12011E16M13", doneISO: null, hasMo: false, ...over,
});

describe("the ODOO close-out insights", () => {
  it("funnels the logged rows through 'has MO' to Done, and rates the close", () => {
    const s = buildOdooInsights([
      row({ hasMo: true, status: "Done", doneISO: "2026-09-02" }),
      row({ hasMo: true }),
      row({}),
      row({ dateISO: "2026-08-20", status: "Done", doneISO: "2026-09-03", hasMo: true }), // logged before the period
    ], period);
    expect(s.funnel).toEqual({ logged: 3, withMo: 2, done: 1 });
    expect(s.closeRate).toBeCloseTo(1 / 3);
  });

  it("mixes the logged rows by status, the tail folded into Other", () => {
    const statuses = ["Done", "Done", "Pending", "Blocked", "Cancelled", "MO to be close", "Waiting", "Odd"];
    const s = buildOdooInsights(statuses.map((st) => row({ status: st })), period);
    expect(s.statusMix[0]).toMatchObject({ status: "Done", rows: 2, tone: "ok" });
    expect(s.statusMix).toHaveLength(6);
    expect(s.statusMix.at(-1)).toMatchObject({ status: "Other (2)", rows: 2, tone: "muted" });
  });

  it("measures lead time for rows closed in the period, logged whenever", () => {
    const s = buildOdooInsights([
      row({ status: "Done", dateISO: "2026-09-02", doneISO: "2026-09-02" }),
      row({ status: "Done", dateISO: "2026-09-02", doneISO: "2026-09-03" }),
      row({ status: "Done", dateISO: "2026-08-25", doneISO: "2026-09-04" }), // 10 days
      row({ status: "Done", dateISO: "2026-09-01", doneISO: "2026-09-05", product: "Top Cover" }), // 4 days
      row({ status: "Done", dateISO: "2026-09-01", doneISO: "2026-09-20" }), // closed after the period
    ], period);
    expect(s.leadTime.rows).toBe(4);
    expect(s.leadTime.buckets.map((b) => b.rows)).toEqual([1, 1, 0, 1, 1, 0]);
    expect(s.leadTime.medianDays).toBe(1);
    expect(s.leadTime.avgDays).toBe(3.8);
    expect(s.leadTime.p90Days).toBe(10);
    expect(s.leadTime.byProduct.find((p) => p.product === "Tank")).toEqual({ product: "Tank", avgDays: 3.7, rows: 3 });
  });

  it("ages the open rows at the period's end, leaving out Done and Cancelled", () => {
    const s = buildOdooInsights([
      row({ dateISO: "2026-09-10", qty: 2 }),
      row({ dateISO: "2026-09-08" }),
      row({ dateISO: "2026-09-01", status: "Blocked" }),
      row({ dateISO: "2026-09-01", status: "Cancelled" }),
      row({ dateISO: "2026-09-01", status: "Done", doneISO: "2026-09-02" }),
    ], period);
    expect(s.aging.openRows).toBe(3);
    expect(s.aging.openQty).toBe(4);
    expect(s.aging.buckets.map((b) => b.rows)).toEqual([1, 1, 0, 1, 0]); // ages 0, 2 and 9 days
    expect(s.aging.oldestDays).toBe(9);
  });

  it("builds a burn-up whose gap is the open backlog", () => {
    const s = buildOdooInsights([
      row({ dateISO: "2026-09-01" }),
      row({ dateISO: "2026-09-01", status: "Done", doneISO: "2026-09-03" }),
      row({ dateISO: "2026-09-02" }),
    ], period);
    expect(s.burnUp).toHaveLength(10);
    expect(s.burnUp[0]).toMatchObject({ dateISO: "2026-09-01", logged: 2, closed: 0, open: 2 });
    expect(s.burnUp[2]).toMatchObject({ logged: 3, closed: 1, open: 2 });
    expect(s.burnUp.at(-1)).toMatchObject({ logged: 3, closed: 1 });
  });

  it("splits each BOM's quantity by product, heaviest BOM first", () => {
    const s = buildOdooInsights([
      row({ bom: "A1", qty: 3 }),
      row({ bom: "A1", qty: 2, product: "Top Cover" }),
      row({ bom: "B2", qty: 9 }),
      row({ bom: "", qty: 1 }),
    ], period);
    expect(s.bomMix.rows.map((r) => [r.bom, r.qty])).toEqual([["B2", 9], ["A1", 5], ["(no BOM)", 1]]);
    expect(s.bomMix.rows[1].bySeries).toEqual({ Tank: 3, "Top Cover": 2 });
    expect(s.bomMix.series).toEqual(["Tank", "Top Cover"]);
  });

  it("narrows to one BOM like the rest of the dashboard", () => {
    const s = buildOdooInsights([row({ bom: "A1" }), row({ bom: "B2" })], period, "A1");
    expect(s.funnel.logged).toBe(1);
  });

  it("gives an empty period empty figures", () => {
    const s = buildOdooInsights([], period);
    expect(s.closeRate).toBe(0);
    expect(s.leadTime.medianDays).toBeNull();
    expect(s.aging.oldestDays).toBeNull();
    expect(s.burnUp).toHaveLength(10);
  });
});
