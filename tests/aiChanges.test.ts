import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's changes from proposal to record (lib/server/ai/changes.ts),
// against an in-memory AiAction table and a fake write tool whose "data" is
// one number — enough to see what runs, as whom, and what is refused.

type Row = Record<string, unknown> & { id: number };

const h = vi.hoisted(() => {
  const rows: Row[] = [];
  let nextId = 1;
  const settings = { actionsPaused: false };
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as { in?: unknown[]; lt?: Date };
        if (o.in) return o.in.includes(r[k]);
        if (o.lt) return r[k] instanceof Date && (r[k] as Date) < o.lt;
        return false;
      }
      return r[k] === v;
    });
  const defaults = { conversationId: null, toolUseId: null, automationId: null, snapshot: null, status: "proposed", auto: false, expiresAt: null, decidedAt: null, executedAt: null, result: null, error: null, undo: null, undoOfId: null, undoneAt: null, reportedAt: null };
  return {
    rows,
    settings,
    reset() {
      rows.length = 0;
      nextId = 1;
      settings.actionsPaused = false;
    },
    prisma: {
      aiAction: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const r = { ...defaults, ...data, id: nextId++, createdAt: new Date() } as Row;
          rows.push(r);
          return { ...r };
        }),
        update: vi.fn(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
          const r = rows.find((x) => x.id === where.id)!;
          Object.assign(r, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
          return { ...r };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = rows.filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        }),
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const r = rows.find((x) => matches(x, where));
          return r ? { ...r } : null;
        }),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((x) => matches(x, where)).map((r) => ({ ...r }))),
      },
      aiSettings: { findUnique: vi.fn(async () => ({ ...settings })) },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({
  hasPerm: (u: { perms: string }, k: string) => u.perms.split(",").includes(k),
  hiddenTabsOf: () => new Set<string>(),
}));
vi.mock("@/lib/server/ai/reader", () => ({ runAiQuery: vi.fn() }));

import type { User } from "@prisma/client";
import { currentActor } from "@/lib/server/actor";
import type { AnyWriteTool, ToolCtx } from "@/lib/server/ai/tools/types";

const data = { qty: 40 };
const ranAs: string[] = [];
const setQty: AnyWriteTool = {
  kind: "write",
  name: "set_qty",
  title: "Set the quantity",
  description: "",
  area: "tracker",
  risk: (i: { qty: number }) => (i.qty === 0 ? "destructive" : "low"),
  schema: { type: "object", properties: { qty: { type: "integer", minimum: 0 } }, required: ["qty"], additionalProperties: false },
  async describe(i: { qty: number }) {
    if (i.qty === data.qty) return { error: `It is ${data.qty} already.` };
    return { title: `Quantity → ${i.qty}`, summary: `Set the quantity from ${data.qty} to ${i.qty}.`, changes: [{ label: "qty", before: String(data.qty), after: String(i.qty) }], snapshot: { qty: data.qty } };
  },
  async execute(i: { qty: number }) {
    ranAs.push(currentActor()?.user.name ?? "(nobody)");
    const before = data.qty;
    data.qty = i.qty;
    return { ok: true, message: `Set to ${i.qty}.`, undo: { tool: "set_qty", input: { qty: before } } };
  },
};

vi.mock("@/lib/server/ai/tools", async (orig) => {
  const real = await orig<typeof import("@/lib/server/ai/tools")>();
  return { ...real, writeToolNamed: (n: string) => (n === "set_qty" ? setQty : undefined) };
});

import { approveAction, handleWriteCall, rejectAction, undoAction } from "@/lib/server/ai/changes";

const user = (perms: string): User => ({ id: 7, name: "Sara", perms, isAdmin: false, isOwner: false } as User);
const ctx = (u: User): ToolCtx => ({ user: u, hidden: new Set(), now: new Date(), todayISO: "2026-10-12", conversationId: 3, automationId: null });
const ASKS = user("ai.act.tracker,ai.act.delete");
const AUTO = user("ai.act.tracker,ai.act.noconfirm");

beforeEach(() => {
  h.reset();
  data.qty = 40;
  ranAs.length = 0;
});

describe("a write tool call", () => {
  it("is prepared as a proposal and changes nothing until approved", async () => {
    const r = await handleWriteCall(setQty, { qty: 36 }, ctx(ASKS), { toolUseId: "t1", settings: h.settings });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("NOT done");
    expect(r.view).toMatchObject({ status: "proposed", toolUseId: "t1", summary: "Set the quantity from 40 to 36.", risk: "low" });
    expect(data.qty).toBe(40);
    expect(h.rows[0].expiresAt).toBeInstanceOf(Date);
  });

  it("runs at once only when small and the person opted into that — as them, marked as the assistant", async () => {
    const r = await handleWriteCall(setQty, { qty: 36 }, ctx(AUTO), { toolUseId: "t1", settings: h.settings });
    expect(r.view).toMatchObject({ status: "executed", auto: true, canUndo: true });
    expect(data.qty).toBe(36);
    expect(ranAs).toEqual(["Sara (AI)"]);
  });

  it("never runs a deletion unasked, and offers none without the deletions key", async () => {
    const auto = await handleWriteCall(setQty, { qty: 0 }, ctx(user("ai.act.tracker,ai.act.noconfirm,ai.act.delete")), { toolUseId: "t1", settings: h.settings });
    expect(auto.view?.status).toBe("proposed");
    const none = await handleWriteCall(setQty, { qty: 0 }, ctx(AUTO), { toolUseId: "t2", settings: h.settings });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("may not delete");
  });

  it("is refused without the area's key, with bad input, while paused, or when describe says no", async () => {
    expect((await handleWriteCall(setQty, { qty: 36 }, ctx(user("")), { toolUseId: null, settings: h.settings })).text).toContain("has not been given");
    expect((await handleWriteCall(setQty, { qty: "x" }, ctx(ASKS), { toolUseId: null, settings: h.settings })).text).toContain("qty: must be a number");
    expect((await handleWriteCall(setQty, { qty: 40 }, ctx(ASKS), { toolUseId: null, settings: h.settings })).text).toBe("It is 40 already.");
    expect((await handleWriteCall(setQty, { qty: 36 }, ctx(ASKS), { toolUseId: null, settings: { actionsPaused: true } })).text).toContain("paused");
    expect(h.rows).toHaveLength(0);
  });
});

describe("an approval", () => {
  const propose = async (qty = 36) => (await handleWriteCall(setQty, { qty }, ctx(ASKS), { toolUseId: "t1", settings: h.settings })).view!.id;

  it("runs the change as the person and keeps how to undo it", async () => {
    const id = await propose();
    const r = await approveAction(id, ASKS);
    expect(r).toMatchObject({ ok: true, view: { status: "executed", result: "Set to 36.", canUndo: true } });
    expect(data.qty).toBe(36);
    expect(ranAs).toEqual(["Sara (AI)"]);
  });

  it("does not run it when the data moved after the proposal", async () => {
    const id = await propose();
    data.qty = 38; // someone changed it by hand meanwhile
    const r = await approveAction(id, ASKS);
    expect(r.ok).toBe(false);
    expect(r.view?.status).toBe("stale");
    expect(data.qty).toBe(38);
    expect(ranAs).toEqual([]);
  });

  it("runs once only, and not for anyone else", async () => {
    const id = await propose();
    await approveAction(id, ASKS);
    const again = await approveAction(id, ASKS);
    expect(again).toMatchObject({ ok: false, error: "It was done already." });
    const other = await approveAction(id, { ...ASKS, id: 8 } as User);
    expect(other.ok).toBe(false);
    expect(ranAs).toHaveLength(1);
  });

  it("is refused once expired, or while the owner has paused the assistant's changes", async () => {
    const id = await propose();
    h.settings.actionsPaused = true;
    expect((await approveAction(id, ASKS)).error).toContain("paused");
    h.settings.actionsPaused = false;
    h.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect((await approveAction(id, ASKS)).view?.status).toBe("expired");
    expect(data.qty).toBe(40);
  });

  it("can be a no instead", async () => {
    const id = await propose();
    expect((await rejectAction(id, ASKS)).view?.status).toBe("rejected");
    expect((await approveAction(id, ASKS)).error).toBe("It was rejected already.");
  });
});

describe("an undo", () => {
  it("puts the change back while nothing changed after it", async () => {
    const id = (await handleWriteCall(setQty, { qty: 36 }, ctx(AUTO), { toolUseId: "t1", settings: h.settings })).view!.id;
    const r = await undoAction(id, AUTO);
    expect(r).toMatchObject({ ok: true, view: { status: "undone", canUndo: false }, undoView: { status: "executed", title: "Undo: Quantity → 36" } });
    expect(data.qty).toBe(40);
  });

  it("refuses when someone changed the data after the assistant", async () => {
    const id = (await handleWriteCall(setQty, { qty: 36 }, ctx(AUTO), { toolUseId: "t1", settings: h.settings })).view!.id;
    data.qty = 30;
    const r = await undoAction(id, AUTO);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("changed again");
    expect(data.qty).toBe(30);
  });
});
