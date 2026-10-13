import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's tools for the Orders Registry, the team chat and the drawn
// floor (lib/server/ai/tools/orders.ts, chat.ts, floor.ts) and an
// automation's test run: what each card says, which of the screens' own
// actions it runs with what, and how it is undone — against a stubbed
// database and stubbed actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findUnique: fn(), findMany: fn() },
      user: { findMany: fn(), findUnique: fn() },
      chatGroup: { findMany: fn(), findFirst: fn() },
      machine: { findMany: fn() },
      shiftEntry: { count: fn() }, machineDowntime: { count: fn() }, machineRule: { count: fn() }, worklistMachine: { count: fn() },
      machineItemTime: { count: fn() }, handoverEntry: { count: fn() }, manualJob: { count: fn() }, sheetCutLog: { count: fn() },
    },
    perms: new Set<string>(),
    files: new Map<number, unknown>(),
    floor: null as unknown,
    orderDeletePreview: fn(),
    snaps: { restoreOrderMonths: fn(), readFloorLayout: fn(), restoreFloorLayout: fn() },
    orders: { updateOrder: fn(), removeOrderMonth: fn(), setGroupFins: fn(), deleteOrders: fn() },
    chat: { sendChatMessage: fn(), createChatGroup: fn(), addChatGroupMembers: fn() },
    floorActions: { saveFloorLayout: fn(), createPartition: fn() },
    machineActions: { deleteMachine: fn() },
    automationFor: fn(),
    runAutomationNow: fn(),
    setAutomationTiming: fn(),
    setAutomationEnabled: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/orderDelete", () => ({ orderDeletePreview: h.orderDeletePreview }));
vi.mock("@/lib/server/rowSnapshots", () => h.snaps);
vi.mock("@/app/orders/actions", () => h.orders);
vi.mock("@/app/chat/actions", () => h.chat);
vi.mock("@/app/simulate/floorActions", () => h.floorActions);
vi.mock("@/app/admin/machines/actions", () => h.machineActions);
vi.mock("@/lib/server/ai/files", () => ({
  chatFile: async (_ctx: unknown, id: number) => h.files.get(id) ?? { error: `No file #${id} in this chat.` },
  uploadOf: (f: { name: string; type: string }) => new File([new Uint8Array([1])], f.name, { type: f.type }),
}));
vi.mock("@/lib/server/automations/store", () => ({
  automationFor: h.automationFor,
  configOf: (a: { config: unknown }) => a.config,
  prepareAutomation: vi.fn(),
}));
vi.mock("@/lib/server/automations/views", () => ({ automationViews: vi.fn() }));
vi.mock("@/app/automations/actions", () => ({
  deleteAutomation: vi.fn(), restoreAutomation: vi.fn(), runAutomationNow: h.runAutomationNow, saveAutomation: vi.fn(), setAutomationEnabled: h.setAutomationEnabled, setAutomationTiming: h.setAutomationTiming,
}));
vi.mock("@/app/inbox/actions", () => ({ retractInboxMessages: vi.fn(), sendInboxMessage: vi.fn() }));

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { deleteOrdersTool, removeOrderMonthTool, restoreOrderMonthsTool, setBomFinsTool, updateOrderTool } from "@/lib/server/ai/tools/orders";
import { addChatGroupMembersTool, createChatGroupTool, sendChatMessageTool } from "@/lib/server/ai/tools/chat";
import { editFloorLayoutTool, getFloorLayoutTool, removeFloorStationsTool, restoreFloorLayoutTool } from "@/lib/server/ai/tools/floor";
import { setAutomationEnabledTool, setAutomationTimingTool, testAutomationTool } from "@/lib/server/ai/tools/automations";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const sara = { id: 1, name: "Sara", isAdmin: false, isOwner: false } as User;
const admin = { ...sara, isAdmin: true } as User;
const ctx = (user: User = sara, hidden: string[] = []): ToolCtx => ({ user, hidden: new Set(hidden), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 3, automationId: null });
const fd = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());

const order = (o: Record<string, unknown> = {}) => ({
  mo: "M1", bom: "B1", planQty: 10, urgent: false, ospEncloser: 0, soi: "S1", customer: null, fgCode: null, kva: "1000", rating: null, colorRal: null,
  remarks: null, product: null, secItem: null, materialsRemarks: null, months: "July 2026,August 2026", source: "July 2026", fins: null, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.files.clear();
  h.prisma.masterOrder.findUnique.mockResolvedValue(order());
  h.prisma.user.findMany.mockImplementation(async ({ where }: { where: { name: { equals?: string; contains?: string } } }) => {
    const all = [{ id: 1, name: "Sara" }, { id: 2, name: "Omar" }, { id: 3, name: "Hany" }];
    const n = (where.name.equals ?? where.name.contains ?? "").toLowerCase();
    return all.filter((u) => (where.name.equals !== undefined ? u.name.toLowerCase() === n : u.name.toLowerCase().includes(n)));
  });
  h.prisma.chatGroup.findMany.mockResolvedValue([]);
  for (const g of [h.orders, h.chat, h.floorActions, h.snaps, h.machineActions]) for (const f of Object.values(g)) f.mockResolvedValue({ ok: true });
  for (const t of ["shiftEntry", "machineDowntime", "machineRule", "worklistMachine", "machineItemTime", "handoverEntry", "manualJob", "sheetCutLog"] as const) h.prisma[t].count.mockResolvedValue(0);
  h.snaps.readFloorLayout.mockResolvedValue(null);
  h.prisma.machine.findMany.mockResolvedValue([{ id: 7, code: "W-1", name: "Bay A", active: true }, { id: 8, code: "W-2", name: "Bay B", active: true }]);
});

describe("update_order", () => {
  it("is an admin's, shows what moves, posts the whole form and is undone by the old values", async () => {
    expect(checkToolInput(updateOrderTool, { mo: "M1" })).toMatchObject({ ok: false, error: "Say what changes on the order." });
    expect(await updateOrderTool.describe({ mo: "M1", planQty: 8 }, ctx())).toEqual({ error: "Only an admin edits the orders registry." });
    expect(await updateOrderTool.describe({ mo: "M1", planQty: 10 }, ctx(admin))).toEqual({ error: "M1 reads so already." });
    const p = await updateOrderTool.describe({ mo: "M1", planQty: 8, customer: "ACME" }, ctx(admin));
    expect(p).toMatchObject({ changes: [{ label: "M1 Plan qty", before: "10", after: "8" }, { label: "M1 Customer", before: "—", after: "ACME" }] });
    expect(updateOrderTool.risk instanceof Function && updateOrderTool.risk({ mo: "M1", customer: "x" })).toBe("low");
    const out = await updateOrderTool.execute({ mo: "M1", planQty: 8, customer: "ACME" }, ctx(admin));
    expect(fd(h.orders.updateOrder)).toMatchObject({ mo: "M1", bom: "B1", planQty: "8", urgent: "false", soi: "S1", customer: "ACME", kva: "1000", rating: "" });
    expect(out).toEqual({ ok: true, message: "M1 is edited.", undo: { tool: "update_order", input: { mo: "M1", planQty: 10, customer: "" } } });
  });
});

describe("plan months and fins", () => {
  it("takes a month off, never the last, undone by the months as they were", async () => {
    expect(await removeOrderMonthTool.describe({ mo: "M1", month: "July 2026" }, ctx())).toEqual({ error: "Only an admin edits the orders registry." });
    expect(await removeOrderMonthTool.describe({ mo: "M1", month: "May 2026" }, ctx(admin))).toEqual({ error: expect.stringContaining("is not tagged with May 2026") });
    expect(await removeOrderMonthTool.describe({ mo: "M1", month: "July 2026" }, ctx(admin))).toMatchObject({ changes: [{ before: "July 2026, August 2026", after: "August 2026" }] });
    expect(await removeOrderMonthTool.execute({ mo: "M1", month: "July 2026" }, ctx(admin))).toMatchObject({ undo: { tool: "restore_order_months", input: { mo: "M1", months: "July 2026,August 2026" } } });
    h.prisma.masterOrder.findUnique.mockResolvedValue(order({ months: "", source: "July 2026" }));
    expect(await removeOrderMonthTool.describe({ mo: "M1", month: "July 2026" }, ctx(admin))).toEqual({ error: "An order keeps at least one plan month." });
    await restoreOrderMonthsTool.execute({ mo: "M1", months: "July 2026,August 2026" }, ctx(admin));
    expect(h.snaps.restoreOrderMonths).toHaveBeenCalledWith("M1", "July 2026,August 2026");
  });

  it("spreads a BOM's fins over its MOs and is undone MO by MO", async () => {
    h.perms.add("tracker.qty");
    h.prisma.masterOrder.findMany.mockResolvedValueOnce([{ mo: "M1", bom: "B1", planQty: 4, fins: "1" }, { mo: "M2", bom: "B1", planQty: 4, fins: null }]);
    const p = await setBomFinsTool.describe({ bom: "B1", mos: ["M1", "M2"], total: 6 }, ctx());
    expect(p).toMatchObject({ title: "B1 Fins: 1 → 6", changes: [{ label: "M1 Fins", before: "1", after: "4" }, { label: "M2 Fins", before: "0", after: "2" }] });
    h.prisma.masterOrder.findMany.mockResolvedValueOnce([{ mo: "M1", bom: "B1", planQty: 4, fins: "1" }, { mo: "M2", bom: "B1", planQty: 4, fins: null }]);
    expect(await setBomFinsTool.describe({ bom: "B1", mos: ["M1", "M2"], total: 9 }, ctx())).toEqual({ error: expect.stringContaining("Only 8 fit") });
    h.prisma.masterOrder.findMany
      .mockResolvedValueOnce([{ mo: "M1", bom: "B1", planQty: 4, fins: "1" }, { mo: "M2", bom: "B1", planQty: 4, fins: null }])
      .mockResolvedValueOnce([{ mo: "M1", fins: "4" }, { mo: "M2", fins: "2" }]);
    expect(await setBomFinsTool.execute({ bom: "B1", mos: ["M1", "M2"], total: 6 }, ctx())).toEqual({
      ok: true, message: "B1's Fins is 6.", undo: { tool: "set_order_specs", input: { changes: [{ mo: "M1", field: "fins", value: "1" }, { mo: "M2", field: "fins", value: "" }] } },
    });
  });
});

describe("delete_orders", () => {
  it("is a deletion, refuses orders with recorded work unless forced, and has no undo", async () => {
    expect(deleteOrdersTool.risk).toBe("destructive");
    h.orderDeletePreview.mockResolvedValue([{ mo: "M1", bom: "B1", planQty: 10, loggedQty: 4, loggedRows: 2, tanks: 0, planningRows: 3 }]);
    expect(await deleteOrdersTool.describe({ mos: ["M1", "M9"] }, ctx(admin))).toEqual({ error: "Not in the registry: M9." });
    expect(await deleteOrdersTool.describe({ mos: ["M1"] }, ctx(admin))).toEqual({ error: expect.stringContaining("close those orders instead") });
    expect(await deleteOrdersTool.describe({ mos: ["M1"], force: true }, ctx(admin))).toMatchObject({ summary: expect.stringContaining("stays in the history without its order. It cannot be undone.") });
    expect(await deleteOrdersTool.execute({ mos: ["M1"], force: true }, ctx(admin))).toEqual({ ok: true, message: "Deleted 1 order(s) from the registry." });
    expect(fd(h.orders.deleteOrders)).toEqual({ mos: "M1", force: "true" });
  });
});

describe("the team chat", () => {
  it("sends to a colleague or one of the person's groups, with the chat's files, and says it cannot be taken back", async () => {
    expect(checkToolInput(sendChatMessageTool, { to: "Omar" })).toMatchObject({ ok: false, error: "The message is empty." });
    expect(await sendChatMessageTool.describe({ to: "Sara", text: "hi" }, ctx())).toEqual({ error: "That is the person themselves." });
    expect(await sendChatMessageTool.describe({ to: "Nobody", text: "hi" }, ctx())).toEqual({ error: expect.stringContaining("Nor is any of the person's groups.") });
    h.files.set(5, { id: 5, name: "weld.jpg", type: "image/jpeg", sha256: "s5" });
    const p = await sendChatMessageTool.describe({ to: "omar", text: "M1 is ready", mo: "M1", files: [5] }, ctx());
    expect(p).toMatchObject({ summary: expect.stringContaining("It cannot be taken back."), snapshot: { to: { kind: "user", id: 2 }, files: ["s5"] } });
    const out = await sendChatMessageTool.execute({ to: "omar", text: "M1 is ready", mo: "M1", files: [5] }, ctx());
    const sent = h.chat.sendChatMessage.mock.calls[0][0] as FormData;
    expect([sent.get("kind"), sent.get("to"), sent.get("body"), sent.get("mo"), (sent.get("files") as File).name]).toEqual(["user", "2", "M1 is ready", "M1", "weld.jpg"]);
    expect(out).toEqual({ ok: true, message: "Sent to Omar in the team chat." });
    // a group by its name; a colleague and a group of the same name are asked about
    h.prisma.chatGroup.findMany.mockResolvedValue([{ id: 40, name: "Welding" }]);
    expect(await sendChatMessageTool.describe({ to: "Welding", text: "x" }, ctx())).toMatchObject({ snapshot: { to: { kind: "group", id: 40 } } });
    h.prisma.chatGroup.findMany.mockResolvedValue([{ id: 41, name: "Omar" }]);
    expect(await sendChatMessageTool.describe({ to: "Omar", text: "x" }, ctx())).toEqual({ error: expect.stringContaining("say which (kind)") });
    // live chats only, and only where the chat is in sight
    h.perms.add("ai.automations");
    const names = (o: { hidden?: string[]; unattended?: boolean }) => toolsFor(sara, { hidden: new Set(o.hidden ?? []), actionsPaused: false, unattended: o.unattended }).map((t) => t.name);
    expect(names({})).toContain("send_chat_message");
    expect(names({ unattended: true })).not.toContain("send_chat_message");
    expect(names({ hidden: ["chat"] })).not.toContain("send_chat_message");
  });

  it("makes a group with the person in it and adds to a group the person made", async () => {
    expect(await createChatGroupTool.describe({ name: "Supervisors", members: ["Sara"] }, ctx())).toEqual({ error: "Name at least one colleague to be in it." });
    await createChatGroupTool.execute({ name: "Supervisors", members: ["Omar", "Hany", "Sara"] }, ctx());
    expect(h.chat.createChatGroup).toHaveBeenCalledWith("Supervisors", [2, 3]);
    h.prisma.chatGroup.findMany.mockResolvedValue([{ id: 40, name: "Supervisors", members: [{ userId: 1 }, { userId: 2 }] }]);
    expect(await addChatGroupMembersTool.describe({ group: "supervisors", members: ["Omar"] }, ctx())).toEqual({ error: 'They are all in "Supervisors" already.' });
    expect(await addChatGroupMembersTool.describe({ group: "supervisors", members: ["Omar", "Hany"] }, ctx())).toMatchObject({ summary: 'Add Hany to the chat group "Supervisors".' });
  });
});

describe("the floor", () => {
  it("reads the drawn floor with machines by their codes", async () => {
    h.snaps.readFloorLayout.mockResolvedValue({ data: { version: 1, w: 1600, h: 900, nodes: [{ id: "m7", kind: "machine", machineId: 7, x: 20, y: 20, w: 180, h: 110 }] }, updatedBy: "Admin" });
    const out = JSON.parse((await getFloorLayoutTool.run({ dept: "Welding" }, ctx())).text);
    expect(out).toMatchObject({ drawn: true, nodes: [{ id: "m7", machine: "W-1", x: 20, y: 20 }], notOnFloor: ["W-2"] });
  });

  it("reads a floor nobody has drawn as the page shows it: every active machine set out in rows", async () => {
    h.prisma.machine.findMany.mockResolvedValue([{ id: 7, code: "W-1", name: "Bay A", active: true }, { id: 8, code: "W-2", name: "Bay B", active: true }, { id: 9, code: "W-3", name: "Old", active: false }]);
    const out = JSON.parse((await getFloorLayoutTool.run({ dept: "Welding" }, ctx())).text);
    expect(out).toMatchObject({ drawn: false, nodes: [{ id: "m7", machine: "W-1", x: 20, y: 20 }, { id: "m8", machine: "W-2", y: 20 }], notOnFloor: [] });
    expect(out.nodes).toHaveLength(2);
  });

  it("edits it as the canvas does, under the machines key, and is undone by the floor as stored — or not drawn", async () => {
    // a floor nobody has drawn: the edit starts from its machines as the page shows them
    const i = { dept: "Welding" as const, add: [{ kind: "zone" as const, text: "Tank welding", color: "blue" as const }], move: [{ node: "w-2", x: 400, y: 100 }] };
    expect(await editFloorLayoutTool.describe(i, ctx())).toEqual({ error: expect.stringContaining("machines.manage") });
    h.perms.add("machines.manage");
    expect(await editFloorLayoutTool.describe({ dept: "Welding", add: [{ kind: "machine", machine: "W-1" }] }, ctx())).toEqual({ error: "W-1 is on the floor already — move it instead." });
    expect(await editFloorLayoutTool.describe({ dept: "Welding", move: [{ node: "W-9", x: 10 }] }, ctx())).toEqual({ error: expect.stringContaining("Nothing on the floor is W-9") });
    const p = await editFloorLayoutTool.describe(i, ctx());
    expect(p).toMatchObject({
      summary: "Edit the Welding floor: 2 change(s) — its first drawing, from its machines set out in rows as the page shows them.",
      changes: [{ label: 'zone "Tank welding"' }, { label: "W-2", after: "400, 100 (180×110)" }],
      snapshot: null,
    });
    const out = await editFloorLayoutTool.execute(i, ctx());
    const saved = JSON.parse(String(fd(h.floorActions.saveFloorLayout).layout));
    // W-1 stays where the page showed it; nothing the planner saw drops off
    expect(saved.nodes.map((n: { id: string; kind: string; x: number; y: number }) => [n.kind, n.x, n.y])).toEqual([["machine", 20, 20], ["machine", 400, 100], ["zone", expect.any(Number), expect.any(Number)]]);
    expect(out).toEqual({ ok: true, message: "The Welding floor is saved.", undo: { tool: "restore_floor_layout", input: { dept: "Welding", layout: "null" } } });
    const u = checkToolInput<Parameters<typeof restoreFloorLayoutTool.execute>[0]>(restoreFloorLayoutTool, { dept: "Welding", layout: "null" });
    if (!u.ok) throw new Error(u.error);
    await restoreFloorLayoutTool.execute(u.input, ctx());
    expect(h.snaps.restoreFloorLayout).toHaveBeenCalledWith("Welding", null);
  });
});

describe("a new partition on the floor", () => {
  const drawn = { data: { version: 1, w: 1600, h: 900, nodes: [{ id: "m7", kind: "machine", machineId: 7, x: 20, y: 20, w: 180, h: 110 }] }, updatedBy: "Admin" };
  const i = { dept: "Welding" as const, add: [{ kind: "new" as const, text: "Bay C" }, { kind: "label" as const, text: "Door" }] };
  beforeEach(() => {
    h.perms.add("machines.manage");
    h.snaps.readFloorLayout.mockResolvedValue(drawn);
  });

  it("is made on the machines list under the next free code, placed at once, and waits for approval", async () => {
    expect(typeof editFloorLayoutTool.risk === "function" && editFloorLayoutTool.risk(i)).toBe("high");
    const p = await editFloorLayoutTool.describe(i, ctx());
    expect(p).toMatchObject({
      summary: "Edit the Welding floor: 2 change(s) — and W-3 new on the machines list.",
      changes: [{ label: "W-3 Bay C", before: "—", after: expect.stringMatching(/^new partition, at \d+, \d+/) }, { label: 'label "Door"' }],
      snapshot: { floor: drawn, stations: ["W-3"] },
    });
    h.floorActions.createPartition.mockResolvedValue({ ok: true, id: 20 });
    const out = await editFloorLayoutTool.execute(i, ctx());
    expect(fd(h.floorActions.createPartition)).toEqual({ dept: "Welding", name: "Bay C", code: "W-3" });
    const saved = JSON.parse(String(fd(h.floorActions.saveFloorLayout).layout));
    expect(saved.nodes.map((n: { id: string }) => n.id)).toEqual(["m7", "m20", expect.any(String)]);
    expect(out).toEqual({
      ok: true,
      message: "The Welding floor is saved — W-3 new on the machines list.",
      undo: { tool: "remove_floor_stations", input: { dept: "Welding", layout: JSON.stringify(drawn), stations: ["W-3"] } },
    });
  });

  it("takes a code asked for when it is free, and refuses one that is taken or nameless", async () => {
    expect(await editFloorLayoutTool.describe({ dept: "Welding", add: [{ kind: "new", text: "Bay D", machine: "w-1" }] }, ctx())).toEqual({ error: "Code W-1 is already taken." });
    expect(await editFloorLayoutTool.describe({ dept: "Welding", add: [{ kind: "new" }] }, ctx())).toEqual({ error: expect.stringContaining("Name each new partition") });
    expect(await editFloorLayoutTool.describe({ dept: "Painting", add: [{ kind: "new", text: "Line 3", machine: "pl-9" }] }, ctx())).toMatchObject({ changes: [{ label: "PL-9 Line 3", after: expect.stringContaining("new line") }] });
  });

  it("is taken off the list again when the floor cannot be saved", async () => {
    h.floorActions.createPartition.mockResolvedValue({ ok: true, id: 20 });
    h.floorActions.saveFloorLayout.mockResolvedValue({ ok: false, error: "Pick a department." });
    expect(await editFloorLayoutTool.execute(i, ctx())).toEqual({ ok: false, error: "Pick a department." });
    expect(fd(h.machineActions.deleteMachine)).toEqual({ id: "20" });
  });

  it("is undone — the floor back and the row gone — only while nothing uses it", async () => {
    h.prisma.machine.findMany.mockResolvedValue([{ id: 20, code: "W-3", name: "Bay C", dept: "Welding" }]);
    const u = { dept: "Welding" as const, layout: JSON.stringify(drawn), stations: ["W-3"] };
    expect(await removeFloorStationsTool.describe(u, ctx())).toMatchObject({ changes: [{ label: "Welding floor" }, { label: "W-3 Bay C", after: "removed" }] });
    await removeFloorStationsTool.execute(u, ctx());
    expect(h.snaps.restoreFloorLayout).toHaveBeenCalledWith("Welding", drawn);
    expect(fd(h.machineActions.deleteMachine)).toEqual({ id: "20" });
    h.prisma.shiftEntry.count.mockResolvedValue(2);
    expect(await removeFloorStationsTool.describe(u, ctx())).toEqual({ error: expect.stringContaining("W-3 is in use since") });
  });
});

describe("test_automation", () => {
  it("runs the person's own automation once, as a test to them alone", async () => {
    h.automationFor.mockResolvedValue({ id: 4, ownerId: 2, name: "Late orders", config: { trigger: "schedule", times: ["07:30"], days: "working", action: "notify" } });
    expect(await testAutomationTool.describe({ id: 4 }, ctx())).toEqual({ error: "No automation #4 of Sara's." });
    h.automationFor.mockResolvedValue({ id: 4, ownerId: 1, name: "Late orders", config: { trigger: "schedule", times: ["07:30"], days: "working", action: "notify" } });
    expect(await testAutomationTool.describe({ id: 4 }, ctx())).toMatchObject({ summary: expect.stringContaining("the result comes to Sara alone") });
    h.runAutomationNow.mockResolvedValue({ ok: true, id: 4 });
    expect(await testAutomationTool.execute({ id: 4 }, ctx())).toEqual({ ok: true, message: '"Late orders" ran as a test — the result is in Sara\'s inbox.' });
    expect(fd(h.runAutomationNow)).toEqual({ id: "4" });
  });
});

describe("set_automation_timing", () => {
  const owner = { ...sara, id: 9, name: "Muhamed", isOwner: true } as User;
  const config = { name: "Late orders", trigger: "schedule", times: ["07:30"], days: "working", weekdays: [], conditionSql: null, checkEveryMin: 30, activeFrom: null, activeTo: null, action: "notify", message: "Late: {count}", prompt: null, recipientIds: [] };
  const omars = { id: 4, ownerId: 2, name: "Late orders", config, updatedAt: new Date("2026-10-12T08:00:00Z") };
  beforeEach(() => {
    h.automationFor.mockImplementation(async (u: User) => (u.isOwner || u.id === 2 ? omars : null));
    h.prisma.user.findUnique.mockResolvedValue({ name: "Omar" });
    h.setAutomationTiming.mockResolvedValue({ ok: true, id: 4 });
    h.setAutomationEnabled.mockResolvedValue({ ok: true, id: 4 });
  });

  it("lets the app's owner retime anyone's — only when it runs — and is undone by the old timing", async () => {
    expect(await setAutomationTimingTool.describe({ id: 4, times: ["08:00"] }, ctx())).toEqual({ error: "No automation #4 of Sara's." });
    const p = await setAutomationTimingTool.describe({ id: 4, times: ["08:00", "14:00"] }, ctx(owner));
    expect(p).toMatchObject({ title: 'Retime "Late orders"', summary: expect.stringContaining("(Omar's)"), snapshot: { id: 4 } });
    expect(await setAutomationTimingTool.describe({ id: 4, checkEveryMin: 15 }, ctx(owner))).toEqual({ error: expect.stringContaining("on a schedule") });
    expect(await setAutomationTimingTool.describe({ id: 4, times: ["07:30"] }, ctx(owner))).toEqual({ error: '"Late orders" runs so already.' });
    const out = await setAutomationTimingTool.execute({ id: 4, times: ["08:00", "14:00"] }, ctx(owner));
    expect(JSON.parse(String(fd(h.setAutomationTiming).timing))).toEqual({ times: ["08:00", "14:00"], days: "working" });
    expect(out).toEqual({ ok: true, message: '"Late orders" is retimed.', undo: { tool: "set_automation_timing", input: { id: 4, times: ["07:30"], days: "working" } } });
  });

  it("lets the owner pause anyone's too", async () => {
    expect(await setAutomationEnabledTool.describe({ id: 4, enabled: false }, ctx(owner))).toMatchObject({ title: 'Pause "Late orders"' });
  });
});
