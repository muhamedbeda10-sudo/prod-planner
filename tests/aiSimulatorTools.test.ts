import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's Simulator tools: a what-if run against today's jobs, saving
// and deleting scenarios, and the run order — what each card says, which of
// the Simulator's own actions runs, and how each is undone.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      simScenario: { findUnique: fn(), findMany: fn() },
      runOrderEntry: { findMany: fn(), findFirst: fn(), count: fn() },
    },
    perms: new Set<string>(),
    getWhatIfInputs: fn(),
    actions: { saveScenario: fn(), deleteScenario: fn(), applyRunOrder: fn(), clearRunOrder: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/whatif", () => ({ getWhatIfInputs: h.getWhatIfInputs }));
vi.mock("@/app/simulate/actions", () => h.actions);

import type { User } from "@prisma/client";
import type { WhatIfInputs, WhatIfJob } from "@/lib/domain/whatif";
import { parseScenario } from "@/lib/domain/whatifScenario";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import {
  applyRunOrderTool, clearRunOrderTool, deleteScenarioTool, restoreRunOrderTool, restoreScenarioTool, saveScenarioTool, simulateScenarioTool,
} from "@/lib/server/ai/tools/simulator";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const job = (id: string, o: Partial<WhatIfJob> = {}): WhatIfJob => ({
  id, mo: id.split("|")[0], bom: "B1", item: id.split("|")[1], dueISO: "2026-10-14",
  left: { cut: 10, weld: 10, finish: 10 }, perPc: { cut: 1, weld: 1, finish: 1 }, baselineDays: 2, blockedBy: null, ...o,
});
const inputs: WhatIfInputs = {
  todayISO: "2026-10-12", holidayISOs: [], rates: { cut: 10, weld: 10, finish: 10 }, rateSigma: { cut: 0, weld: 0, finish: 0 }, rateWindowDays: 20,
  capacity: { Cut: 100, Welding: 100, ShotBlast: 50, Painting: 50 }, jobs: [job("A|TN"), job("B|CF", { dueISO: "2026-10-30" })], plan: null,
};
const user = (o: Partial<User> = {}) => ({ id: 1, name: "Sara", isAdmin: false, ...o }) as User;
const ctxOf = (u: User): ToolCtx => ({ user: u, hidden: new Set(), now: new Date(), todayISO: "2026-10-12", conversationId: 1, automationId: null });
const ctx = ctxOf(user());
const fdOf = (m: ReturnType<typeof vi.fn>) => Object.fromEntries((m.mock.calls[0][0] as FormData).entries());

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.getWhatIfInputs.mockResolvedValue(inputs);
  h.prisma.simScenario.findUnique.mockResolvedValue(null);
  h.prisma.runOrderEntry.findMany.mockResolvedValue([]);
  for (const f of Object.values(h.actions)) f.mockResolvedValue({ ok: true });
});

describe("simulate_scenario", () => {
  it("runs the knobs against today's reality and lists the jobs that move", async () => {
    const r = await simulateScenarioTool.run({ first: ["B"] }, ctx);
    const j = JSON.parse(r.text);
    expect(j.scenario).toBe("queue edited");
    expect(j.queueFront).toEqual(["B|CF", "A|TN"]);
    expect(j.reality).toMatchObject({ ordersOpen: 2 });
    // A's tank waits behind B's frame now, and misses its day
    expect(j.jobs).toContainEqual(expect.objectContaining({ job: "A|TN", due: "2026-10-14", late: true }));
  });

  it("starts from a saved scenario by its exact name, or says there is none", async () => {
    expect(await simulateScenarioTool.run({ saved: "Nope" }, ctx)).toEqual({ ok: false, text: expect.stringContaining("No saved scenario is called \"Nope\"") });
    h.prisma.simScenario.findUnique.mockResolvedValue({ data: { workFridays: true } });
    expect(JSON.parse((await simulateScenarioTool.run({ saved: "Fridays" }, ctx)).text).scenario).toBe("Fridays on");
  });

  it("will not both rush jobs and optimise the queue", () => {
    expect(checkToolInput(simulateScenarioTool, { first: ["A"], optimize: true })).toEqual({ ok: false, error: expect.stringContaining("not both") });
  });
});

describe("save_scenario", () => {
  it("needs the permission to save", async () => {
    expect(await saveScenarioTool.describe({ name: "Two welders", workersDelta: { Welding: 2 } }, ctx)).toEqual({ error: expect.stringContaining("save and delete scenarios") });
  });

  it("says what it overwrites, saves a scenario the Simulator can load, and is undone by the one before", async () => {
    h.perms.add("simulator.edit");
    h.prisma.simScenario.findUnique.mockResolvedValue({ data: { workFridays: true }, savedBy: "Omar" });
    const p = await saveScenarioTool.describe({ name: "Two welders", workersDelta: { Welding: 2 } }, ctx);
    expect(p).toMatchObject({
      title: "Save scenario \"Two welders\"",
      changes: [{ label: "Two welders", before: "Fridays on (saved by Omar)", after: "+2 Welding" }],
      snapshot: { name: "Two welders", existing: { workFridays: true }, from: null },
    });
    const out = await saveScenarioTool.execute({ name: "Two welders", workersDelta: { Welding: 2 } }, ctx);
    const sent = fdOf(h.actions.saveScenario);
    expect(sent.name).toBe("Two welders");
    expect(parseScenario(JSON.parse(String(sent.data)))).toMatchObject({ ok: true, scenario: { workersDelta: { Welding: 2 } } });
    expect(out.undo).toEqual({ tool: "restore_scenario", input: { name: "Two welders", data: JSON.stringify({ workFridays: true }) } });
  });

  it("a new name is undone by removing it again", async () => {
    h.perms.add("simulator.edit");
    const out = await saveScenarioTool.execute({ name: "New" }, ctx);
    expect(out.undo).toEqual({ tool: "restore_scenario", input: { name: "New", data: null } });
  });
});

describe("delete_scenario and its undo", () => {
  it("is a deletion, keeps what it removed, and the undo saves it back", async () => {
    h.perms.add("simulator.edit");
    expect(deleteScenarioTool.risk).toBe("destructive");
    expect(await deleteScenarioTool.describe({ name: "Old" }, ctx)).toEqual({ error: "No saved scenario is called \"Old\"." });
    h.prisma.simScenario.findUnique.mockResolvedValue({ data: { shiftHours: 9 }, savedBy: "Omar" });
    const out = await deleteScenarioTool.execute({ name: "Old" }, ctx);
    expect(fdOf(h.actions.deleteScenario)).toEqual({ name: "Old" });
    expect(out.undo).toEqual({ tool: "restore_scenario", input: { name: "Old", data: JSON.stringify({ shiftHours: 9 }) } });
    await restoreScenarioTool.execute({ name: "Old", data: JSON.stringify({ shiftHours: 9 }) }, ctx);
    expect(fdOf(h.actions.saveScenario)).toEqual({ name: "Old", data: JSON.stringify({ shiftHours: 9 }) });
  });

  it("the undo of a new save deletes it", async () => {
    await restoreScenarioTool.execute({ name: "New", data: null }, ctx);
    expect(fdOf(h.actions.deleteScenario)).toEqual({ name: "New" });
  });
});

describe("the run order", () => {
  const admin = ctxOf(user({ isAdmin: true }));
  const live = [{ mo: "B", item: "CF", batchQty: null, batchNo: null }];

  it("is an admin's", async () => {
    expect(await applyRunOrderTool.describe({}, ctx)).toEqual({ error: "Only an admin sets the run order the worklists follow." });
    expect(await clearRunOrderTool.describe({}, ctx)).toEqual({ error: "Only an admin sets the run order the worklists follow." });
  });

  it("lists the new order against the live one, applies the scenario's open jobs, and is undone by the live one", async () => {
    h.prisma.runOrderEntry.findMany.mockResolvedValue(live);
    const p = await applyRunOrderTool.describe({ splits: [{ job: "A|TN", batches: [4, 6] }] }, admin);
    expect(p).toMatchObject({
      title: "Make this the run order — 3 jobs",
      // the split job's batches stand where the job stood
      changes: [
        { label: "#1", before: "B CF", after: "A TN batch 1 ×4" },
        { label: "#2", before: "—", after: "A TN batch 2 ×6" },
        { label: "#3", before: "—", after: "B CF" },
      ],
      snapshot: { now: live, from: null },
    });
    const out = await applyRunOrderTool.execute({ splits: [{ job: "A|TN", batches: [4, 6] }] }, admin);
    expect(JSON.parse(String(fdOf(h.actions.applyRunOrder).entries))).toEqual([
      { mo: "A", item: "TN", batchQty: 4, batchNo: 1 },
      { mo: "A", item: "TN", batchQty: 6, batchNo: 2 },
      { mo: "B", item: "CF", batchQty: null, batchNo: null },
    ]);
    expect(out.undo).toEqual({ tool: "restore_run_order", input: { entries: JSON.stringify(live) } });
  });

  it("clearing is a deletion, refused with nothing live, and undone by putting the order back", async () => {
    expect(clearRunOrderTool.risk).toBe("destructive");
    expect(await clearRunOrderTool.describe({}, admin)).toEqual({ error: expect.stringContaining("No run order is live") });
    h.prisma.runOrderEntry.findMany.mockResolvedValue(live);
    const out = await clearRunOrderTool.execute({}, admin);
    expect(h.actions.clearRunOrder).toHaveBeenCalledTimes(1);
    expect(out.undo).toEqual({ tool: "restore_run_order", input: { entries: JSON.stringify(live) } });
    await restoreRunOrderTool.execute({ entries: JSON.stringify(live) }, admin);
    expect(fdOf(h.actions.applyRunOrder)).toEqual({ entries: JSON.stringify(live) });
    await restoreRunOrderTool.execute({ entries: "[]" }, admin);
    expect(h.actions.clearRunOrder).toHaveBeenCalledTimes(2);
    expect(checkToolInput(restoreRunOrderTool, { entries: "{}" })).toMatchObject({ ok: false });
  });
});

describe("who is offered the Simulator", () => {
  it("never the undo tools, and nothing when the Simulator screen is hidden from the person", () => {
    h.perms.add("ai.act.simulator").add("ai.act.delete");
    const names = toolsFor(user(), { hidden: new Set(), actionsPaused: false }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_scenarios", "simulate_scenario", "save_scenario", "delete_scenario", "apply_run_order", "clear_run_order"]));
    expect(names).not.toContain("restore_scenario");
    expect(names).not.toContain("restore_run_order");
    const hidden = toolsFor(user(), { hidden: new Set(["simulate"]), actionsPaused: false }).map((t) => t.name);
    expect(hidden.filter((n) => /scenario|run_order/.test(n))).toEqual([]);
  });
});
