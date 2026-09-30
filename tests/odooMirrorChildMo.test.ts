import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mirrorLedgerToOdoo } from "@/lib/server/odooMirror";
import type { Prisma } from "@prisma/client";

// A painting closing is born on the ODOO tab with the plan's child MO for
// its component — the first open child with room — and flagged as filled.
function mockTx(children: { childMo: string; qty: number | null; state: string | null }[], booked: Record<string, number>) {
  const created: Record<string, unknown>[] = [];
  const tx = {
    masterOrder: { findUnique: async () => ({ soi: "S01238-2", bom: "10017E11M11", line: "TR", product: null, fgCode: null }) },
    odooEntry: {
      findMany: async () => [],
      groupBy: async () => Object.entries(booked).map(([odooMo, qty]) => ({ odooMo, _sum: { qty } })),
      create: async (a: { data: Record<string, unknown> }) => { created.push(a.data); return a.data; },
    },
    childMo: { findMany: vi.fn(async () => children) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, created, raw: tx };
}

const ledger = { id: 5, date: new Date("2026-10-02T00:00:00Z"), dept: "Painting", bom: "10017E11M11", mo: "PF01/MO/36331-001", item: "CB", qty: 2 };

describe("mirrorLedgerToOdoo with the plan's child MOs", () => {
  it("takes the open child MO with room and marks it filled", async () => {
    const m = mockTx([{ childMo: "PF01/MO/44582", qty: 2, state: "done" }, { childMo: "PF01/MO/44584", qty: 2, state: "confirmed" }], {});
    await mirrorLedgerToOdoo(m.tx, ledger, "Beda");
    expect(m.raw.childMo.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { planMo: "PF01/MO/36331-001", item: "CB" } }));
    expect(m.created[0]).toMatchObject({ odooMo: "PF01/MO/44584", autoMo: true, product: "Cable Box", qty: 2, status: "MO to be close" });
  });

  it("leaves the MO for a person when the plan has none open", async () => {
    const m = mockTx([{ childMo: "PF01/MO/44584", qty: 2, state: "confirmed" }], { "PF01/MO/44584": 2 });
    await mirrorLedgerToOdoo(m.tx, ledger, "Beda");
    expect(m.created[0]).toMatchObject({ odooMo: "", autoMo: false });
  });
});
