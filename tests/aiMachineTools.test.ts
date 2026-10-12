import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's machine-board tools: what each card says, which of the
// board's own actions it runs, and how it is undone (the department's queues
// put back exactly) — against a stubbed database, board and actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      machine: { findMany: fn(), findFirst: fn() },
      machineRule: { findMany: fn(), findUnique: fn() },
    },
    perms: new Set<string>(),
    planningOn: true,
    board: { getDeptBoardLines: fn(), getMachineBoard: fn(), getOptimizerInputs: fn() },
    readQueueSnapshot: fn(),
    getAllMachineRules: fn(),
    actions: {
      assignLineMachine: fn(), unassignLineMachine: fn(), moveLineRank: fn(), setLineRunning: fn(),
      optimizeMachines: fn(), clearMachineQueue: fn(), resetMachinePlan: fn(), restoreMachineQueues: fn(),
    },
    ruleActions: { createMachineRule: fn(), setMachineRuleOn: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/data", () => ({ isMachinePlanningOn: async () => h.planningOn, getSettings: async () => ({}) }));
vi.mock("@/lib/server/machineBoard", () => h.board);
vi.mock("@/lib/server/machineQueues", () => ({ readQueueSnapshot: h.readQueueSnapshot }));
vi.mock("@/lib/server/machineRules", () => ({ getAllMachineRules: h.getAllMachineRules }));
vi.mock("@/app/worklist/machineActions", () => h.actions);
vi.mock("@/app/admin/machines/ruleActions", () => h.ruleActions);

import type { User } from "@prisma/client";
import type { QueueRowSnapshot } from "@/lib/server/machineQueues";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import {
  addMachineRuleTool, assignLineTool, getMachineBoardTool, planMachinesTool, resetMachinePlanTool, restoreQueuesTool, setMachineRuleActiveTool, unassignLineTool,
} from "@/lib/server/ai/tools/machines";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const ctx: ToolCtx = { user: { id: 1, name: "Sara" } as User, hidden: new Set(), now: new Date(), todayISO: "2026-10-12", conversationId: 1, automationId: null };
const L1 = { id: 1, code: "L1", name: "Laser 1", dept: "Cut", center: "Cutting", active: true, hoursPerDay: 15 };
const L2 = { id: 2, code: "L2", name: "Laser 2", dept: "Cut", center: "Cutting", active: true, hoursPerDay: 15 };
const row = (o: Partial<QueueRowSnapshot> = {}): QueueRowSnapshot => ({ bom: "B1", mo: "M1", item: "TN", machineId: 1, rank: 1, running: false, qty: null, sheet: "", sheetDone: 0, ...o });
const fdOf = (m: ReturnType<typeof vi.fn>) => Object.fromEntries((m.mock.calls[0][0] as FormData).entries());
const line = { dept: "Cut" as const, bom: "B1", mo: "M1", item: "TN", sheet: "", machine: "L1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.planningOn = true;
  h.prisma.machine.findFirst.mockImplementation(async ({ where }: { where: { code: { equals: string } } }) => [L1, L2].find((m) => m.code.toLowerCase() === where.code.equals.toLowerCase()) ?? null);
  h.prisma.machine.findMany.mockResolvedValue([L1, L2]);
  h.board.getDeptBoardLines.mockResolvedValue([{ bom: "B1", mo: "M1", item: "TN" }]);
  for (const f of Object.values(h.actions)) f.mockResolvedValue({ ok: true, summary: "done" });
});

describe("assign_line_to_machine", () => {
  it("is closed while the plant does not use the machine board", async () => {
    h.planningOn = false;
    h.perms.add("cut.edit");
    expect(await assignLineTool.describe(line, ctx)).toEqual({ error: expect.stringContaining("switched off") });
  });

  it("needs the department's worklist permission", async () => {
    expect(await assignLineTool.describe(line, ctx)).toEqual({ error: expect.stringContaining("worklist permission") });
  });

  it("refuses a retired machine, an unknown one, and a line the department does not owe", async () => {
    h.perms.add("cut.edit");
    h.prisma.machine.findFirst.mockResolvedValueOnce({ ...L1, active: false });
    expect(await assignLineTool.describe(line, ctx)).toEqual({ error: "L1 is retired." });
    expect(await assignLineTool.describe({ ...line, machine: "ZZ" }, ctx)).toEqual({ error: "No machine ZZ in Cut." });
    expect(await assignLineTool.describe({ ...line, mo: "M9" }, ctx)).toEqual({ error: expect.stringContaining("is not an open line of Cut") });
  });

  it("shows where the line is now, runs the board's own action, and is undone by the queues as they were", async () => {
    h.perms.add("cut.edit");
    const before = [row({ machineId: 2, qty: 3 })];
    h.readQueueSnapshot.mockResolvedValue(before);
    const p = await assignLineTool.describe({ ...line, qty: null }, ctx);
    expect(p).toMatchObject({ title: "M1 TN → L1", changes: [{ label: "M1 TN", before: "L2#1 M1 TN ×3", after: "L1 (the rest)" }], snapshot: before });
    const out = await assignLineTool.execute({ ...line, qty: 4 }, ctx);
    expect(fdOf(h.actions.assignLineMachine)).toEqual({ dept: "Cut", bom: "B1", mo: "M1", item: "TN", sheet: "", machineId: "1", qty: "4" });
    expect(out).toEqual({ ok: true, message: "done", undo: { tool: "restore_machine_queues", input: { dept: "Cut", rows: before } } });
  });

  it("passes the board's refusal on", async () => {
    h.perms.add("cut.edit");
    h.readQueueSnapshot.mockResolvedValue([]);
    h.actions.assignLineMachine.mockResolvedValue({ ok: false, error: "That line is done." });
    expect(await assignLineTool.execute({ ...line, qty: null }, ctx)).toEqual({ ok: false, error: "That line is done." });
  });
});

describe("unassign_line", () => {
  it("finds the line on that machine, or says it is not there", async () => {
    h.perms.add("cut.edit");
    h.readQueueSnapshot.mockResolvedValue([row({ machineId: 1, running: true })]);
    expect(await unassignLineTool.describe({ ...line, machine: "L2" }, ctx)).toEqual({ error: "M1 TN is not on L2." });
    const p = await unassignLineTool.describe(line, ctx);
    expect("summary" in p && p.summary).toContain("it is running there now");
  });
});

describe("plan_machines", () => {
  const inputs = (lines: unknown[]) => ({
    machines: [{ id: 1, code: "L1", center: "Cutting", availableH: 10 }, { id: 2, code: "L2", center: "Cutting", availableH: 10 }],
    lines,
    pins: [],
    facts: {},
    rules: [],
  });

  it("lists each machine's new queue and keeps the plan itself in the snapshot", async () => {
    h.perms.add("cut.edit");
    h.board.getOptimizerInputs.mockResolvedValue(inputs([
      { key: "B1|M1|TN", pieces: 2, route: [{ center: "Cutting", hoursPerPiece: 1, allowed: [2] }], dueDay: 1 },
    ]));
    h.readQueueSnapshot.mockResolvedValue([row({ machineId: 1 })]);
    const p = await planMachinesTool.describe({ dept: "Cut" }, ctx);
    if ("error" in p) throw new Error(p.error);
    expect(p.title).toBe("⚡ Plan Cut: 1 line(s) on 1 machine(s)");
    // the rules allow only L2, so L1 keeps nothing new
    expect(p.changes).toEqual([
      { label: "L1", before: "1 waiting", after: "nothing new" },
      { label: "L2", before: "0 waiting", after: "M1 TN ×2" },
    ]);
    expect(p.snapshot).toEqual({ queues: [row({ machineId: 1 })], placements: [["B1|M1|TN", 2, 2]] });
    const out = await planMachinesTool.execute({ dept: "Cut" }, ctx);
    expect(out.undo).toEqual({ tool: "restore_machine_queues", input: { dept: "Cut", rows: [row({ machineId: 1 })] } });
  });

  it("says so when nothing is left to plan, or no machine has hours", async () => {
    h.perms.add("cut.edit");
    h.board.getOptimizerInputs.mockResolvedValueOnce(inputs([]));
    expect(await planMachinesTool.describe({ dept: "Cut" }, ctx)).toEqual({ error: expect.stringContaining("Nothing to plan") });
    h.board.getOptimizerInputs.mockResolvedValueOnce({ ...inputs([]), machines: [{ id: 1, code: "L1", center: "Cutting", availableH: 0 }] });
    expect(await planMachinesTool.describe({ dept: "Cut" }, ctx)).toEqual({ error: expect.stringContaining("hours a day") });
  });
});

describe("reset and restore", () => {
  it("reset is a deletion, and refuses an empty board", async () => {
    h.perms.add("cut.edit");
    expect(resetMachinePlanTool.risk).toBe("destructive");
    h.readQueueSnapshot.mockResolvedValue([]);
    expect(await resetMachinePlanTool.describe({ dept: "Cut" }, ctx)).toEqual({ error: "Nothing is on Cut's machines." });
  });

  it("the restore is never offered to the model, and an undo's rows pass its own schema", () => {
    const user = { id: 1, name: "Sara" } as User;
    h.perms.add("ai.act.machines").add("ai.act.delete");
    const names = toolsFor(user, { hidden: new Set(), actionsPaused: false }).map((t) => t.name);
    expect(names).toContain("plan_machines");
    expect(names).toContain("reset_machine_plan");
    expect(names).not.toContain("restore_machine_queues");
    expect(checkToolInput(restoreQueuesTool, { dept: "Cut", rows: [row(), row({ machineId: 2, qty: 4, running: true, sheet: "3|Steel|1220*2440", sheetDone: 2 })] }).ok).toBe(true);
    expect(checkToolInput(restoreQueuesTool, { dept: "Cut", rows: [{ ...row(), extra: 1 }] }).ok).toBe(false);
  });

  it("without the deletions key the board-wide wipes are not offered", () => {
    h.perms.add("ai.act.machines");
    const names = toolsFor({ id: 1, name: "Sara" } as User, { hidden: new Set(), actionsPaused: false }).map((t) => t.name);
    expect(names).toContain("assign_line_to_machine");
    expect(names).not.toContain("reset_machine_plan");
    expect(names).not.toContain("clear_machine_queue");
  });
});

describe("the machines' rules", () => {
  const rule = { id: 7, machineId: 1, effect: "never", item: null, line: "LV", minThicknessMm: null, maxThicknessMm: null, material: null, minKva: null, maxKva: null, note: null, active: true, machine: { code: "L1" } };

  it("adding one needs Machines — manage, reads as a sentence, and is undone by taking it off", async () => {
    const input = { dept: "Cut" as const, machine: "L1", effect: "only" as const, item: "TN", maxThicknessMm: 12, note: "old laser" };
    expect(await addMachineRuleTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("Machines — manage") });
    h.perms.add("machines.manage");
    h.prisma.machineRule.findMany.mockResolvedValue([rule]);
    const p = await addMachineRuleTool.describe(input, ctx);
    expect(p).toMatchObject({
      title: "L1 takes only TN, up to 12 mm",
      changes: [{ label: "L1 rules", before: "L1 never takes LV panels", after: "+ L1 takes only TN, up to 12 mm" }],
      snapshot: { machineId: 1, active: [7] },
    });
    expect(await addMachineRuleTool.describe({ ...input, effect: "never", item: undefined, maxThicknessMm: undefined, material: "ss" }, ctx)).toMatchObject({ title: "L1 never takes Stainless steel" });
    expect(await addMachineRuleTool.describe({ dept: "Cut", machine: "L1", effect: "only" }, ctx)).toEqual({ error: "An \"only\" rule must say what the machine takes." });
    h.ruleActions.createMachineRule.mockResolvedValue({ ok: true, id: 9 });
    const out = await addMachineRuleTool.execute(input, ctx);
    expect(fdOf(h.ruleActions.createMachineRule)).toEqual({ machineId: "1", effect: "only", item: "TN", maxThicknessMm: "12", note: "old laser" });
    expect(out).toEqual({ ok: true, message: "Rule #9 added to L1.", undo: { tool: "set_machine_rule_active", input: { id: 9, active: false } } });
  });

  it("taking one off refuses a no-op, and its undo puts it back", async () => {
    h.perms.add("machines.manage");
    h.prisma.machineRule.findUnique.mockResolvedValue(rule);
    expect(await setMachineRuleActiveTool.describe({ id: 7, active: true }, ctx)).toEqual({ error: "Rule #7 is on already." });
    expect(await setMachineRuleActiveTool.describe({ id: 7, active: false }, ctx)).toMatchObject({ title: "Take off rule #7", snapshot: { id: 7, active: true } });
    h.ruleActions.setMachineRuleOn.mockResolvedValue({ ok: true, id: 7 });
    expect(await setMachineRuleActiveTool.execute({ id: 7, active: false }, ctx)).toEqual({ ok: true, message: "Rule #7 is off.", undo: { tool: "set_machine_rule_active", input: { id: 7, active: true } } });
  });
});

describe("get_machine_board", () => {
  it("gives each machine's queue and its active rules, and the lines on no machine", async () => {
    h.getAllMachineRules.mockResolvedValue([{ ...rule0(), id: 3 }, { ...rule0(), id: 4, active: false }]);
    h.board.getMachineBoard.mockResolvedValue({
      cards: [{
        machine: L1, availableH: 15, days: 0.4, clearsISO: "2026-10-12", crew: ["Ali"], hours: 6,
        queue: [{ rank: 1, running: true, bom: "B1", mo: "M1", item: "TN", remaining: 3, sheet: "", split: false, hours: 6, dueISO: "2026-10-14", deliveryISO: null }],
      }],
      unassigned: [{ key: "B2|M2|CF", center: "Cutting", remaining: 5, partial: false, lineRemaining: 5, hours: 2, dueISO: null, deliveryISO: "2026-10-20" }],
      material: { "B2|M2|CF": { specs: [{ thicknessMm: 3, material: "Steel" }] } },
    });
    const r = await getMachineBoardTool.run({ dept: "Cut" }, ctx);
    const j = JSON.parse(r.text);
    expect(j.machines[0]).toMatchObject({ code: "L1", hoursToday: 15, loadDays: 0.4, rules: ["#3 L1 never takes LV panels"], queue: [{ rank: 1, running: true, line: "B1|M1|TN", pcs: 3, due: "2026-10-14" }] });
    expect(j.notOnMachine).toEqual([{ line: "B2|M2|CF", center: "Cutting", pcs: 5, hours: 2, due: "2026-10-20", sheets: ["3 mm Steel"] }]);
  });

  function rule0() {
    return { machineId: 1, effect: "never", item: null, line: "LV", minThicknessMm: null, maxThicknessMm: null, material: null, minKva: null, maxKva: null, note: null, active: true };
  }
});
