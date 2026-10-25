import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's worklist tools (lib/server/ai/tools/worklists.ts): the
// fabrication worklist's dates, lines taken off a worklist, the notes on a
// queue line (photos from the chat), and pieces sent back upstream — what each
// card says, which of the worklist's own actions it runs with what, and how it
// is undone — against a stubbed database, worklist and actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findUnique: fn() },
      worklistLineHide: { count: fn() },
      handoverEntry: { groupBy: fn(), findUnique: fn(), findFirst: fn() },
      planSchedule: { findFirst: fn() },
    },
    perms: new Set<string>(),
    settings: { tankTracking: false },
    sheet: null as unknown,
    files: new Map<number, unknown>(),
    snaps: {
      readQueueNote: fn(), restoreQueueNote: fn(), readReturn: fn(), cancelReturn: fn(), reopenReturn: fn(), readWorklistDates: fn(), restoreWorklistDates: fn(),
    },
    actions: {
      addQueueNote: fn(), updateQueueNote: fn(), setQueueNoteStatus: fn(), deleteQueueNote: fn(), setWorklistDate: fn(), clearWorklistDate: fn(),
      hideWorklistLine: fn(), unhideWorklistLine: fn(), returnToUpstream: fn(), redeliverReturn: fn(),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/data", () => ({ getSettings: async () => h.settings }));
vi.mock("@/lib/server/execution", () => ({ getCutSheet: async () => h.sheet }));
vi.mock("@/lib/server/ai/files", () => ({
  chatFile: async (_ctx: unknown, id: number) => h.files.get(id) ?? { error: `No file #${id} in this chat — the person attaches it with the paperclip.` },
  uploadOf: (f: { name: string; type: string }) => new File([new Uint8Array([1, 2, 3])], f.name, { type: f.type }),
}));
vi.mock("@/lib/server/rowSnapshots", () => h.snaps);
vi.mock("@/app/worklist/actions", () => h.actions);

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import type { QueueNoteSnapshot, ReturnSnapshot, WorklistDateSnapshot } from "@/lib/server/rowSnapshots";
import {
  addQueueNoteTool, clearWorklistDateTool, deleteQueueNoteTool, getCutWorklistTool, hideWorklistLineTool, redeliverReturnTool, restoreQueueNoteTool,
  restoreWorklistDatesTool, returnToUpstreamTool, setQueueNoteStatusTool, setWorklistDateTool, unhideWorklistLineTool, updateQueueNoteTool,
} from "@/lib/server/ai/tools/worklists";
import { checkToolInput, riskOf, toolsFor } from "@/lib/server/ai/tools";

const sara = { id: 1, name: "Sara", isAdmin: false, isOwner: false } as User;
const admin = { ...sara, isAdmin: true } as User;
const ctx = (user: User = sara, hidden: string[] = []): ToolCtx => ({ user, hidden: new Set(hidden), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 4, automationId: null });

const parsed = <I>(tool: Parameters<typeof checkToolInput<I>>[0], raw: unknown): I => {
  const c = checkToolInput<I>(tool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};
const fd = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());

const tranche = (o: Record<string, unknown> = {}) => ({ bom: "B1", mo: "M1", description: "", item: "CF", deliveryISO: "2026-10-14", cutDueISO: "2026-10-12", qty: 10, remaining: 8, ...o });
const pool = (o: Record<string, unknown> = {}) => ({ bom: "B2", mo: "M2", description: "", item: "TC", target: 12, scheduled: 0, done: 2, available: 10, deliveryISO: null, ...o });
const dateRow = (o: Partial<WorklistDateSnapshot> = {}): WorklistDateSnapshot => ({ id: 5, origISO: "", newDate: "2026-10-20T00:00:00.000Z", qty: 4, baseDone: 2, createdBy: "Admin", createdAt: "2026-10-01T09:00:00.000Z", ...o });
const note = (o: Partial<QueueNoteSnapshot> = {}): QueueNoteSnapshot => ({ id: 30, bom: "B1", mo: "M1", item: "CF", dept: "Welding", text: "two holes missing", photos: null, status: "open", createdAt: "2026-10-11T10:00:00.000Z", ...o });
const ret = (o: Partial<ReturnSnapshot> = {}): ReturnSnapshot => ({
  id: 9, date: "2026-10-11T10:00:00.000Z", fromDept: "Welding", toDept: "Cut", bom: "B1", mo: "M1", item: "CF", qty: 3, reason: "burrs", status: "open", handoverId: 77, createdAt: "2026-10-11T10:00:00.000Z", ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.settings = { tankTracking: false };
  h.files.clear();
  h.sheet = {
    today: new Date("2026-10-12T08:00:00Z"),
    dueNow: [tranche()],
    overdue: [tranche({ item: "TC", deliveryISO: "2026-10-05", cutDueISO: "2026-10-03" })],
    postponed: [tranche({ item: "TN", deliveryISO: "2026-10-30", overrideOrigISO: "2026-10-09" })],
    pushed: [], remarked: [pool({ remark: "steel late" })], unscheduled: [pool({ mo: "M3", item: "CB", available: 6 })],
    priority: [], held: [], hidden: [{ dept: "Cut", bom: "B4", mo: "M4", item: "CF" }],
  };
  h.prisma.masterOrder.findUnique.mockImplementation(async ({ where }: { where: { mo: string } }) => ({ bom: where.mo === "M2" ? "B2" : "B1" }));
  h.prisma.worklistLineHide.count.mockResolvedValue(0);
  h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
  h.prisma.planSchedule.findFirst.mockResolvedValue(null);
  for (const f of Object.values(h.actions)) f.mockResolvedValue({ ok: true });
  h.snaps.readWorklistDates.mockResolvedValue([]);
  for (const f of [h.snaps.restoreQueueNote, h.snaps.cancelReturn, h.snaps.reopenReturn, h.snaps.restoreWorklistDates]) f.mockResolvedValue({ ok: true });
});

describe("get_cut_worklist", () => {
  it("gives each tranche the date set_worklist_date names it by, and the date-less lines with their pool", async () => {
    const out = JSON.parse((await getCutWorklistTool.run({}, ctx())).text);
    expect(out.today).toBe("2026-10-12");
    expect(out.dueToday.rows[0]).toMatchObject({ line: "M1 CF", delivery: "2026-10-14", remaining: 8, origISO: "2026-10-14" });
    // a postponed tranche is named by its ORIGINAL plan date
    expect(out.postponed.rows[0]).toMatchObject({ line: "M1 TN", delivery: "2026-10-30", origISO: "2026-10-09", redated: true });
    expect(out.remarked.rows[0]).toEqual({ line: "M2 TC", bom: "B2", mo: "M2", item: "TC", pool: 10, remark: "steel late" });
    expect(out.notDated.rows[0]).toMatchObject({ line: "M3 CB", pool: 6 });
    expect(out.hidden).toEqual([{ line: "M4 CF", bom: "B4", mo: "M4", item: "CF" }]);
    // a person who does not see the fabrication worklist is not read it
    expect(toolsFor(sara, { hidden: new Set(["worklist.cut"]), actionsPaused: false }).map((t) => t.name)).not.toContain("get_cut_worklist");
  });
});

describe("set_worklist_date", () => {
  it("knows a plan tranche from a date-less line's parts", () => {
    const base = { bom: "B1", mo: "M1", item: "CF", date: "2026-10-16" };
    expect(checkToolInput(setWorklistDateTool, { ...base, origISO: "2026-10-14", qty: 3 })).toMatchObject({ ok: false, error: expect.stringContaining("moves whole") });
    expect(checkToolInput(setWorklistDateTool, { ...base, origISO: "" })).toMatchObject({ ok: false, error: expect.stringContaining("one of them") });
    expect(checkToolInput(setWorklistDateTool, { ...base, origISO: "", qty: 3, fromISO: "2026-10-20" })).toMatchObject({ ok: false });
    expect(checkToolInput(setWorklistDateTool, { ...base, origISO: "14/10/2026" })).toMatchObject({ ok: false });
    expect(checkToolInput(setWorklistDateTool, { ...base, origISO: "2026-10-16" })).toMatchObject({ ok: false, error: expect.stringContaining("plan date already") });
  });

  it("is an admin's, on a tranche the worklist has", async () => {
    const i = parsed<Parameters<typeof setWorklistDateTool.describe>[0]>(setWorklistDateTool, { bom: "B1", mo: "M1", item: "TN", origISO: "2026-10-09", date: "2026-11-02" });
    expect(await setWorklistDateTool.describe(i, ctx())).toEqual({ error: "Only an admin re-dates or takes lines off the worklists." });
    expect(await setWorklistDateTool.describe(i, ctx(admin, ["worklist.cut"]))).toEqual({ error: expect.stringContaining("not opened for you") });
    expect(await setWorklistDateTool.describe({ ...i, origISO: "2026-10-01" }, ctx(admin))).toEqual({ error: expect.stringContaining("no open tranche promised for 2026-10-01") });
    h.snaps.readWorklistDates.mockResolvedValue([dateRow({ origISO: "2026-10-09", newDate: "2026-10-30T00:00:00.000Z", qty: null })]);
    const p = await setWorklistDateTool.describe(i, ctx(admin));
    expect(p).toMatchObject({
      summary: "Move M1 TN's tranche promised for 2026-10-09 (8 pcs open, now under 2026-10-30) to 2026-11-02.",
      changes: [{ before: "2026-10-09 → 2026-10-30", after: "2026-10-09 → 2026-11-02" }],
    });
  });

  it("schedules part of a date-less pool, no more than it holds, and is undone by the line's dates as they were", async () => {
    const i = parsed<Parameters<typeof setWorklistDateTool.describe>[0]>(setWorklistDateTool, { bom: "B2", mo: "M2", item: "TC", origISO: "", date: "2026-10-20", qty: 12 });
    expect(await setWorklistDateTool.describe(i, ctx(admin))).toEqual({ error: "M2 TC has 10 pcs not dated — not 12." });
    const before = [dateRow()];
    h.snaps.readWorklistDates.mockResolvedValue(before);
    // the same day again replaces that day's pieces — they count as room
    expect(await setWorklistDateTool.describe(i, ctx(admin))).toMatchObject({ summary: expect.stringContaining("replacing the 4 pcs there"), snapshot: before });
    const out = await setWorklistDateTool.execute(i, ctx(admin));
    expect(fd(h.actions.setWorklistDate)).toEqual({ bom: "B2", mo: "M2", item: "TC", origISO: "", date: "2026-10-20", qty: "12" });
    expect(out).toEqual({ ok: true, message: "M2 TC is dated 2026-10-20.", undo: { tool: "restore_worklist_dates", input: { bom: "B2", mo: "M2", item: "TC", rows: JSON.stringify(before) } } });
  });

  it("moves a scheduled part by its day", async () => {
    h.snaps.readWorklistDates.mockResolvedValue([dateRow()]);
    const i = parsed<Parameters<typeof setWorklistDateTool.describe>[0]>(setWorklistDateTool, { bom: "B2", mo: "M2", item: "TC", origISO: "", fromISO: "2026-10-19", date: "2026-10-21" });
    expect(await setWorklistDateTool.describe(i, ctx(admin))).toEqual({ error: "M2 TC has no part scheduled on 2026-10-19." });
    expect(await setWorklistDateTool.describe({ ...i, fromISO: "2026-10-20" }, ctx(admin))).toMatchObject({ summary: "Move the part of M2 TC scheduled on 2026-10-20 (4 pcs) to 2026-10-21." });
  });
});

describe("set_worklist_date — a quantity waits for the click", () => {
  it("a part scheduled by its pieces is high; a whole tranche moved or a part moved by its day is low", () => {
    expect(riskOf(setWorklistDateTool, { bom: "B2", mo: "M2", item: "TC", origISO: "", date: "2026-10-20", qty: 4 })).toBe("high");
    expect(riskOf(setWorklistDateTool, { bom: "B1", mo: "M1", item: "CF", origISO: "2026-10-14", date: "2026-10-20" })).toBe("low");
    expect(riskOf(setWorklistDateTool, { bom: "B2", mo: "M2", item: "TC", origISO: "", fromISO: "2026-10-20", date: "2026-10-21" })).toBe("low");
  });
});

describe("clear_worklist_date and its undo", () => {
  it("reverts what an admin dated, and the undo writes the line's dates back exactly", async () => {
    const before = [dateRow(), dateRow({ id: 6, newDate: "2026-10-22T00:00:00.000Z", qty: 2 })];
    h.snaps.readWorklistDates.mockResolvedValue(before);
    expect(await clearWorklistDateTool.describe({ bom: "B2", mo: "M2", item: "TC", origISO: "2026-10-09" }, ctx(admin))).toEqual({ error: expect.stringContaining("no such date") });
    expect(await clearWorklistDateTool.describe({ bom: "B2", mo: "M2", item: "TC", origISO: "" }, ctx(admin))).toMatchObject({ summary: "Put 2 scheduled parts of M2 TC back into its date-less pool." });
    const out = await clearWorklistDateTool.execute({ bom: "B2", mo: "M2", item: "TC", origISO: "", date: "2026-10-22" }, ctx(admin));
    expect(fd(h.actions.clearWorklistDate)).toEqual({ bom: "B2", mo: "M2", item: "TC", origISO: "", date: "2026-10-22" });
    const undo = (out as { undo: { tool: string; input: Record<string, unknown> } }).undo;
    expect(undo.tool).toBe("restore_worklist_dates");
    const u = parsed<Parameters<typeof restoreWorklistDatesTool.execute>[0]>(restoreWorklistDatesTool, undo.input);
    expect(await restoreWorklistDatesTool.describe(u, ctx())).toEqual({ error: "Only an admin re-dates or takes lines off the worklists." });
    await restoreWorklistDatesTool.execute(u, ctx(admin));
    expect(h.snaps.restoreWorklistDates).toHaveBeenCalledWith(u, before);
    expect(checkToolInput(restoreWorklistDatesTool, { bom: "B2", mo: "M2", item: "TC", rows: "[{\"id\":1}]" })).toMatchObject({ ok: false });
  });
});

describe("hide_worklist_line / unhide_worklist_line", () => {
  const line = { dept: "Welding" as const, bom: "B1", mo: "M1", item: "CF" };

  it("is an admin's, on a line of the registry, and each undoes the other", async () => {
    expect(await hideWorklistLineTool.describe(line, ctx())).toEqual({ error: "Only an admin re-dates or takes lines off the worklists." });
    expect(await hideWorklistLineTool.describe({ ...line, mo: "M2" }, ctx(admin))).toEqual({ error: "M2 is BOM B2, not B1." });
    expect(await hideWorklistLineTool.describe(line, ctx(admin))).toMatchObject({ title: "Take M1 CF off the Welding worklist" });
    expect(await unhideWorklistLineTool.describe(line, ctx(admin))).toEqual({ error: "M1 CF is on the Welding worklist already." });
    expect(await hideWorklistLineTool.execute(line, ctx(admin))).toEqual({ ok: true, message: "M1 CF is off the Welding worklist.", undo: { tool: "unhide_worklist_line", input: line } });
    expect(fd(h.actions.hideWorklistLine)).toEqual({ dept: "Welding", bom: "B1", mo: "M1", item: "CF" });
    h.prisma.worklistLineHide.count.mockResolvedValue(1);
    expect(await unhideWorklistLineTool.execute(line, ctx(admin))).toMatchObject({ undo: { tool: "hide_worklist_line", input: line } });
  });
});

describe("queue notes", () => {
  const photo = { id: 21, name: "weld.jpg", kind: "image", type: "image/jpeg", size: 2000, sha256: "abc" };

  it("needs the text or a photo, the department's key and its worklist in sight", async () => {
    expect(checkToolInput(addQueueNoteTool, { dept: "Welding", bom: "B1", item: "CF", text: "  " })).toMatchObject({ ok: false, error: "A note needs its text or a photo." });
    const i = parsed<Parameters<typeof addQueueNoteTool.describe>[0]>(addQueueNoteTool, { dept: "Welding", bom: "B1", mo: "M1", item: "CF", text: "two holes missing" });
    expect(await addQueueNoteTool.describe(i, ctx())).toEqual({ error: expect.stringContaining("Welding's worklist key") });
    h.perms.add("welding.edit");
    expect(await addQueueNoteTool.describe(i, ctx(sara, ["worklist.welding"]))).toEqual({ error: expect.stringContaining("not opened for you") });
    expect(await addQueueNoteTool.describe(i, ctx())).toMatchObject({ title: "📝 M1 CF on Welding", snapshot: { photos: [] } });
  });

  it("attaches the chat's photos, only photos, and is undone by deleting the note", async () => {
    h.perms.add("welding.edit");
    h.files.set(21, photo);
    h.files.set(22, { ...photo, id: 22, name: "plan.pdf", kind: "pdf", type: "application/pdf" });
    const i = parsed<Parameters<typeof addQueueNoteTool.describe>[0]>(addQueueNoteTool, { dept: "Welding", bom: "B1", mo: "M1", item: "CF", photos: [21, 22] });
    expect(await addQueueNoteTool.describe(i, ctx())).toEqual({ error: "File #22 (plan.pdf) is not a photo." });
    expect(await addQueueNoteTool.describe({ ...i, photos: [23] }, ctx())).toEqual({ error: expect.stringContaining("No file #23") });
    expect(await addQueueNoteTool.describe({ ...i, photos: [21] }, ctx())).toMatchObject({ summary: expect.stringContaining("with 1 photo(s) (weld.jpg)"), snapshot: { photos: ["abc"] } });
    h.actions.addQueueNote.mockResolvedValue({ ok: true, id: 31 });
    const out = await addQueueNoteTool.execute({ ...i, photos: [21] }, ctx());
    const sent = h.actions.addQueueNote.mock.calls[0][0] as FormData;
    expect(sent.get("dept")).toBe("Welding");
    expect((sent.getAll("photos") as File[]).map((f) => f.name)).toEqual(["weld.jpg"]);
    expect(out).toEqual({ ok: true, message: "The note is on M1 CF (Welding).", undo: { tool: "delete_queue_note", input: { id: 31 } } });
  });

  it("changes, resolves and deletes a note, each undone", async () => {
    h.perms.add("welding.edit");
    h.snaps.readQueueNote.mockResolvedValue(note());
    expect(await updateQueueNoteTool.describe({ id: 30, text: "" }, ctx())).toEqual({ error: expect.stringContaining("delete it instead") });
    expect(await updateQueueNoteTool.execute({ id: 30, text: "fixed?" }, ctx())).toMatchObject({ undo: { tool: "update_queue_note", input: { id: 30, text: "two holes missing" } } });
    expect(await setQueueNoteStatusTool.describe({ id: 30, status: "open" }, ctx())).toEqual({ error: "Note #30 is open already." });
    expect(await setQueueNoteStatusTool.execute({ id: 30, status: "resolved" }, ctx())).toMatchObject({ undo: { tool: "set_queue_note_status", input: { id: 30, status: "open" } } });
    h.snaps.readQueueNote.mockResolvedValue(note({ photos: JSON.stringify(["https://blob/1.jpg", "https://blob/2.jpg"]) }));
    expect(deleteQueueNoteTool.risk).toBe("destructive");
    expect(await deleteQueueNoteTool.describe({ id: 30 }, ctx())).toMatchObject({ summary: expect.stringContaining("its 2 photo(s) are deleted with it, for good") });
    const out = await deleteQueueNoteTool.execute({ id: 30 }, ctx());
    const undo = (out as { undo: { input: Record<string, unknown> } }).undo;
    const u = parsed<Parameters<typeof restoreQueueNoteTool.execute>[0]>(restoreQueueNoteTool, undo.input);
    h.snaps.readQueueNote.mockResolvedValue(null);
    expect(await restoreQueueNoteTool.describe(u, ctx())).toMatchObject({ summary: expect.stringContaining("without its photos") });
    await restoreQueueNoteTool.execute(u, ctx());
    expect(h.snaps.restoreQueueNote).toHaveBeenCalledWith(JSON.parse(u.state));
  });
});

describe("returns", () => {
  const raw = { fromDept: "Welding", bom: "B1", mo: "M1", item: "CF", qty: 3, reason: "burrs on the edges" };

  it("sends back only what waits in the queue, with the reason, and is undone by cancelling it", async () => {
    expect(checkToolInput(returnToUpstreamTool, { ...raw, reason: " " })).toMatchObject({ ok: false });
    const i = parsed<Parameters<typeof returnToUpstreamTool.describe>[0]>(returnToUpstreamTool, raw);
    h.perms.add("welding.edit");
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ dept: "Cut", _sum: { qty: 10 } }, { dept: "Welding", _sum: { qty: 8 } }]);
    expect(await returnToUpstreamTool.describe(i, ctx())).toEqual({ error: "Only 2 pcs of M1 CF wait in the Welding queue — cannot send back 3." });
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ dept: "Cut", _sum: { qty: 10 } }, { dept: "Welding", _sum: { qty: 4 } }]);
    expect(await returnToUpstreamTool.describe(i, ctx())).toMatchObject({ title: "↩ 3 × M1 CF back to Cut", changes: [{ label: "M1 CF Cut output", before: "10", after: "7" }] });
    h.actions.returnToUpstream.mockResolvedValue({ ok: true, id: 9, ledgerId: 77 });
    expect(await returnToUpstreamTool.execute(i, ctx())).toMatchObject({ undo: { tool: "cancel_return", input: { id: 9 } } });
    expect(fd(h.actions.returnToUpstream)).toEqual({ fromDept: "Welding", bom: "B1", mo: "M1", item: "CF", qty: "3", reason: "burrs on the edges" });
  });

  it("files the return under the order's own BOM, never a typed one", async () => {
    h.perms.add("welding.edit");
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ dept: "Cut", _sum: { qty: 10 } }, { dept: "Welding", _sum: { qty: 4 } }]);
    // M2 is BOM B2 in the registry
    expect(await returnToUpstreamTool.describe(parsed(returnToUpstreamTool, { ...raw, mo: "M2" }), ctx())).toEqual({ error: "M2 is on BOM B2, not B1." });
    // an MO the registry does not know is accepted only with the log's own rows on that BOM
    h.prisma.masterOrder.findUnique.mockResolvedValue(null);
    h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
    expect(await returnToUpstreamTool.describe(parsed(returnToUpstreamTool, { ...raw, mo: "M9" }), ctx())).toEqual({ error: "M9 is not in the orders registry or the log for B1." });
    h.prisma.handoverEntry.findFirst.mockResolvedValue({ id: 1 });
    expect(await returnToUpstreamTool.describe(parsed(returnToUpstreamTool, { ...raw, mo: "M9" }), ctx())).toMatchObject({ title: "↩ 3 × M9 CF back to Cut" });
  });

  it("sends a tank back by its serial while tanks are tracked", async () => {
    h.perms.add("painting.edit");
    h.settings = { tankTracking: true };
    const i = parsed<Parameters<typeof returnToUpstreamTool.describe>[0]>(returnToUpstreamTool, { ...raw, fromDept: "Painting", item: "TN" });
    expect(await returnToUpstreamTool.describe(i, ctx())).toEqual({ error: expect.stringContaining("send_tank_back_to_welding") });
  });

  it("re-delivers an open return with the upstream department's key, undone by opening it again", async () => {
    h.snaps.readReturn.mockResolvedValue(ret());
    h.perms.add("welding.edit");
    expect(await redeliverReturnTool.describe({ id: 9 }, ctx())).toEqual({ error: expect.stringContaining("Cut's worklist key") });
    h.perms.add("cut.edit");
    expect(await redeliverReturnTool.describe({ id: 9 }, ctx())).toMatchObject({ title: "✓ Re-deliver return #9" });
    h.actions.redeliverReturn.mockResolvedValue({ ok: true, ledgerId: 88 });
    expect(await redeliverReturnTool.execute({ id: 9 }, ctx())).toEqual({ ok: true, message: "Return #9 is re-delivered.", undo: { tool: "reopen_return", input: { id: 9, ledgerId: 88 } } });
    h.snaps.readReturn.mockResolvedValue(ret({ status: "resolved" }));
    expect(await redeliverReturnTool.describe({ id: 9 }, ctx())).toEqual({ error: "Return #9 is re-delivered already." });
  });

  it("offers the undo tools to nobody", () => {
    const names = toolsFor({ ...admin, isOwner: true } as User, { hidden: new Set(), actionsPaused: false }).map((t) => t.name);
    for (const n of ["cancel_return", "reopen_return", "restore_queue_note", "restore_worklist_dates"]) expect(names).not.toContain(n);
  });
});
