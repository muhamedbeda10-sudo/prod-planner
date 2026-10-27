import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's tools for the rest of the data — the ODOO log, MATERIAL,
// the physical stock, consumables, the calendar, the workers and the machines
// list: what each card says, that it runs the screen's own action (on the
// row's own product line), and how it is undone — against stubbed actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      odooEntry: { count: fn() },
      odooNote: { findUnique: fn(), count: fn() },
      physicalStock: { findFirst: fn() },
      holiday: { findMany: fn(), findUnique: fn() },
      worker: { findUnique: fn(), findFirst: fn() },
      shiftEntry: { count: fn() },
      machine: { findFirst: fn() },
      machineRule: { count: fn() },
      worklistMachine: { count: fn() },
      machineItemTime: { count: fn() },
      manualJob: { count: fn() },
      sheetCutLog: { count: fn() },
      consumableItem: { findMany: fn() },
      consumableIssue: { findUnique: fn() },
      consumableIssueRevision: { findFirst: fn() },
      materialUsage: { findUnique: fn() },
      masterOrder: { findUnique: fn() },
    },
    perms: new Set<string>(),
    lines: [] as string[],
    snap: { readOdooRows: fn(), restoreOdooRows: fn(), readPhysicalRows: fn(), restorePhysicalRows: fn() },
    odoo: { addOdooNote: fn(), createOdooEntry: fn(), deleteOdooEntry: fn(), deleteOdooNote: fn(), setOdooMo: fn(), setOdooStatus: fn(), updateOdooEntry: fn(), setOdooFgCode: fn(), updateOdooGroup: fn() },
    physical: { createPhysicalItem: fn(), deletePhysicalItem: fn(), updatePhysicalCell: fn() },
    calendar: { addHoliday: fn(), deleteHoliday: fn() },
    workers: { createWorker: fn(), deleteWorker: fn(), setWorkerActive: fn(), setWorkerVacation: fn(), updateWorker: fn() },
    machines: { createMachine: fn(), deleteMachine: fn(), setMachineActive: fn(), updateMachine: fn() },
    consumables: { createConsumableIssue: fn(), deleteConsumableIssue: fn(), restoreConsumableRevision: fn(), updateConsumableIssue: fn() },
    checkIssueLimits: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/line", () => ({ withLine: (l: string, f: () => unknown) => { h.lines.push(l); return f(); } }));
vi.mock("@/lib/server/rowSnapshots", () => h.snap);
vi.mock("@/app/odoo/actions", () => h.odoo);
vi.mock("@/app/physical/actions", () => h.physical);
vi.mock("@/app/calendar/actions", () => h.calendar);
vi.mock("@/app/admin/workers/actions", () => h.workers);
vi.mock("@/app/admin/machines/actions", () => h.machines);
vi.mock("@/app/consumables/actions", () => h.consumables);
vi.mock("@/lib/server/consumables", () => ({ getCustomDepartments: async () => ["Maintenance"] }));
vi.mock("@/lib/server/consumableLimits", () => ({ checkIssueLimits: h.checkIssueLimits }));

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import {
  addOdooEntryTool, deleteOdooEntriesTool, restoreOdooRowsTool, setOdooFgCodeTool, setOdooMoTool, setOdooStatusTool, updateOdooEntryTool, updateOdooGroupTool,
} from "@/lib/server/ai/tools/odoo";
import { updatePhysicalItemsTool } from "@/lib/server/ai/tools/physical";
import { addHolidaysTool, deleteHolidaysTool, restoreHolidaysTool } from "@/lib/server/ai/tools/calendar";
import { deleteWorkerTool, updateWorkerTool } from "@/lib/server/ai/tools/workers";
import { deleteMachineTool, updateMachineTool } from "@/lib/server/ai/tools/machineList";
import { deleteConsumableIssueTool, recordConsumableIssueTool } from "@/lib/server/ai/tools/consumables";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const user = (o: Partial<User> = {}) => ({ id: 1, name: "Sara", isAdmin: false, ...o }) as User;
const ctxOf = (u: User): ToolCtx => ({ user: u, hidden: new Set(), now: new Date(), todayISO: "2026-10-12", conversationId: 1, automationId: null });
const ctx = ctxOf(user());
const fdOf = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());

const odooRow = (id: number, o: Record<string, unknown> = {}) => ({
  id, line: "TR", date: "2026-10-11T00:00:00.000Z", soi: null, fgCode: "FG", product: "Tank", odooMo: `SF01/MO/${id}`, qty: 4, status: "MO to be close",
  doneAt: null, recordedBy: "Clerk", source: "manual", ledgerId: null, fgGuessed: false, createdAt: "2026-10-11T08:00:00.000Z", notes: [], ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.lines.length = 0;
  for (const group of [h.odoo, h.physical, h.calendar, h.workers, h.machines, h.consumables]) for (const f of Object.values(group)) f.mockResolvedValue({ ok: true });
  h.snap.restoreOdooRows.mockResolvedValue({ ok: true });
  h.checkIssueLimits.mockResolvedValue([]);
});

describe("ODOO: FG-CODE and a merged line", () => {
  it("types the FG-CODE over a guessed one, row by row, undone by the rows as they were", async () => {
    h.perms.add("odoo.edit");
    const rows = [odooRow(1, { fgCode: "FB-1", fgGuessed: true }), odooRow(2, { fgCode: "FB-1" })];
    h.snap.readOdooRows.mockResolvedValue(rows);
    const i = checkToolInput<{ ids: number[]; fgCode: string }>(setOdooFgCodeTool, { ids: [1, 2], fgCode: " fb-1 " });
    if (!i.ok) throw new Error(i.error);
    // the guessed one becomes typed; the typed one is as it should be
    expect(await setOdooFgCodeTool.describe(i.input, ctx)).toMatchObject({ changes: [{ label: expect.stringContaining("#1"), before: "FB-1 (guessed)", after: "FB-1" }] });
    expect(await setOdooFgCodeTool.execute(i.input, ctx)).toEqual({ ok: true, message: "FG-CODE FB-1 is on 1 row(s).", undo: { tool: "restore_odoo_rows", input: { rows: JSON.stringify(rows) } } });
    expect(fdOf(h.odoo.setOdooFgCode)).toEqual({ id: "1", fgCode: "FB-1" });
  });

  it("writes the head's four values to every row — one the rows do not share has to be given", async () => {
    h.perms.add("odoo.edit");
    h.snap.readOdooRows.mockResolvedValue([odooRow(1, { soi: "S1" }), odooRow(2, { soi: "S1", status: "Done" })]);
    expect(await updateOdooGroupTool.describe({ ids: [1, 2], odooMo: "sf01/mo/9" }, ctx)).toEqual({ error: expect.stringContaining("differ in Status") });
    const p = await updateOdooGroupTool.describe({ ids: [1, 2], odooMo: "sf01/mo/9", status: "Done" }, ctx);
    expect(p).toMatchObject({ summary: "On 2 ODOO row(s): Odoo MO → SF01/MO/9; Status → Done." });
    expect("changes" in p && p.changes).toHaveLength(3);
    await updateOdooGroupTool.execute({ ids: [1, 2], odooMo: "sf01/mo/9", status: "Done" }, ctx);
    expect(fdOf(h.odoo.updateOdooGroup)).toEqual({ ids: "1,2", soi: "S1", product: "Tank", odooMo: "SF01/MO/9", status: "Done" });
    expect(checkToolInput(updateOdooGroupTool, { ids: [1] })).toMatchObject({ ok: false });
  });
});

describe("the ODOO log", () => {
  it("moves only the rows that change, on the rows' own line's permission, and is undone by the rows as they were", async () => {
    h.perms.add("odoo.edit");
    const rows = [odooRow(1), odooRow(2, { status: "Done", doneAt: "2026-10-11T10:00:00.000Z" })];
    h.snap.readOdooRows.mockResolvedValue(rows);
    const p = await setOdooStatusTool.describe({ ids: [1, 2], status: "Done" }, ctx);
    expect(p).toMatchObject({ title: "1 ODOO row(s) → Done", changes: [{ label: "#1 2026-10-11 SF01/MO/1 Tank ×4", before: "MO to be close", after: "Done" }], snapshot: rows });
    const out = await setOdooStatusTool.execute({ ids: [1, 2], status: "Done" }, ctx);
    expect(fdOf(h.odoo.setOdooStatus)).toEqual({ ids: "1", status: "Done" });
    expect(out.undo).toEqual({ tool: "restore_odoo_rows", input: { rows: JSON.stringify(rows) } });
    // and the undo writes them back exactly, the close stamp included
    await restoreOdooRowsTool.execute(checkToolInput(restoreOdooRowsTool, out.undo!.input).ok ? (out.undo!.input as { rows: string }) : { rows: "" }, ctx);
    expect(h.snap.restoreOdooRows).toHaveBeenCalledWith(rows);
  });

  it("will not propose cancelling a row before a note says why", async () => {
    h.perms.add("odoo.edit");
    h.snap.readOdooRows.mockResolvedValue([odooRow(1)]);
    h.prisma.odooNote.count.mockResolvedValue(0);
    expect(await setOdooStatusTool.describe({ ids: [1], status: "Cancelled" }, ctx)).toEqual({ error: expect.stringContaining("note") });
    h.prisma.odooNote.count.mockResolvedValue(1);
    expect(await setOdooStatusTool.describe({ ids: [1], status: "Cancelled" }, ctx)).toMatchObject({ title: "1 ODOO row(s) → Cancelled" });
  });

  it("is refused on a line the person has no ODOO permission for", async () => {
    h.perms.add("odoo.edit");
    h.snap.readOdooRows.mockResolvedValue([odooRow(1, { line: "LV" })]);
    expect(await setOdooStatusTool.describe({ ids: [1], status: "Done" }, ctx)).toEqual({ error: expect.stringContaining("ODOO permission") });
  });

  it("a new row is created on its own line and undone by deleting it", async () => {
    h.perms.add("lv.odoo");
    h.prisma.odooEntry.count.mockResolvedValue(0);
    h.odoo.createOdooEntry.mockResolvedValue({ ok: true, id: 77 });
    const input = { line: "LV" as const, date: "2026-10-12", product: "Panel", odooMo: "sf01/mo/9", qty: 2 };
    expect(await addOdooEntryTool.describe(input, ctx)).toMatchObject({ title: "New ODOO row SF01/MO/9" });
    const out = await addOdooEntryTool.execute(input, ctx);
    expect(h.lines).toEqual(["LV"]);
    expect(out.undo).toEqual({ tool: "delete_odoo_entries", input: { ids: [77] } });
  });

  it("a deletion that stops half-way keeps what it did, with the undo of that much", async () => {
    h.perms.add("odoo.edit");
    const rows = [odooRow(1), odooRow(2)];
    h.snap.readOdooRows.mockResolvedValue(rows);
    h.odoo.deleteOdooEntry.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("connection lost"));
    const out = await deleteOdooEntriesTool.execute({ ids: [1, 2] }, ctx);
    expect(out).toEqual({ ok: true, message: "Deleted 1 of 2 row(s) — stopped at #2: connection lost.", undo: { tool: "restore_odoo_rows", input: { rows: JSON.stringify([rows[0]]) } } });
  });

  it("the restore will not take a snapshot it cannot read", () => {
    expect(checkToolInput(restoreOdooRowsTool, { rows: "[{\"x\":1}]" })).toMatchObject({ ok: false });
    expect(checkToolInput(restoreOdooRowsTool, { rows: "[]" })).toMatchObject({ ok: false });
  });
});

describe("the physical stock", () => {
  it("refuses a count that is not a number of 0 or more before anything runs", () => {
    expect(checkToolInput(updatePhysicalItemsTool, { changes: [{ id: 1, field: "physical", value: "-3" }] })).toEqual({ ok: false, error: "The physical count of #1 must be a number of 0 or more." });
    expect(checkToolInput(updatePhysicalItemsTool, { changes: [{ id: 1, field: "physical", value: "1,250" }] })).toMatchObject({ ok: true });
    // a blank count is not 0 — the table refuses it, so the card must not promise 0
    expect(checkToolInput(updatePhysicalItemsTool, { changes: [{ id: 1, field: "physical", value: "" }] })).toMatchObject({ ok: false });
  });
});

describe("the factory calendar", () => {
  it("adds the days that change and is undone by each day as it was", async () => {
    h.perms.add("calendar.manage");
    h.prisma.holiday.findMany.mockResolvedValue([{ date: new Date("2026-10-13T00:00:00Z"), name: "Old name" }]);
    const input = { days: [{ date: "2026-10-13", name: "Eid" }, { date: "2026-10-14", name: "Eid" }] };
    const p = await addHolidaysTool.describe(input, ctx);
    expect(p).toMatchObject({ changes: [{ label: "2026-10-13", before: "Old name", after: "Eid" }, { label: "2026-10-14", before: "working day", after: "Eid" }] });
    const out = await addHolidaysTool.execute(input, ctx);
    expect(h.calendar.addHoliday).toHaveBeenCalledTimes(2);
    expect(out.undo).toEqual({ tool: "restore_holidays", input: { days: [{ date: "2026-10-13", name: "Old name" }, { date: "2026-10-14", name: null }] } });
    h.prisma.holiday.findUnique.mockResolvedValue({ id: 9 });
    await restoreHolidaysTool.execute(out.undo!.input as { days: { date: string; name: string | null }[] }, ctx);
    expect(fdOf(h.calendar.addHoliday, 2)).toEqual({ date: "2026-10-13", name: "Old name" });
    expect(fdOf(h.calendar.deleteHoliday)).toEqual({ id: "9" });
  });

  it("taking days off is a deletion", () => {
    expect(deleteHolidaysTool.risk).toBe("destructive");
    expect(checkToolInput(addHolidaysTool, { days: [{ date: "2026-10-13", name: "A" }, { date: "2026-10-13", name: "B" }] })).toEqual({ ok: false, error: "A day is named twice." });
  });
});

describe("the workers list", () => {
  const sayed = { id: 7, empId: "1203", name: "Sayed", jobTitle: "Welder", stamp: "S", depts: "WeldingTX", vacationUntil: null, active: true };

  it("changes only the fields given and is undone by the worker as they were", async () => {
    h.perms.add("workers.manage");
    h.prisma.worker.findUnique.mockResolvedValue(sayed);
    const p = await updateWorkerTool.describe({ worker: "1203", stamp: "SX", vacationUntil: "2026-10-20" }, ctx);
    expect(p).toMatchObject({ changes: [{ label: "Sayed · Stamp", before: "S", after: "SX" }, { label: "Sayed · Away until", before: "—", after: "2026-10-20" }] });
    const out = await updateWorkerTool.execute({ worker: "1203", stamp: "SX", vacationUntil: "2026-10-20" }, ctx);
    const fd = h.workers.updateWorker.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(fd.entries())).toMatchObject({ id: "7", empId: "1203", name: "Sayed", stamp: "SX", vacationUntil: "2026-10-20" });
    expect(fd.getAll("depts")).toEqual(["WeldingTX"]);
    expect(out.undo).toEqual({ tool: "update_worker", input: { worker: "1203", empId: "1203", name: "Sayed", jobTitle: "Welder", stamp: "S", sections: ["WeldingTX"], vacationUntil: null } });
  });

  it("will not delete a worker the shift log names", async () => {
    h.perms.add("workers.manage");
    h.prisma.worker.findUnique.mockResolvedValue(sayed);
    h.prisma.shiftEntry.count.mockResolvedValue(3);
    expect(await deleteWorkerTool.describe({ worker: "1203" }, ctx)).toEqual({ error: expect.stringContaining("on 3 day(s) of the shift log") });
  });
});

describe("the machines list", () => {
  const laser = { id: 3, code: "B4-10", name: "Bodor", dept: "Cut", center: "Cutting", hoursPerDay: 15, sortOrder: 2, active: true };

  it("keeps the department's centres, and the undo restores the old figures", async () => {
    h.perms.add("machines.manage");
    h.prisma.machine.findFirst.mockResolvedValueOnce(laser);
    expect(await updateMachineTool.describe({ machine: "B4-10", center: "Line" }, ctx)).toEqual({ error: expect.stringContaining("is not a work centre of") });
    h.prisma.machine.findFirst.mockResolvedValue(laser);
    const out = await updateMachineTool.execute({ machine: "B4-10", hoursPerDay: 20 }, ctx);
    expect(fdOf(h.machines.updateMachine)).toMatchObject({ id: "3", code: "B4-10", hoursPerDay: "20", sortOrder: "2" });
    expect(out.undo).toEqual({ tool: "update_machine", input: { machine: "B4-10", code: "B4-10", name: "Bodor", center: "Cutting", hoursPerDay: 15 } });
  });

  it("will not delete a machine its rules or queue name", async () => {
    h.perms.add("machines.manage");
    h.prisma.machine.findFirst.mockResolvedValue(laser);
    h.prisma.machineRule.count.mockResolvedValue(1);
    h.prisma.worklistMachine.count.mockResolvedValue(0);
    for (const m of [h.prisma.machineItemTime.count, h.prisma.manualJob.count, h.prisma.sheetCutLog.count]) m.mockResolvedValue(0);
    expect(await deleteMachineTool.describe({ machine: "B4-10" }, ctx)).toEqual({ error: expect.stringContaining("1 rule(s) and 0 queue line(s)") });
  });

  it("will not delete a machine with typed times per piece or jobs on it — they would go with it, and the undo cannot bring them back", async () => {
    h.perms.add("machines.manage");
    h.prisma.machine.findFirst.mockResolvedValue(laser);
    for (const m of [h.prisma.machineRule.count, h.prisma.worklistMachine.count, h.prisma.manualJob.count, h.prisma.sheetCutLog.count]) m.mockResolvedValue(0);
    h.prisma.machineItemTime.count.mockResolvedValue(2);
    expect(await deleteMachineTool.describe({ machine: "B4-10" }, ctx)).toEqual({ error: expect.stringContaining("2 typed time(s) per piece") });
    h.prisma.machineItemTime.count.mockResolvedValue(0);
    expect(await deleteMachineTool.describe({ machine: "B4-10" }, ctx)).toMatchObject({ title: "Delete machine B4-10" });
  });
});

describe("consumables", () => {
  const sayed = { id: 7, empId: "1203", name: "Sayed", active: true, depts: "WeldingTX" };

  it("asks for the reason before recording a hand-out over a limit", async () => {
    h.perms.add("consumables.edit");
    h.prisma.consumableItem.findMany.mockResolvedValue([{ id: 3, name: "Welding wire", code: "WW" }]);
    h.prisma.worker.findUnique.mockResolvedValue(sayed);
    h.checkIssueLimits.mockResolvedValue([{ basis: "department", departmentsLabel: "Welding TX", people: 1, period: "month", windowLabel: "October", used: 58, adding: 4, limit: 60 }]);
    const input = { item: "welding wire", qty: 4, department: "welding tx", receivedBy: "1203" };
    expect(await recordConsumableIssueTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("Ask the person for the reason") });
    expect(await recordConsumableIssueTool.describe({ ...input, overLimitReason: "night shift" }, ctx)).toMatchObject({ title: "Hand-out: 4 × Welding wire", snapshot: { itemId: 3, department: "WeldingTX", workerId: 7 } });
  });

  it("only an admin's hand-out can be undone from the chat, and only an admin deletes one", async () => {
    h.prisma.worker.findUnique.mockResolvedValue(sayed);
    h.consumables.createConsumableIssue.mockResolvedValue({ ok: true, id: 55 });
    const input = { item: "Gloves", qty: 2, department: "WeldingTX", receivedBy: "1203" };
    expect((await recordConsumableIssueTool.execute(input, ctx)).undo).toBeUndefined();
    expect((await recordConsumableIssueTool.execute(input, ctxOf(user({ isAdmin: true })))).undo).toEqual({ tool: "delete_consumable_issue", input: { id: 55 } });
    expect(await deleteConsumableIssueTool.describe({ id: 55 }, ctx)).toEqual({ error: "Deleting a hand-out, and bringing one back, is an admin's." });
  });
});

describe("who is offered the data tools", () => {
  it("needs the assistant's other-data key, never the undo tools, and nothing on a hidden screen", () => {
    expect(toolsFor(user(), { hidden: new Set(), actionsPaused: false }).map((t) => t.name)).not.toContain("set_odoo_status");
    h.perms.add("ai.act.data");
    const names = toolsFor(user(), { hidden: new Set(["odoo"]), actionsPaused: false }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_holidays", "update_worker", "update_machine", "record_consumable_issue"]));
    expect(names.filter((n) => n.includes("odoo"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("restore_"))).toEqual([]);
    // deletions only with the deletions key
    expect(names).not.toContain("delete_holidays");
    // the MATERIAL sheet changes only by its import — no tool types into it
    expect(names.filter((n) => /material_(cells|line|group)|lv_order_material/.test(n))).toEqual([]);
  });

  it("a read-only question (Ask AI) gets the reading tools alone — nothing that changes or keeps", () => {
    h.perms.add("ai.act.data");
    const all = toolsFor(user(), { hidden: new Set(), actionsPaused: false });
    const names = toolsFor(user(), { hidden: new Set(), actionsPaused: false, readOnly: true }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["query_database", "get_kpis"]));
    for (const kept of ["remember", "forget", "keep_scenario"]) expect(names).not.toContain(kept);
    expect(all.filter((t) => t.kind === "read" && !t.keeps).map((t) => t.name)).toEqual(names);
  });
});

describe("a quantity, a closing or several rows wait for the person's click", () => {
  const risk = <I,>(t: { risk: unknown }, i: I) => (typeof t.risk === "function" ? (t.risk as (i: I) => string)(i) : t.risk);
  it("ODOO: a Done status and more than three rows are high; one row's MO is low", () => {
    expect(risk(setOdooStatusTool, { ids: [1], status: "Done" })).toBe("high");
    expect(risk(setOdooStatusTool, { ids: [1], status: "Pending" })).toBe("low");
    expect(risk(setOdooStatusTool, { ids: [1, 2, 3, 4], status: "Pending" })).toBe("high");
    expect(risk(updateOdooGroupTool, { ids: [1, 2], status: "Done" })).toBe("high");
    expect(risk(updateOdooGroupTool, { ids: [1, 2], odooMo: "SF01/MO/9" })).toBe("low");
    expect(risk(setOdooMoTool, { ids: [1, 2, 3], odooMo: "SF01/MO/9" })).toBe("low");
    expect(risk(setOdooMoTool, { ids: [1, 2, 3, 4], odooMo: "SF01/MO/9" })).toBe("high");
  });
  it("ODOO: one row's quantity or its closing is high, its SOI or a status short of Done is low", () => {
    expect(risk(updateOdooEntryTool, { id: 1, qty: 6 })).toBe("high");
    expect(risk(updateOdooEntryTool, { id: 1, qty: 0 })).toBe("high");
    expect(risk(updateOdooEntryTool, { id: 1, status: "Done" })).toBe("high");
    expect(risk(updateOdooEntryTool, { id: 1, soi: "SOI-9" })).toBe("low");
    expect(risk(updateOdooEntryTool, { id: 1, status: "Pending" })).toBe("low");
  });
  it("stock: a count is high, a name is low", () => {
    expect(risk(updatePhysicalItemsTool, { changes: [{ id: 1, field: "physical", value: "3" }] })).toBe("high");
    expect(risk(updatePhysicalItemsTool, { changes: [{ id: 1, field: "name", value: "Bolt" }] })).toBe("low");
    expect(risk(updatePhysicalItemsTool, { changes: [{ id: 1, field: "odoo", value: "3" }] })).toBe("high");
    // more than three rows wait even with no count among them
    const names = (n: number) => Array.from({ length: n }, (_, k) => ({ id: k + 1, field: "name", value: `Bolt ${k}` }));
    expect(risk(updatePhysicalItemsTool, { changes: names(3) })).toBe("low");
    expect(risk(updatePhysicalItemsTool, { changes: names(4) })).toBe("high");
  });
});
