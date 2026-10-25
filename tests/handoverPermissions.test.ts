import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- who may touch a panel's rows on the Daily log --------------------------
// A panel's ledger rows carry the item PNL; its type (USS / LSS) sits on the
// order. The row guard used to look for USS/LSS on the row, so every panel row
// fell through to the transformer keys: a transformer supervisor could edit and
// delete the panels' log, and the LV clerk holding only the LV keys could not.
// These drive the real actions through the REAL guard — requirePerm, the
// session, the account's ticks — with only the cookie jar and the database
// standing in.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      session: { findUnique: fn() },
      handoverEntry: { findUnique: fn(), findMany: fn(), updateMany: fn() },
      masterOrder: { findUnique: fn() },
      plan: { findUnique: fn() },
      returnEntry: { findMany: fn(), findFirst: fn() },
      $transaction: fn(),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "session-token" }) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: async () => null, recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/tanks", () => ({ syncTanksToLedgerQty: async () => ({}), syncTanksToLedgerDate: async () => ({ redated: 0 }) }));
vi.mock("@/lib/server/odooMirror", () => ({ mirrorLedgerToOdoo: async () => {}, syncMirroredOdoo: async () => {} }));
vi.mock("@/lib/server/handover", () => ({ getKnownBoms: async () => [] }));
vi.mock("@/lib/server/importHandover", () => ({ importHandoverFile: vi.fn() }));

import { addHandover, bulkDeleteHandover, bulkSetHandoverDate, deleteHandover, updateHandover } from "@/app/handover/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Signed in as an account holding exactly these keys — no admin, no owner. */
function holding(...keys: string[]) {
  h.prisma.session.findUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 86_400_000),
    user: { id: 1, name: "tester", isAdmin: false, isOwner: false, perms: keys.join(","), hiddenTabs: "", active: true },
  });
}

const NO = { ok: false, error: "You do not have permission for this action — ask the admin." };

/** A panel's row on the log, at one stage. */
const panelRow = (dept: string, id = 7) => ({ id, date: new Date("2026-10-05"), dept, bom: "FG-LV-1", mo: "MO-LV", item: "PNL", qty: 4, note: null, planNo: 1 });

/** Every ledger write the actions made, in order. */
const writes: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) =>
    body({
      handoverEntry: {
        create: async () => { writes.push("create"); return { id: 99 }; },
        update: async () => { writes.push("update"); },
        delete: async () => { writes.push("delete"); },
        deleteMany: async () => { writes.push("deleteMany"); },
        updateMany: async () => { writes.push("updateMany"); return { count: 2 }; },
      },
      returnEntry: { deleteMany: async () => ({ count: 0 }) },
    })
  );
  h.prisma.handoverEntry.updateMany.mockImplementation(async () => { writes.push("updateMany"); return { count: 2 }; });
  // none of these rows is a return's
  h.prisma.returnEntry.findMany.mockResolvedValue([]);
});

describe("a panel's row on the Daily log follows the LV keys", () => {
  it.each([
    // the stage, its LV key, and the transformer key that must not open it —
    // the fabrication bay's for the panel's own fabrication stages
    ["Punching", "lv.punching", "cut.edit"],
    ["Bending", "lv.bending", "cut.edit"],
    ["Welding", "lv.welding", "welding.edit"],
    ["Painting", "lv.painting", "painting.edit"],
    ["Delivered", "lv.tracker.delivered", "tracker.delivered"],
  ])("%s: edited and deleted with %s, not with %s", async (dept, lvKey, trKey) => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(panelRow(dept));

    holding(trKey);
    expect(await updateHandover(form({ id: "7", qty: "3" }))).toEqual(NO);
    expect(await deleteHandover(form({ id: "7" }))).toEqual(NO);
    expect(writes).toEqual([]);

    holding(lvKey);
    expect(await updateHandover(form({ id: "7", qty: "3" }))).toEqual({ ok: true });
    expect(await deleteHandover(form({ id: "7" }))).toEqual({ ok: true });
    expect(writes).toEqual(["update", "delete"]);
  });

  it("is edited by the piece — a fraction of a panel is refused before any write", async () => {
    // every other LV write path insists on whole panels; the Daily log's edit
    // used to let 2.5 through, and the Bending worklist then waited on half a panel
    h.prisma.handoverEntry.findUnique.mockResolvedValue(panelRow("Punching"));
    holding("lv.punching");
    expect(await updateHandover(form({ id: "7", qty: "2.5" }))).toEqual({ ok: false, error: "Panels are recorded by the piece — enter a whole number." });
    expect(writes).toEqual([]);
    expect(await updateHandover(form({ id: "7", qty: "2" }))).toEqual({ ok: true });
    expect(writes).toEqual(["update"]);
  });

  it("is added with the LV stage's key, not the transformer department's", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue({ bom: "FG-LV-1", line: "LV" });
    h.prisma.plan.findUnique.mockResolvedValue({ planNo: 1 });
    const add = () => addHandover(form({ date: "2026-10-05", dept: "Welding", item: "PNL", mo: "MO-LV", qty: "2", planNo: "1" }));
    holding("welding.edit");
    expect(await add()).toEqual(NO);
    holding("lv.welding");
    expect(await add()).toEqual({ ok: true });
    expect(writes).toEqual(["create"]);
  });

  it("is re-dated and deleted in bulk only with the LV key of every stage selected", async () => {
    h.prisma.handoverEntry.findMany.mockResolvedValue([panelRow("Welding", 7), panelRow("Painting", 8)]);
    const selection = form({ ids: "7,8", date: "2026-10-06" });
    for (const keys of [["welding.edit", "painting.edit"], ["lv.welding"]]) {
      holding(...keys);
      expect(await bulkSetHandoverDate(selection), keys.join()).toEqual(NO);
      expect(await bulkDeleteHandover(selection), keys.join()).toEqual(NO);
    }
    expect(writes).toEqual([]);
    holding("lv.welding", "lv.painting");
    expect(await bulkSetHandoverDate(selection)).toEqual({ ok: true, updated: 2 });
    expect(await bulkDeleteHandover(selection)).toEqual({ ok: true, deleted: 2 });
    // re-dating groups the rows by their resulting note (both carry none here), so one write
    expect(writes).toEqual(["updateMany", "deleteMany"]);
  });
});

describe("a transformer's row stays on the transformer keys", () => {
  it("is edited and deleted with its department's key, not the LV stage's", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue({ ...panelRow("Welding"), bom: "25301", mo: "MO/1", item: "TN" });
    holding("lv.welding");
    expect(await updateHandover(form({ id: "7", qty: "3" }))).toEqual(NO);
    expect(await deleteHandover(form({ id: "7" }))).toEqual(NO);
    holding("welding.edit");
    expect(await updateHandover(form({ id: "7", qty: "3" }))).toEqual({ ok: true });
    expect(await deleteHandover(form({ id: "7" }))).toEqual({ ok: true });
    expect(writes).toEqual(["update", "delete"]);
  });
});

describe("the two finishing stages on the Daily log form", () => {
  it("refuses painting the core frame — it is shot blasted — before any write", async () => {
    holding("painting.edit");
    expect(await addHandover(form({ date: "2026-10-05", dept: "Painting", bom: "T-1", item: "CF", qty: "2", planNo: "1" }))).toEqual({ ok: false, error: "CF is shot blasted, not painted — record it on the SHB cell." });
    expect(writes).toEqual([]);
  });
});
