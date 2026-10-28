import { beforeEach, describe, expect, it, vi } from "vitest";

// The alert polls (lib/server/odooAlerts.ts) run every minute per subscriber:
// the closed rows — the bulk of the log — stay in the database, and the domain
// rule still decides what is listed.

const h = vi.hoisted(() => ({ findMany: vi.fn(), states: vi.fn() }));
vi.mock("server-only", () => ({}));
// what the Odoo sync read is its own tested module (lib/domain/odooSync.ts)
vi.mock("@/lib/server/odooFacts", () => ({ odooFactsFor: async () => new Map() }));
vi.mock("@/lib/db", () => ({ prisma: { odooEntry: { findMany: h.findMany } } }));
vi.mock("@/lib/server/odoo", () => ({
  resolveRowBoms: async (rows: unknown[]) => rows.map(() => ({ boms: ["T-1"], ambiguous: false })),
  resolveRowMaterialStates: h.states,
}));

import { getNeedingMo, getReadyToClose, getRowsMaterial } from "@/lib/server/odooAlerts";

const row = (id: number, o: Record<string, unknown>) => ({ id, line: "TR", date: new Date("2026-10-20T00:00:00Z"), soi: null, fgCode: "FB-1", product: "Tank", odooMo: "SF01/MO/1", qty: 1, status: "MO to be close", source: "manual", ledgerId: null, ...o });

beforeEach(() => vi.clearAllMocks());

describe("the alert loaders", () => {
  it("leave Done, Closed and Cancelled rows in the database and take a bounded page", async () => {
    h.findMany.mockResolvedValue([row(1, {}), row(2, { status: "Pending" })]);
    expect((await getReadyToClose()).map((r) => r.id)).toEqual([1, 2]);
    expect(h.findMany.mock.calls[0][0]).toMatchObject({ where: { NOT: { odooMo: "" }, status: { notIn: ["Done", "Closed", "Blocked", "Cancelled", "Canceled"], mode: "insensitive" } }, take: 400 });
    h.findMany.mockResolvedValue([row(3, { odooMo: "", status: "blocked " }), row(4, { odooMo: "" })]);
    // a Blocked row is not waiting on anyone's MO — out of the poll in SQL, and the domain rule still has the last word on what came back
    expect((await getNeedingMo()).map((r) => r.id)).toEqual([4]);
    expect(h.findMany.mock.calls[1][0]).toMatchObject({ where: { odooMo: "", status: { notIn: ["Done", "Closed", "Blocked", "Cancelled", "Canceled"], mode: "insensitive" } }, take: 400 });
  });

  it("leave the material lookup to the open popup — the poll never makes it", async () => {
    h.findMany.mockResolvedValue([row(1, {})]);
    await getReadyToClose();
    await getNeedingMo();
    expect(h.states).not.toHaveBeenCalled();
    expect(await getRowsMaterial([])).toEqual({});
    expect(h.findMany).toHaveBeenCalledTimes(2);
    h.findMany.mockResolvedValue([row(7, {}), row(3, {})]);
    h.states.mockResolvedValue(["missing", "ok"]);
    expect(await getRowsMaterial([3, 7])).toEqual({ 7: "missing", 3: "ok" });
    expect(h.findMany.mock.calls[2][0]).toMatchObject({ where: { id: { in: [3, 7] } } });
  });
});
