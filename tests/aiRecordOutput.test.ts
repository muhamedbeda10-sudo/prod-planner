import { beforeEach, describe, expect, it, vi } from "vitest";

// record_output — the figures taken off a production sheet (or a photo of
// one) into the Daily log, through the worklists' own recording: each row's
// own key, the dates a sheet can carry, the order's BOM, who welded a tank,
// the chain for everything the batch adds, the stages in order, and the
// undo deleting just the rows it made — against a stubbed database.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { masterOrder: { findUnique: fn() }, handoverEntry: { findFirst: fn(), aggregate: fn() } },
    perms: new Set<string>(),
    tankTracking: false,
    chain: fn(),
    recordOutput: fn(),
    resolveWelder: fn(),
    planFor: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.chain, recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/data", () => ({ getSettings: async () => ({ tankTracking: h.tankTracking }), getPlanWindows: async () => [{ planNo: 40 }, { planNo: 41 }] }));
vi.mock("@/lib/server/handover", () => ({ getDefaultPlanForDate: h.planFor }));
vi.mock("@/lib/server/workers", () => ({ resolveWorkerByEmpId: h.resolveWelder }));
vi.mock("@/app/worklist/actions", () => ({ recordOutput: h.recordOutput }));
vi.mock("@/app/handover/actions", () => ({ bulkDeleteHandover: vi.fn(), bulkSetHandoverDate: vi.fn(), updateHandover: vi.fn() }));

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { recordOutputTool } from "@/lib/server/ai/tools/dailyLog";
import { checkToolInput } from "@/lib/server/ai/tools";

const ctx: ToolCtx = { user: { id: 1, name: "Sara" } as User, hidden: new Set(), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 1, automationId: null };
type Input = Parameters<typeof recordOutputTool.describe>[0];
const parsed = (raw: unknown): Input => {
  const c = checkToolInput<Input>(recordOutputTool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};
const ORDERS: Record<string, { bom: string; line: string }> = { "SF01/MO/1": { bom: "T-1000", line: "TR" }, "SF01/MO/9": { bom: "P-12", line: "LV" } };
const fdOf = (call: number) => Object.fromEntries((h.recordOutput.mock.calls[call][0] as FormData).entries());

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.tankTracking = false;
  h.prisma.masterOrder.findUnique.mockImplementation(async ({ where }: { where: { mo: string } }) => ORDERS[where.mo] ?? null);
  h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 6 } });
  h.chain.mockResolvedValue(null);
  h.planFor.mockResolvedValue(41);
  let id = 500;
  h.recordOutput.mockImplementation(async () => ({ ok: true, ledgerId: ++id }));
});

describe("record_output", () => {
  it("names the order's MO or BOM on every row, and lists a row once", () => {
    expect(checkToolInput(recordOutputTool, { rows: [{ date: "2026-10-11", dept: "Welding", item: "TN", qty: 2 }] })).toMatchObject({ ok: false, error: expect.stringContaining("Name the MO") });
    const twice = { date: "2026-10-11", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 2 };
    expect(checkToolInput(recordOutputTool, { rows: [twice, { ...twice, mo: "sf01/mo/1" }] })).toMatchObject({ ok: false, error: expect.stringContaining("listed twice") });
  });

  it("records with each row's own key, never a future day or one far back", async () => {
    const input = parsed({ rows: [{ date: "2026-10-11", dept: "Welding", mo: "sf01/mo/1", item: "TN", qty: 2 }] });
    expect(await recordOutputTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("permission to record Welding output") });
    h.perms.add("welding.edit");
    expect(await recordOutputTool.describe(parsed({ rows: [{ date: "2026-10-13", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 2 }] }), ctx)).toEqual({ error: expect.stringContaining("has not come yet") });
    expect(await recordOutputTool.describe(parsed({ rows: [{ date: "2025-10-11", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 2 }] }), ctx)).toEqual({ error: expect.stringContaining("more than 62 days back") });
    expect(await recordOutputTool.describe(input, ctx)).toMatchObject({ changes: [{ label: "SF01/MO/1 TN Welding", before: "6", after: "8 (+2 on 2026-10-11)" }] });
  });

  it("refuses an MO it does not know, a panel recorded as a part, and a part on a panel order", async () => {
    h.perms.add("cut.edit").add("lv.punching");
    expect(await recordOutputTool.describe(parsed({ rows: [{ date: "2026-10-11", dept: "Cut", mo: "SF01/MO/77", item: "CF", qty: 1 }] }), ctx)).toEqual({ error: expect.stringContaining("not in the orders registry") });
    expect(await recordOutputTool.describe(parsed({ rows: [{ date: "2026-10-11", dept: "Cut", mo: "SF01/MO/9", item: "CF", qty: 1 }] }), ctx)).toEqual({ error: expect.stringContaining("an LV panel order") });
    expect(await recordOutputTool.describe(parsed({ rows: [{ date: "2026-10-11", dept: "Cut", mo: "SF01/MO/9", item: "PNL", qty: 1 }] }), ctx)).toEqual({ error: expect.stringContaining("Punching, Bending, Welding or Painting") });
    expect(await recordOutputTool.describe(parsed({ rows: [{ date: "2026-10-11", dept: "Punching", mo: "SF01/MO/9", item: "PNL", qty: 1.5 }] }), ctx)).toEqual({ error: expect.stringContaining("whole number") });
  });

  it("checks the chain once for all the batch adds to an order's stage", async () => {
    h.perms.add("welding.edit");
    h.chain.mockResolvedValueOnce("Welded would pass cut: SF01/MO/1 TN.");
    const input = parsed({ rows: [{ date: "2026-10-10", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 2 }, { date: "2026-10-11", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 3 }] });
    expect(await recordOutputTool.describe(input, ctx)).toEqual({ error: "Welded would pass cut: SF01/MO/1 TN." });
    expect(h.chain).toHaveBeenCalledWith({ dept: "Welding", bom: "T-1000", mo: "SF01/MO/1", item: "TN", qty: 5 });
  });

  it("names the welder of tanks while tanks are tracked, and never paints tanks as a quantity", async () => {
    h.perms.add("welding.edit").add("painting.edit");
    h.tankTracking = true;
    const weld = { date: "2026-10-11", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 2 };
    expect(await recordOutputTool.describe(parsed({ rows: [weld] }), ctx)).toEqual({ error: expect.stringContaining("welder's badge") });
    h.resolveWelder.mockResolvedValue({ error: "No worker has the ID 999." });
    expect(await recordOutputTool.describe(parsed({ rows: [{ ...weld, welder: "999" }] }), ctx)).toEqual({ error: expect.stringContaining("No worker has the ID 999.") });
    expect(await recordOutputTool.describe(parsed({ rows: [{ ...weld, dept: "Painting" }] }), ctx)).toEqual({ error: expect.stringContaining("tank by tank") });
    h.resolveWelder.mockResolvedValue({ worker: { id: 31 } });
    h.recordOutput.mockResolvedValueOnce({ ok: true, ledgerId: 900, serials: ["T-1000-0007", "T-1000-0008"] });
    const out = await recordOutputTool.execute(parsed({ rows: [{ ...weld, welder: "100058" }] }), ctx);
    expect(fdOf(0)).toMatchObject({ workerId: "31", qty: "2" });
    expect(out.message).toContain("T-1000-0007, T-1000-0008");
  });

  it("records the stages in order on the plan of their day, and is undone by deleting just those rows", async () => {
    h.perms.add("cut.edit").add("welding.edit");
    h.planFor.mockImplementation(async (d: Date) => (d.toISOString().startsWith("2026-10-10") ? null : 41));
    const out = await recordOutputTool.execute(parsed({ rows: [
      { date: "2026-10-11", dept: "Welding", mo: "SF01/MO/1", item: "TN", qty: 2 },
      { date: "2026-10-10", dept: "Cut", mo: "SF01/MO/1", item: "TN", qty: 4 },
    ] }), ctx);
    expect([fdOf(0).dept, fdOf(1).dept]).toEqual(["Cut", "Welding"]);
    // a day no plan covers goes to the newest plan
    expect([fdOf(0).planNo, fdOf(1).planNo]).toEqual(["41", "41"]);
    expect(fdOf(0)).toMatchObject({ date: "2026-10-10", bom: "T-1000", mo: "SF01/MO/1", item: "TN", qty: "4" });
    expect(out).toEqual({ ok: true, message: "Recorded 2 row(s) in the Daily log.", undo: { tool: "delete_log_entries", input: { ids: [501, 502] } } });
  });

  it("stops at the first row the worklist refuses, keeping the undo of what it did", async () => {
    h.perms.add("cut.edit");
    h.recordOutput.mockResolvedValueOnce({ ok: true, ledgerId: 700 }).mockResolvedValueOnce({ ok: false, error: "Cut would pass the order." });
    const out = await recordOutputTool.execute(parsed({ rows: [
      { date: "2026-10-11", dept: "Cut", mo: "SF01/MO/1", item: "TN", qty: 2 },
      { date: "2026-10-11", dept: "Cut", mo: "SF01/MO/1", item: "CF", qty: 2 },
    ] }), ctx);
    expect(out).toEqual({ ok: true, message: expect.stringContaining("Recorded 1 of 2 row(s) — stopped at SF01/MO/1 CF Cut 2026-10-11: Cut would pass the order."), undo: { tool: "delete_log_entries", input: { ids: [700] } } });
  });
});

describe("record_output — the two finishing stages", () => {
  it("refuses painting the core frame, as the worklists do", async () => {
    h.perms.add("painting.edit");
    const i = parsed({ rows: [{ date: "2026-10-12", dept: "Painting", mo: "SF01/MO/1", item: "CF", qty: 2 }] });
    expect(await recordOutputTool.describe(i, ctx)).toEqual({ error: expect.stringContaining("CF is shot blasted, not painted") });
  });
});
