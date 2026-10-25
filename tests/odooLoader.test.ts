import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- the ODOO tab's reads (lib/server/odoo.ts) -------------------------------
// The day picker's days come grouped from SQL, not from every row deduped in
// memory; and the material lookup of a day's MOs is two bounded queries — the
// family's MOs by name plus the backorders found by prefix in JS — never a
// pattern predicate per parent MO.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      odooEntry: { findMany: fn(), findUnique: fn(), count: fn(), groupBy: fn() },
      masterOrder: { findMany: fn() },
      handoverEntry: { findMany: fn(), findUnique: fn() },
      materialUsage: { findMany: fn() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "TR" }));

import { getOdooData, getOdooRowMaterial } from "@/lib/server/odoo";

const t = new Date("2026-10-20T08:00:00Z");
const line = (id: number, mo: string, month = "OCT-2026") => ({
  id, month, bom: "", mo, partCode: "", partName: "", materialCode: "", material: "Steel",
  thicknessMm: 3, sheetSize: "1220*2440", units: 1, sheetsPerUnit: 1, actualPerUnit: 1, sheetsUsed: null, note: null,
});
const lvRow = (odooMo: string) => ({
  id: 7, line: "LV", date: new Date("2026-10-10T00:00:00Z"), soi: null, fgCode: "FG-SUA-AS-AA-000004", product: "Panel",
  odooMo, qty: 2, status: "MO to be close", doneAt: null, updatedAt: t, recordedBy: null, source: "manual", fgGuessed: false,
  ledgerId: null, notes: [],
});

beforeEach(() => {
  vi.resetAllMocks();
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.findUnique.mockResolvedValue(null);
});

describe("linesByMo", () => {
  it("fetches the family by name and the backorders by id — no per-parent pattern predicate", async () => {
    h.prisma.odooEntry.findUnique.mockResolvedValue(lvRow("SF01/MO/15337-002"));
    // the line's MO column: the parent, two backorders (one lower-case), an
    // unrelated MO and a near miss that only shares the digits
    h.prisma.materialUsage.findMany
      .mockResolvedValueOnce([
        { id: 1, mo: "SF01/MO/15337" }, { id: 2, mo: "SF01/MO/15337-001" }, { id: 3, mo: "sf01/mo/15337-003" },
        { id: 4, mo: "SF01/MO/99999" }, { id: 5, mo: "SF01/MO/153370" },
      ])
      .mockResolvedValueOnce([line(1, "SF01/MO/15337"), line(2, "SF01/MO/15337-001"), line(3, "sf01/mo/15337-003")]);

    const res = await getOdooRowMaterial(7);
    expect(res).not.toBeNull();

    const calls = h.prisma.materialUsage.findMany.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls).toHaveLength(2);
    // the scan is a projection of the line's named MOs only
    expect(calls[0]).toEqual({ where: { line: "LV", mo: { not: "" } }, select: { id: true, mo: true } });
    // the full read names the family and the backorders' ids, nothing per parent
    const where = calls[1].where as { line: string; OR: Record<string, unknown>[] };
    expect(where.line).toBe("LV");
    expect(where.OR).toEqual([
      { mo: { in: ["SF01/MO/15337-002", "SF01/MO/15337"], mode: "insensitive" } },
      { id: { in: [2, 3] } },
    ]);
    expect(JSON.stringify(calls)).not.toContain("startsWith");

    // the parent and both siblings are in the lookup under their own keys,
    // so linesOfMo can fall from the backorder to its family
    expect(Object.keys(res!.nesting).sort()).toEqual(["MO|SF01/MO/15337", "MO|SF01/MO/15337-001", "MO|SF01/MO/15337-003"]);
    expect(res!.nesting["MO|SF01/MO/15337-003"].map((l) => l.id)).toEqual([3]);
    expect(res!.nesting["MO|SF01/MO/15337"][0]).not.toHaveProperty("mo");
  });

  it("skips the id predicate when the line holds no backorder of the family", async () => {
    h.prisma.odooEntry.findUnique.mockResolvedValue(lvRow("SF01/MO/20941"));
    h.prisma.materialUsage.findMany
      .mockResolvedValueOnce([{ id: 1, mo: "SF01/MO/20941" }, { id: 2, mo: "SF01/MO/20942-001" }])
      .mockResolvedValueOnce([line(1, "SF01/MO/20941")]);
    const res = await getOdooRowMaterial(7);
    const where = (h.prisma.materialUsage.findMany.mock.calls[1][0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toEqual([{ mo: { in: ["SF01/MO/20941"], mode: "insensitive" } }]);
    expect(Object.keys(res!.nesting)).toEqual(["MO|SF01/MO/20941"]);
  });

  it("reads nothing when the rows name no MO", async () => {
    h.prisma.odooEntry.findUnique.mockResolvedValue(lvRow(""));
    const res = await getOdooRowMaterial(7);
    expect(res!.nesting).toEqual({});
    expect(h.prisma.materialUsage.findMany).not.toHaveBeenCalled();
  });
});

describe("getOdooData", () => {
  it("lists the log's days from a SQL group, newest first", async () => {
    h.prisma.odooEntry.findMany.mockResolvedValue([]);
    h.prisma.odooEntry.count.mockResolvedValue(3);
    h.prisma.odooEntry.groupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by[0] === "date"
        ? [{ date: new Date("2026-10-12T00:00:00Z") }, { date: new Date("2026-10-10T00:00:00Z") }]
        : [{ status: "MO to be close", _count: { _all: 2 } }, { status: "Done", _count: { _all: 1 } }]);

    const data = await getOdooData({ kind: "day", iso: "2026-10-12" });
    expect(data.days).toEqual(["2026-10-12", "2026-10-10"]);
    expect(data.totalRows).toBe(3);
    expect(data.openRows).toBe(2);
    expect(h.prisma.odooEntry.groupBy).toHaveBeenCalledWith({ by: ["date"], orderBy: { date: "desc" } });
    const calls = h.prisma.odooEntry.findMany.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.some((c) => "distinct" in c)).toBe(false);
  });
});
