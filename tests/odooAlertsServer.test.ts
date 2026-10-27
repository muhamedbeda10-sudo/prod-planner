import { beforeEach, describe, expect, it, vi } from "vitest";

// The alert polls (lib/server/odooAlerts.ts) run every minute per subscriber:
// the closed rows — the bulk of the log — stay in the database, and the domain
// rule still decides what is listed.

const h = vi.hoisted(() => ({ findMany: vi.fn(), states: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { odooEntry: { findMany: h.findMany } } }));
vi.mock("@/lib/server/odoo", () => ({
  resolveRowBoms: async (rows: unknown[]) => rows.map(() => ({ boms: ["T-1"], ambiguous: false })),
  resolveRowMaterialStates: h.states,
}));

import { getNeedingMo, getReadyToClose } from "@/lib/server/odooAlerts";

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

  it("look the material up only when asked — the layout's count skips it", async () => {
    h.findMany.mockResolvedValue([row(1, {}), row(2, {})]);
    expect((await getReadyToClose()).map((r) => r.material)).toEqual(["none", "none"]);
    expect(h.states).not.toHaveBeenCalled();
    h.states.mockResolvedValue(["missing", "ok"]);
    expect((await getReadyToClose({ material: true })).map((r) => r.material)).toEqual(["missing", "ok"]);
    expect(h.states.mock.calls[0][0].map((r: { id: number }) => r.id)).toEqual([1, 2]);
    h.findMany.mockResolvedValue([row(4, { odooMo: "" })]);
    expect((await getNeedingMo()).map((r) => r.material)).toEqual(["none"]);
    expect(h.states).toHaveBeenCalledTimes(1);
    // a failed material lookup leaves the rows uncoloured, not the alerts gone
    h.findMany.mockResolvedValue([row(1, {})]);
    h.states.mockRejectedValue(new Error("timeout"));
    expect((await getReadyToClose({ material: true })).map((r) => r.material)).toEqual(["none"]);
  });
});
