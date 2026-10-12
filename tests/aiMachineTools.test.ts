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
vi.mock("@/lib/server/auth", async () => {
  // the board's own rule on the shared machines, read off the stubbed keys
  const { bayPermKeys } = await import("@/lib/domain/permissions");
  return {
    hasPerm: (_u: unknown, k: string) => h.perms.has(k),
    bayAccess: (_u: unknown, bay: string) => {
      const k = bayPermKeys(bay);
      return { tr: h.perms.has(k.tr), lv: k.lv !== null && h.perms.has(k.lv) };
    },
  };
});
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
  addMachineRuleTool, assignLinesTool, assignLineTool, getMachineBoardTool, moveLineTool, planMachinesTool, resetMachinePlanTool, restoreQueuesTool, setMachineRuleActiveTool, unassignLineTool,
} from "@/lib/server/ai/tools/machines";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";
import { sameSnapshot } from "@/lib/domain/aiActions";

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

  it("needs the line's own key: the bay's for a transformer part, the LV stage's for a panel", async () => {
    expect(await assignLineTool.describe(line, ctx)).toEqual({ error: expect.stringContaining("needs its own key") });
    // a panel clerk schedules a panel on the punches, never a transformer part
    h.perms.add("lv.punching");
    expect(await assignLineTool.describe(line, ctx)).toEqual({ error: expect.stringContaining("needs its own key") });
    h.board.getDeptBoardLines.mockResolvedValue([{ bom: "B1", mo: "M1", item: "PNL" }]);
    h.readQueueSnapshot.mockResolvedValue([]);
    expect(await assignLineTool.describe({ ...line, item: "PNL" }, ctx)).toMatchObject({ title: "M1 PNL → L1" });
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
    expect(p).toMatchObject({
      title: "M1 TN → L1",
      changes: [{ label: "M1 TN", before: "L2#1 M1 TN ×3", after: "L1 (the rest)" }],
      // what it relies on: where this line is now, not the whole department
      snapshot: [{ bom: "B1", mo: "M1", item: "TN", machineId: 2, sheet: "", qty: 3, running: false, sheetDone: 0 }],
    });
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

describe("a card on the board, approved after others", () => {
  const snap = async (rows: QueueRowSnapshot[]) => {
    h.readQueueSnapshot.mockResolvedValue(rows);
    const p = await assignLineTool.describe({ ...line, qty: null }, ctx);
    if ("error" in p) throw new Error(p.error);
    return p.snapshot;
  };

  it("stays good when other lines go on the machines first — even on the same machine, even ahead of it", async () => {
    h.perms.add("cut.edit");
    const proposed = await snap([row({ bom: "B7", mo: "M7", machineId: 1, running: true })]);
    // another card approved first: another line at the back of L1, a third on L2, L1's queue renumbered
    const later = [row({ bom: "B7", mo: "M7", machineId: 1, rank: 2, running: false }), row({ bom: "B8", mo: "M8", machineId: 1, rank: 1, running: true }), row({ bom: "B9", mo: "M9", machineId: 2 })];
    expect(sameSnapshot(await snap(later), proposed)).toBe(true);
  });

  it("goes out of date when its own line was moved, resized or put on a machine since", async () => {
    h.perms.add("cut.edit");
    const proposed = await snap([]);
    expect(sameSnapshot(await snap([row({ machineId: 2 })]), proposed)).toBe(false);
    const onL2 = await snap([row({ machineId: 2, qty: 3 })]);
    expect(sameSnapshot(await snap([row({ machineId: 2, qty: 5 })]), onL2)).toBe(false);
    // its place in the queue moving round it is not a change to it
    expect(sameSnapshot(await snap([row({ machineId: 2, qty: 3, rank: 4 })]), onL2)).toBe(true);
  });

  it("a move within a queue relies on that machine's queue, and on no other", async () => {
    h.perms.add("cut.edit");
    const q = [row({ machineId: 1, rank: 1 }), row({ bom: "B7", mo: "M7", machineId: 1, rank: 2 })];
    h.readQueueSnapshot.mockResolvedValue([...q, row({ bom: "B9", mo: "M9", machineId: 2 })]);
    const p = await moveLineTool.describe({ ...line, dir: "down" }, ctx);
    expect(p).toMatchObject({ snapshot: q });
  });
});

describe("assign_lines_to_machines", () => {
  const many = (lines: Record<string, unknown>[]) => {
    const c = checkToolInput<Parameters<typeof assignLinesTool.describe>[0]>(assignLinesTool, { dept: "Cut", lines });
    if (!c.ok) throw new Error(c.error);
    return c.input;
  };
  const A = { bom: "B1", mo: "M1", item: "TN", machine: "L1" };
  const B = { bom: "B2", mo: "M2", item: "TN", machine: "l2" };
  const C = { bom: "B3", mo: "M3", item: "CF", machine: "L1", qty: 4 };

  beforeEach(() => {
    h.board.getDeptBoardLines.mockResolvedValue([{ bom: "B1", mo: "M1", item: "TN" }, { bom: "B2", mo: "M2", item: "TN" }, { bom: "B3", mo: "M3", item: "CF" }, { bom: "B4", mo: "M4", item: "PNL" }]);
    h.readQueueSnapshot.mockResolvedValue([row({ bom: "B2", mo: "M2", machineId: 1, qty: 2 }), row({ bom: "B9", mo: "M9", machineId: 2 })]);
  });

  it("refuses a line listed twice for a machine, and a line's rest on two machines", () => {
    expect(checkToolInput(assignLinesTool, { dept: "Cut", lines: [A, { ...A, machine: "l1" }] })).toMatchObject({ ok: false, error: expect.stringContaining("listed twice for l1") });
    expect(checkToolInput(assignLinesTool, { dept: "Cut", lines: [A, { ...A, machine: "L2" }] })).toMatchObject({ ok: false, error: expect.stringContaining("goes on one machine only") });
    // split over two machines: a share on one, the rest on the other
    expect(checkToolInput(assignLinesTool, { dept: "Cut", lines: [{ ...A, qty: 5 }, { ...A, machine: "L2" }] })).toMatchObject({ ok: true });
  });

  it("asks for an approval whenever it carries more than one line", () => {
    expect(assignLinesTool.risk instanceof Function && assignLinesTool.risk(many([A]))).toBe("low");
    expect(assignLinesTool.risk instanceof Function && assignLinesTool.risk(many([A, B]))).toBe("high");
  });

  it("checks every line before anything moves: its own key, its machine, that the department owes it", async () => {
    h.perms.add("cut.edit");
    expect(await assignLinesTool.describe(many([A, { bom: "B4", mo: "M4", item: "PNL", machine: "L2" }]), ctx)).toEqual({ error: expect.stringContaining("M4 PNL: Scheduling this line needs its own key") });
    expect(await assignLinesTool.describe(many([A, { ...B, machine: "ZZ" }]), ctx)).toEqual({ error: "No machine ZZ in Cut." });
    h.prisma.machine.findFirst.mockImplementationOnce(async () => L1).mockImplementationOnce(async () => ({ ...L2, active: false }));
    expect(await assignLinesTool.describe(many([A, B]), ctx)).toEqual({ error: expect.stringContaining("L2 is retired") });
    expect(await assignLinesTool.describe(many([A, { bom: "B5", mo: "M5", item: "TN", machine: "L1" }]), ctx)).toEqual({ error: expect.stringContaining("M5 TN is not an open line of Cut") });
    h.planningOn = false;
    expect(await assignLinesTool.describe(many([A]), ctx)).toEqual({ error: expect.stringContaining("switched off") });
  });

  it("is one card for the whole distribution, relying on its own lines only", async () => {
    h.perms.add("cut.edit");
    const p = await assignLinesTool.describe(many([A, B, C]), ctx);
    expect(p).toMatchObject({
      title: "3 line(s) → 2 machine(s) of Cut",
      summary: expect.stringContaining("L1 2, L2 1"),
      changes: [
        { label: "M1 TN", before: "not on a machine", after: "L1 (the rest)" },
        { label: "M2 TN", before: "L1#1 M2 TN ×2", after: "L2 (the rest)" },
        { label: "M3 CF", before: "not on a machine", after: "L1 ×4" },
      ],
      // the other line on L2 is not part of it
      snapshot: [{ bom: "B2", mo: "M2", item: "TN", machineId: 1, sheet: "", qty: 2, running: false, sheetDone: 0 }],
    });
  });

  it("runs the board's own action for each line, in order, and is undone as one", async () => {
    h.perms.add("cut.edit");
    const before = [row({ bom: "B9", mo: "M9", machineId: 2 })];
    h.readQueueSnapshot.mockResolvedValue(before);
    const out = await assignLinesTool.execute(many([A, B, C]), ctx);
    const sent = h.actions.assignLineMachine.mock.calls.map((c) => Object.fromEntries((c[0] as FormData).entries()));
    expect(sent).toEqual([
      { dept: "Cut", bom: "B1", mo: "M1", item: "TN", sheet: "", machineId: "1", qty: "" },
      { dept: "Cut", bom: "B2", mo: "M2", item: "TN", sheet: "", machineId: "2", qty: "" },
      { dept: "Cut", bom: "B3", mo: "M3", item: "CF", sheet: "", machineId: "1", qty: "4" },
    ]);
    expect(out).toEqual({ ok: true, message: "Put 3 line(s) on 2 machine(s) of Cut.", undo: { tool: "restore_machine_queues", input: { dept: "Cut", rows: before } } });
  });

  it("stops at the first line the board refuses, keeping the undo of what it did", async () => {
    h.perms.add("cut.edit");
    h.readQueueSnapshot.mockResolvedValue([]);
    h.actions.assignLineMachine.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "L2 is retired — bring it back in Tools → Machines first." });
    const out = await assignLinesTool.execute(many([A, B, C]), ctx);
    expect(out).toEqual({ ok: true, message: expect.stringContaining("Put 1 of 3 line(s) on the machines — stopped at M2 TN → L2: L2 is retired"), undo: { tool: "restore_machine_queues", input: { dept: "Cut", rows: [] } } });
    expect(h.actions.assignLineMachine).toHaveBeenCalledTimes(2);
    h.actions.assignLineMachine.mockReset().mockResolvedValue({ ok: false, error: "That line is done." });
    expect(await assignLinesTool.execute(many([A, B]), ctx)).toEqual({ ok: false, error: "M1 TN → L1: That line is done." });
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

  it("plans only the lines the person schedules on the shared machines, as ⚡ Plan does for them", async () => {
    h.perms.add("lv.punching");
    h.board.getOptimizerInputs.mockResolvedValue(inputs([{ key: "B1|M1|PNL", pieces: 2, route: [{ center: "Cutting", hoursPerPiece: 1 }], dueDay: 1 }]));
    h.readQueueSnapshot.mockResolvedValue([row({ machineId: 1 }), row({ machineId: 1, item: "PNL", mo: "M2", rank: 2 })]);
    const p = await planMachinesTool.describe({ dept: "Cut" }, ctx);
    const mayPlan = h.board.getOptimizerInputs.mock.calls[0][2] as (item: string) => boolean;
    expect([mayPlan("PNL"), mayPlan("TN")]).toEqual([true, false]);
    // the waiting transformer part is not the panel clerk's to re-plan
    expect(p).toMatchObject({ changes: expect.arrayContaining([{ label: "L1", before: "1 waiting", after: "M1 PNL ×2" }]) });
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
    expect(await resetMachinePlanTool.describe({ dept: "Cut" }, ctx)).toEqual({ error: "Nothing you schedule is on Cut's machines." });
    // only the other line's work on the machines: nothing of the person's to reset
    h.readQueueSnapshot.mockResolvedValue([row({ item: "PNL" })]);
    expect(await resetMachinePlanTool.describe({ dept: "Cut" }, ctx)).toEqual({ error: "Nothing you schedule is on Cut's machines." });
    h.readQueueSnapshot.mockResolvedValue([row(), row({ item: "PNL", rank: 2 })]);
    expect(await resetMachinePlanTool.describe({ dept: "Cut" }, ctx)).toMatchObject({ summary: expect.stringContaining("the other product line's 1 stay") });
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
