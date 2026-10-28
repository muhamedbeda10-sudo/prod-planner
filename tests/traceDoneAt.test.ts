import { describe, it, expect, vi } from "vitest";

// ---- Trace → On ODOO → "Closed on" is the moment the row was closed ------------
// The trace used to carry the UTC day only, so the cell read 02:00/03:00 on
// the factory clock while the ODOO log showed the real time for the same row.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      planOrder: { findMany: fn(), groupBy: fn() }, handoverEntry: { findMany: fn() }, masterOrder: { findMany: fn() },
      plan: { findMany: fn() }, queueNote: { findMany: fn() }, returnEntry: { findMany: fn() }, odooEntry: { findMany: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
// what the Odoo sync read is its own tested module (lib/domain/odooSync.ts)
vi.mock("@/lib/server/odooFacts", () => ({ odooFactsFor: async () => new Map(), moStatesOf: async () => new Map(), childMosOf: async () => new Map() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "TR", ledgerItemWhere: () => ({ item: { not: "PNL" } }) }));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: async () => [] }));

import { getTrace } from "@/lib/server/trace";
import { formatDateTime } from "@/lib/domain/format";

const closedAt = new Date("2026-08-02T10:00:00Z");
const now = new Date("2026-08-20T08:00:00Z");

describe("getTrace → odoo rows", () => {
  it("carries the closing as an instant, so it reads the same stamp as the ODOO log", async () => {
    for (const m of [h.prisma.planOrder, h.prisma.masterOrder, h.prisma.plan, h.prisma.queueNote, h.prisma.returnEntry]) m.findMany.mockResolvedValue([]);
    h.prisma.handoverEntry.findMany.mockResolvedValue([{
      id: 7, date: new Date("2026-08-01T00:00:00Z"), planNo: 3, dept: "Painting", bom: "B1", bomRaw: "B1", mo: "MO-1", item: "TN", qty: 1,
      source: "worklist", createdBy: "Ali",
    }]);
    h.prisma.odooEntry.findMany.mockResolvedValue([{
      id: 1, date: new Date("2026-08-01T00:00:00Z"), product: "P", odooMo: "PF01/MO/1", qty: 1, status: "Done", doneAt: closedAt, fgCode: "", recordedBy: "Ali", ledgerId: 7,
    }]);
    const t = await getTrace({ mo: "MO-1" });
    expect(t.odoo).toHaveLength(1);
    expect(t.odoo[0].doneAtISO).toBe(closedAt.toISOString());
    // the ODOO log stamps `doneAt.toISOString()` with formatDateTime — the trace must agree
    const traceStamp = formatDateTime(t.odoo[0].doneAtISO, now);
    expect(traceStamp).toBe(formatDateTime(closedAt.toISOString(), now));
    expect(traceStamp).toBe("2 Aug 13:00");
    expect(t.odoo[0].dateISO).toBe("2026-08-01");
  });

  it("leaves an open row without a stamp", async () => {
    for (const m of [h.prisma.planOrder, h.prisma.masterOrder, h.prisma.plan, h.prisma.queueNote, h.prisma.returnEntry]) m.findMany.mockResolvedValue([]);
    h.prisma.handoverEntry.findMany.mockResolvedValue([{ id: 8, date: closedAt, planNo: 3, dept: "Painting", bom: "B1", bomRaw: "B1", mo: "MO-1", item: "TN", qty: 1, source: "worklist", createdBy: null }]);
    h.prisma.odooEntry.findMany.mockResolvedValue([{ id: 2, date: closedAt, product: "P", odooMo: "", qty: 1, status: "Pending", doneAt: null, fgCode: "", recordedBy: null, ledgerId: 8 }]);
    const t = await getTrace({ mo: "MO-1" });
    expect(t.odoo[0].doneAtISO).toBeNull();
    expect(formatDateTime(t.odoo[0].doneAtISO, now)).toBe("—");
  });
});
