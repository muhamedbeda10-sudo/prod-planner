import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's Simulator tools: a what-if run against today's jobs, a
// scenario put on the person's own Simulator screen, saving and deleting
// scenarios, and the run order — what each card says, which of the
// Simulator's own actions runs, and how each is undone.

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
  applyRunOrderTool, clearRunOrderTool, deleteScenarioTool, restoreRunOrderTool, restoreScenarioTool, saveScenarioTool, showOnSimulatorTool, simulateScenarioTool,
} from "@/lib/server/ai/tools/simulator";
import { compareScenariosTool, stressTestPlanTool, simulationReadinessTool } from "@/lib/server/ai/tools/simulationReview";
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
/** A chat with the Simulator open beside it (or not), showing this scenario. */
const onScreen = (scenario: unknown, open = true): ToolCtx => ({ ...ctx, screen: { simulator: { open, scenario } } });
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

  it("starts from what the person's Simulator shows, and leaves the screen as it is", async () => {
    const c = onScreen({ workFridays: true, queue: ["A|TN", "B|CF"] });
    const j = JSON.parse((await simulateScenarioTool.run({ workersDelta: { Welding: 1 } }, c)).text);
    expect(j).toMatchObject({ startedFrom: "the scenario on the person's Simulator", scenario: "+1 Welding · Fridays on", knobs: { workersDelta: { Welding: 1 }, workFridays: true } });
    expect(c.screen?.simulator.scenario).toEqual({ workFridays: true, queue: ["A|TN", "B|CF"] });
    expect(JSON.parse((await simulateScenarioTool.run({ from: "plant" }, c)).text)).toMatchObject({ startedFrom: "the plant as it stands", scenario: "reality as-is" });
  });
});

describe("show_on_simulator", () => {
  it("turns the knobs on what the Simulator shows, puts the result on it, and the next call starts from there", async () => {
    const c = onScreen({ workFridays: true, queue: ["A|TN", "B|CF"] });
    const r = await showOnSimulatorTool.run({ workersDelta: { Welding: 2 } }, c);
    expect(r.ok).toBe(true);
    expect(r.simulator).toMatchObject({ label: "+2 Welding · Fridays on", scenario: { workFridays: true, workersDelta: { Welding: 2, Cut: 0 }, queue: ["A|TN", "B|CF"] } });
    expect(JSON.parse(r.text)).toMatchObject({ screen: expect.stringContaining("On the person's Simulator now"), startedFrom: "the scenario on the person's Simulator", reality: { ordersOpen: 2 } });
    const r2 = await showOnSimulatorTool.run({ shiftHours: 9 }, c);
    expect(r2.simulator?.label).toBe("+2 Welding · 9h shifts · Fridays on");
  });

  it("with the Simulator closed, offers it as a button — and the next call builds on the one offered", async () => {
    const c = onScreen(null, false);
    const r = await showOnSimulatorTool.run({ workFridays: true }, c);
    expect(JSON.parse(r.text)).toMatchObject({ screen: expect.stringContaining("a button that opens it"), startedFrom: "the plant as it stands" });
    expect(c.screen?.simulator).toMatchObject({ open: false, scenario: { workFridays: true } });
    expect((await showOnSimulatorTool.run({ first: ["B"] }, c)).simulator?.label).toBe("Fridays on · queue edited");
  });

  it("starts afresh from the plant, opens a saved scenario, and optimises the queue on request", async () => {
    const c = onScreen({ workFridays: true });
    expect((await showOnSimulatorTool.run({ from: "plant" }, c)).simulator?.label).toBe("reality as-is");
    h.prisma.simScenario.findUnique.mockResolvedValue({ data: { shiftHours: 9 } });
    expect((await showOnSimulatorTool.run({ saved: "Short shifts" }, c)).simulator?.label).toBe("9h shifts");
    const late = { ...inputs, jobs: [job("A|TN", { dueISO: "2026-10-30" }), job("B|CF", { dueISO: "2026-10-13" })] };
    h.getWhatIfInputs.mockResolvedValue(late);
    const o = await showOnSimulatorTool.run({ from: "plant", optimize: true }, c);
    expect(o.simulator).toMatchObject({ label: "queue optimised", scenario: { queue: ["B|CF", "A|TN"] } });
    expect(checkToolInput(showOnSimulatorTool, { saved: "Short shifts", from: "plant" })).toEqual({ ok: false, error: expect.stringContaining("not both") });
  });

  it("says when the screen's scenario cannot be read, and needs a chat the person is in", async () => {
    expect(await showOnSimulatorTool.run({}, onScreen({ holds: { "A|TN": "someday" } }))).toEqual({ ok: false, text: expect.stringContaining("cannot be read") });
    expect(await showOnSimulatorTool.run({}, ctx)).toEqual({ ok: false, text: expect.stringContaining("only in a chat") });
  });

  it("is offered in a chat — with the changes paused too, as it changes nothing — never unattended", () => {
    expect(toolsFor(user(), { hidden: new Set(), actionsPaused: true }).map((t) => t.name)).toContain("show_on_simulator");
    expect(toolsFor(user(), { hidden: new Set(), actionsPaused: false, unattended: true }).map((t) => t.name)).not.toContain("show_on_simulator");
    expect(toolsFor(user(), { hidden: new Set(["simulate"]), actionsPaused: false }).map((t) => t.name)).not.toContain("show_on_simulator");
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


describe("single-snapshot planning reviews", () => {
  it("loads live inputs once for all alternatives and keeps the person's screen untouched", async () => {
    const c = onScreen({ workFridays: true });
    const before = structuredClone(c.screen);
    const r = await compareScenariosTool.run({ variants: [{ label: "As shown" }, { label: "Crew", workersDelta: { Welding: 1 } }] }, c);
    expect(r.ok).toBe(true);
    expect(h.getWhatIfInputs).toHaveBeenCalledTimes(1);
    const data = JSON.parse(r.text);
    expect(data.scope).toMatchObject({ line: "TR", startedFrom: "the scenario on the person's Simulator" });
    expect(data.variants).toHaveLength(2);
    expect(data.alternatives[1].knobs).toMatchObject({ workFridays: true, workersDelta: { Welding: 1 } });
    expect(c.screen).toEqual(before);
    expect(h.actions.saveScenario).not.toHaveBeenCalled();
    expect(h.actions.applyRunOrder).not.toHaveBeenCalled();
  });
  it("checks access and refuses to pretend transformer forecasts describe panels", async () => {
    for (const tool of [compareScenariosTool, stressTestPlanTool, simulationReadinessTool]) {
      const input = { from: "plant" as const, variants: [{ label: "One" }], stresses: [{ label: "Absence", workersDelta: { Welding: -1 } }] };
      expect((await tool.run(input, { ...ctx, hidden: new Set(["simulate"]) })).ok).toBe(false);
      expect((await tool.run(input, { ...ctx, line: "LV" })).ok).toBe(false);
    }
    expect(h.getWhatIfInputs).not.toHaveBeenCalled();
    expect((await simulationReadinessTool.run({ line: "TR" }, { ...ctx, line: "LV" })).ok).toBe(true);
  });
  it("validates bounded batches, labels, worker reductions and conflicting knobs", () => {
    for (const input of [ { variants: [] }, { variants: Array.from({ length: 5 }, (_, i) => ({ label: String(i) })) }, { variants: [{ label: "Same" }, { label: "same" }] }, { variants: [{ label: "Plant baseline" }] }, { variants: [{ label: "Bad", first: ["A"], optimize: true }] }, { from: "plant", saved: "One", variants: [{ label: "One" }] } ]) expect(checkToolInput(compareScenariosTool, input).ok).toBe(false);
    for (const input of [ { stresses: [] }, { stresses: [{ label: "Empty" }] }, { stresses: [{ label: "Adds workers", workersDelta: { Welding: 1 } }] }, { stresses: [{ label: "No change", workersDelta: { Welding: 0 } }] } ]) expect(checkToolInput(stressTestPlanTool, input).ok).toBe(false);
  });
  it("runs independent stress cases from a common saved start with no writes", async () => {
    h.prisma.simScenario.findUnique.mockResolvedValue({ data: { workFridays: true } });
    const r = await stressTestPlanTool.run({ saved: "Friday", stresses: [{ label: "Absent", workersDelta: { Welding: -1 } }, { label: "Station down", downtimes: [{ stage: "cut", fromISO: "2026-10-12", toISO: "2026-10-13" }] }] }, ctx);
    expect(r.ok).toBe(true);
    expect(h.getWhatIfInputs).toHaveBeenCalledTimes(1);
    const data = JSON.parse(r.text);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[1].label).toBe("Selected scenario");
    expect(data.rows[1].trials).toHaveLength(2);
    expect(h.actions.saveScenario).not.toHaveBeenCalled();
    expect(h.actions.applyRunOrder).not.toHaveBeenCalled();
  });
  it("reports missing coverage explicitly and returns saved-source navigation", async () => {
    const r = await simulationReadinessTool.run({}, ctx);
    expect(JSON.parse(r.text)).toMatchObject({ coverage: null, issues: expect.arrayContaining([expect.objectContaining({ code: "unknown-coverage" })]) });
    expect(r.links).toContainEqual({ label: "What-if Simulator", href: "/simulate" });
  });
});
