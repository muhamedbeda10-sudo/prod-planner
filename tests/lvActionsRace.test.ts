import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the LV panel actions' chain guard ----------------------
// The I/O boundary (Prisma, the Next cache, the auth guard, the plan windows,
// the ODOO mirror, the event log) is stubbed. The assertions are about WHERE
// the guard runs: inside the transaction that writes, behind a lock on the
// order, so two records on one MO cannot both read the same totals and both
// pass — and a refusal judged there writes nothing.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  /** Every call that matters, in the order it happened. */
  const trace: string[] = [];
  const tx = {
    $executeRaw: fn(),
    masterOrder: { findUnique: fn() },
    handoverEntry: { groupBy: fn(), create: fn() },
  };
  return {
    trace,
    tx,
    prisma: {
      masterOrder: { findUnique: fn() },
      handoverEntry: { groupBy: fn(), create: fn() },
      plan: { upsert: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    requirePerm: vi.fn(),
    getPlanWindows: vi.fn(),
    getSettings: vi.fn(),
    mirrorLedgerToOdoo: vi.fn(),
    emitEvent: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm }));
vi.mock("@/lib/server/data", () => ({ getPlanWindows: h.getPlanWindows, getSettings: h.getSettings }));
vi.mock("@/lib/server/odooMirror", () => ({ mirrorLedgerToOdoo: h.mirrorLedgerToOdoo }));
vi.mock("@/lib/server/events", () => ({ emitEvent: h.emitEvent }));

import { recordLvGroupTotal, recordLvOutput, recordLvTotal } from "@/app/lv/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const clerk = { id: 3, name: "Clerk", isAdmin: false, perms: "lv.bending" };

/** The ledger's all-time totals per stage, as groupBy hands them back. */
function ledger(by: Record<string, number>) {
  return Object.entries(by).map(([dept, qty]) => ({ dept, _sum: { qty } }));
}

/** The SQL of a $executeRaw tagged-template call, with its values in place. */
function sqlOf(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ""), "");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.trace.length = 0;
  h.requirePerm.mockResolvedValue({ user: clerk });
  h.getPlanWindows.mockResolvedValue([]);
  h.getSettings.mockResolvedValue({ leadCut: 0 });
  h.prisma.plan.upsert.mockResolvedValue({ planNo: 0 });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.tx) => Promise<unknown>) => fn(h.tx));
  h.tx.$executeRaw.mockImplementation(async (...call: unknown[]) => { h.trace.push(`lock ${sqlOf(call)}`); return 1; });
  h.tx.masterOrder.findUnique.mockImplementation(async ({ where }: { where: { mo: string } }) => { h.trace.push(`order ${where.mo}`); return { bom: "LVB", planQty: 10, line: "LV" }; });
  h.tx.handoverEntry.groupBy.mockImplementation(async ({ where }: { where: { mo: string } }) => { h.trace.push(`ledger ${where.mo}`); return ledger({ Punching: 4 }); });
  h.tx.handoverEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { h.trace.push(`write ${data.mo} ${data.dept} ${data.qty}`); return { id: 1, ...data }; });
  h.mirrorLedgerToOdoo.mockResolvedValue(undefined);
  h.emitEvent.mockResolvedValue(undefined);
});

describe("recordLvOutput — a stage's worklist recording a quantity", () => {
  it("locks the order, then reads its totals, then writes — all through the transaction", async () => {
    const res = await recordLvOutput(form({ stage: "Bending", mo: "P-100", qty: "4", date: "2026-10-20" }));
    expect(res).toEqual({ ok: true });
    expect(h.trace[0]).toBe("lock SELECT pg_advisory_xact_lock(52613::int, hashtext(P-100)::int)");
    expect(h.trace.slice(1, 3).sort()).toEqual(["ledger P-100", "order P-100"]);
    expect(h.trace[3]).toBe("write P-100 Bending 4");
    // nothing read or written outside the transaction
    expect(h.prisma.masterOrder.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
  });

  it("refuses inside the transaction what the stage before has not finished, and writes nothing", async () => {
    // a second clerk got there first: the lock lifts on a ledger with 4 bent
    h.tx.handoverEntry.groupBy.mockResolvedValue(ledger({ Punching: 4, Bending: 4 }));
    const res = await recordLvOutput(form({ stage: "Bending", mo: "P-100", qty: "4", date: "2026-10-20" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Chain check: P-100 would have 8 bent but only 4 punched/);
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.handoverEntry.create).not.toHaveBeenCalled();
    expect(h.mirrorLedgerToOdoo).not.toHaveBeenCalled();
    expect(h.emitEvent).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("names an order that is not a panel order, in the same words as before", async () => {
    h.tx.masterOrder.findUnique.mockResolvedValue({ bom: "TR", planQty: 10, line: "TR" });
    const res = await recordLvOutput(form({ stage: "Bending", mo: "T-1", qty: "1", date: "2026-10-20" }));
    expect(res).toEqual({ ok: false, error: "T-1 is not an LV panel order — refresh the page." });
    expect(h.tx.handoverEntry.create).not.toHaveBeenCalled();
  });
});

describe("recordLvTotal — a tracker cell's new total", () => {
  it("judges the stale check and the chain against the totals read under the lock", async () => {
    const res = await recordLvTotal(form({ stage: "Bending", mo: "P-100", total: "4", base: "0" }));
    expect(res).toEqual({ ok: true });
    expect(h.trace[0]).toMatch(/^lock SELECT pg_advisory_xact_lock\(52613::int, hashtext\(P-100\)::int\)$/);
    expect(h.trace.at(-1)).toBe("write P-100 Bending 4");
    expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
  });

  it("refuses a total typed over a figure that moved meanwhile, and writes nothing", async () => {
    h.tx.handoverEntry.groupBy.mockResolvedValue(ledger({ Punching: 4, Bending: 2 }));
    const res = await recordLvTotal(form({ stage: "Bending", mo: "P-100", total: "4", base: "0" }));
    expect(res).toEqual({ ok: false, error: "This figure is now 2, not the 0 on your screen — someone recorded meanwhile. Refresh the page and type the total again." });
    expect(h.tx.handoverEntry.create).not.toHaveBeenCalled();
  });

  it("says when nothing changed, and when the chain refuses, without writing", async () => {
    h.tx.handoverEntry.groupBy.mockResolvedValue(ledger({ Punching: 4, Bending: 4 }));
    expect(await recordLvTotal(form({ stage: "Bending", mo: "P-100", total: "4" }))).toEqual({ ok: false, error: "Nothing changed — the total is already 4." });
    const over = await recordLvTotal(form({ stage: "Bending", mo: "P-100", total: "6" }));
    expect(over.error).toMatch(/^Chain check: P-100 would have 6 bent but only 4 punched/);
    expect(h.tx.handoverEntry.create).not.toHaveBeenCalled();
  });
});

describe("recordLvGroupTotal — a merged row's total over its MOs", () => {
  it("takes every MO's lock in sorted order before reading any of them", async () => {
    h.tx.handoverEntry.groupBy.mockImplementation(async ({ where }: { where: { mo: string } }) => { h.trace.push(`ledger ${where.mo}`); return ledger({ Punching: 5 }); });
    const res = await recordLvGroupTotal(form({ stage: "Bending", bom: "LVB", mos: "P-200,P-100", total: "7" }));
    expect(res).toEqual({ ok: true });
    const locks = h.trace.filter((t) => t.startsWith("lock "));
    expect(locks).toEqual([
      "lock SELECT pg_advisory_xact_lock(52613::int, hashtext(P-100)::int)",
      "lock SELECT pg_advisory_xact_lock(52613::int, hashtext(P-200)::int)",
    ]);
    const firstRead = h.trace.findIndex((t) => t.startsWith("order ") || t.startsWith("ledger "));
    expect(firstRead).toBe(2);
    // spread in the order shown: P-200 fills its 5 first, P-100 takes the other 2
    expect(h.trace.filter((t) => t.startsWith("write "))).toEqual(["write P-200 Bending 5", "write P-100 Bending 2"]);
    expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
  });

  it("refuses the whole group inside the transaction when it no longer fits, and writes nothing", async () => {
    h.tx.handoverEntry.groupBy.mockResolvedValue(ledger({ Punching: 4, Bending: 4 }));
    const res = await recordLvGroupTotal(form({ stage: "Bending", bom: "LVB", mos: "P-100,P-200", total: "9" }));
    expect(res).toEqual({ ok: false, error: "Only 8 fit — the 2 MOs have no more room at bending (the stage before it, or the order quantity, is the limit)." });
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(h.tx.handoverEntry.create).not.toHaveBeenCalled();
    expect(h.mirrorLedgerToOdoo).not.toHaveBeenCalled();
  });

  it("refuses a group whose MO left the BOM, in the same words as before", async () => {
    h.tx.masterOrder.findUnique.mockResolvedValue({ bom: "OTHER", planQty: 10, line: "LV" });
    const res = await recordLvGroupTotal(form({ stage: "Bending", bom: "LVB", mos: "P-100", total: "9" }));
    expect(res).toEqual({ ok: false, error: "An MO in the group is no longer on this BOM — refresh the page." });
    expect(h.tx.handoverEntry.create).not.toHaveBeenCalled();
  });
});
