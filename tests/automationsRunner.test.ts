import { beforeEach, describe, expect, it, vi } from "vitest";

// Running automations (lib/server/automations/runner.ts): what fires, what is
// sent to whom, what a condition remembers between checks, what a failure
// does, and that the assistant runs as the owner — against a stubbed database,
// assistant and inbox.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      automation: { findMany: fn(), updateMany: fn(), update: fn(), count: fn() },
      automationRun: { create: fn(), update: fn(), findFirst: fn(), count: fn() },
      user: { findUnique: fn(), findMany: fn() },
      aiUsage: { create: fn(), update: fn() },
      holiday: { findMany: fn() },
    },
    perms: new Set<string>(),
    status: { ok: true, reason: null as string | null },
    settings: {
      automationsPaused: false, actionsPaused: false, model: "claude-opus-5-5", effort: "medium", autoModel: "claude-sonnet-5-5", autoEffort: "low",
      maxCalls: 10, apiKeyEnc: "v1:x", autoFrom: null as string | null, autoTo: null as string | null, autoWeekdays: [0, 1, 2, 3, 4, 5, 6],
      reviewAt: "07:30", reviewPaused: true,
    },
    runAiRows: fn(),
    ask: fn(),
    toolsFor: fn(),
    deliverToInbox: fn(),
    createTask: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({
  effectiveUser: (u: unknown) => u,
  hasPerm: (_u: unknown, k: string) => h.perms.has(k),
  hiddenTabsOf: (u: { hiddenTabs?: string } | null) => new Set((u?.hiddenTabs ?? "").split(",").filter(Boolean)),
}));
vi.mock("@/lib/server/ai/access", () => ({
  aiStatusFor: async () => h.status,
  apiKeyOf: () => "sk-test",
  getAiSettings: async () => h.settings,
}));
vi.mock("@/lib/server/ai/agent", () => ({ ask: h.ask, questionMessages: (q: string, c: string) => [{ role: "user", content: q }, { role: "system", content: c }] }));
vi.mock("@/lib/server/ai/changes", () => ({ expireProposals: vi.fn() }));
vi.mock("@/lib/server/ai/tools", () => ({ toolsFor: h.toolsFor }));
vi.mock("@/lib/server/ai/playbook", () => ({ getPlaybookText: async () => "" }));
vi.mock("@/lib/server/ai/reader", () => ({ runAiRows: h.runAiRows }));
vi.mock("@/lib/server/inbox", () => ({ deliverToInbox: h.deliverToInbox }));
vi.mock("@/app/tasks/actions", () => ({ createTask: h.createTask }));

import type { Automation } from "@prisma/client";
import { runAutomation, runDueAutomations, runEventAutomations } from "@/lib/server/automations/runner";
import type { AppEventView } from "@/lib/domain/appEvents";

const owner = { id: 7, name: "Sara", active: true, isOwner: false, isAdmin: false, hiddenTabs: "" };
const now = new Date("2026-10-12T04:30:00Z"); // Monday 07:30 Cairo
const auto = (o: Partial<Automation> = {}): Automation => ({
  id: 3, ownerId: 7, name: "Late welding", enabled: true, trigger: "schedule", times: ["07:30"], days: "working", weekdays: [],
  conditionSql: null, checkEveryMin: 30, activeFrom: null, activeTo: null, eventTypes: [], eventActorIds: [], eventMatch: null, action: "notify", message: "Good morning — {name}", prompt: null,
  recipientIds: [9], lastKeys: [], nextRunAt: now, lastRunAt: null, lastCheckAt: null, lastStatus: null, lastNote: null, failures: 0,
  lockedUntil: null, deletedAt: null, createdBy: "Sara (AI)", updatedBy: null, createdAt: now, updatedAt: now,
  taskDueDays: 1, taskUrgent: false, escalateAfterMin: null, keySeenAt: {}, escalatedKeys: [], ...o,
});
/** The data of the last write to the automation's row — the schedule goes
 *  through updateMany (kept only while the row is as it was), the rest through update. */
const lastUpdate = () => {
  const of = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c, i) => ({ data: c[0].data, n: m.mock.invocationCallOrder[i] }));
  return [...of(h.prisma.automation.update), ...of(h.prisma.automation.updateMany)].sort((a, b) => a.n - b.n).at(-1)!.data;
};
const askAnswer = { added: [], tokens: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 1, queries: 0, changes: 0, stop: "end_turn", text: "Report" };

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.perms.add("ai.automations");
  h.status.ok = true;
  h.settings.automationsPaused = false;
  h.settings.actionsPaused = false;
  h.settings.autoFrom = null;
  h.settings.autoTo = null;
  h.settings.autoWeekdays = [0, 1, 2, 3, 4, 5, 6];
  h.prisma.user.findUnique.mockResolvedValue(owner);
  h.prisma.user.findMany.mockResolvedValue([{ id: 9, name: "Ahmed" }]);
  h.prisma.holiday.findMany.mockResolvedValue([]);
  h.prisma.automationRun.create.mockResolvedValue({ id: 50 });
  h.prisma.aiUsage.create.mockResolvedValue({ id: 70 });
  h.prisma.automation.update.mockResolvedValue({});
  h.prisma.automation.updateMany.mockResolvedValue({ count: 1 });
  h.deliverToInbox.mockImplementation(async (items: unknown[]) => items.map((_, i) => 100 + i));
  h.toolsFor.mockReturnValue([{ kind: "read", name: "query_database" }]);
  let task = 200;
  h.createTask.mockImplementation(async () => ({ ok: true, ids: [task++] }));
});

describe("a scheduled message", () => {
  it("goes to the people named, as the owner's automation, and books the next working day", async () => {
    expect(await runAutomation(auto(), { cause: "schedule", now })).toBe(true);
    expect(h.deliverToInbox).toHaveBeenCalledWith([
      { userId: 9, kind: "message", title: "\u2068Late welding\u2069", body: "Good morning — Late welding", fromName: "Sara's automation “\u2068Late welding\u2069”", automationId: 3, runId: 50 },
    ]);
    expect(h.prisma.automationRun.update.mock.calls[0][0].data).toMatchObject({ status: "ok", inboxIds: [100] });
    expect(lastUpdate()).toMatchObject({ lastStatus: "ok", failures: 0, lockedUntil: null, nextRunAt: new Date("2026-10-13T04:30:00Z") });
    expect(h.ask).not.toHaveBeenCalled();
  });
});

describe("a condition", () => {
  const cond = (o: Partial<Automation> = {}) => auto({ trigger: "condition", conditionSql: "SELECT mo AS key, mo FROM x", message: "{count} held", ...o });

  it("fires only for rows that were not there at the last check", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A", mo: "A" }, { key: "B", mo: "B" }] });
    await runAutomation(cond({ lastKeys: ["A"] }), { cause: "condition", now });
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ title: "\u2068Late welding\u2069 — 1 new", body: "1 held\n\n- **MO:** B" });
    expect(lastUpdate()).toMatchObject({ lastKeys: ["A", "B"], lastStatus: "ok" });
  });

  it("with nothing new is no run at all — it only remembers what it saw", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A" }] });
    expect(await runAutomation(cond({ lastKeys: ["A", "B"] }), { cause: "condition", now })).toBe(false);
    expect(h.prisma.automationRun.create).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ lastKeys: ["A"], lockedUntil: null });
  });

  it("keeps what it saw before when the run fails, so the rows are tried again", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "B" }] });
    h.deliverToInbox.mockRejectedValueOnce(new Error("database gone"));
    await runAutomation(cond({ lastKeys: [] }), { cause: "condition", now });
    expect(lastUpdate()).toMatchObject({ lastStatus: "failed", failures: 1 });
    expect(lastUpdate()).not.toHaveProperty("lastKeys");
  });

  it("refuses to watch a query that matches too much", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: true, rows: [] });
    await runAutomation(cond(), { cause: "condition", now });
    expect(h.prisma.automationRun.create.mock.calls[0][0].data).toMatchObject({ status: "failed", error: expect.stringContaining("too broad") });
  });
});

describe("failures", () => {
  it("the fifth in a row stops the automation and tells its owner", async () => {
    h.deliverToInbox.mockRejectedValueOnce(new Error("boom"));
    await runAutomation(auto({ failures: 4 }), { cause: "schedule", now });
    expect(lastUpdate()).toMatchObject({ enabled: false, failures: 5, lastStatus: "failed" });
    expect(h.deliverToInbox).toHaveBeenLastCalledWith([expect.objectContaining({ userId: 7, title: "Automation stopped: \u2068Late welding\u2069", body: expect.stringContaining("failed 5 times") })]);
  });

  it("an owner who lost automations stops it, and is told why", async () => {
    h.perms.clear();
    await runAutomation(auto(), { cause: "schedule", now });
    expect(lastUpdate()).toMatchObject({ enabled: false, lastStatus: "skipped", lastNote: expect.stringContaining("AI — automations") });
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ userId: 7, title: "Automation stopped: \u2068Late welding\u2069" });
  });
});

describe("the assistant's runs", () => {
  const answer = (o: Record<string, unknown> = {}) => ({ added: [], tokens: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 2, queries: 1, changes: 0, stop: "end_turn", text: "## Welding\nAll on time.", ...o });

  it("a report reads only, runs as the owner, is sent as written, and is paid for like a question", async () => {
    h.ask.mockResolvedValue(answer());
    await runAutomation(auto({ action: "report", message: null, prompt: "Welding vs plan" }), { cause: "schedule", now });
    expect(h.toolsFor).toHaveBeenCalledWith(owner, { hidden: expect.any(Set), actionsPaused: true, unattended: true });
    const call = h.ask.mock.calls[0][0];
    expect(call).toMatchObject({ via: "automation", ctx: { user: owner, automationId: 3, conversationId: null } });
    expect(call.question[1].content).toContain("Your final answer is sent as it is to Ahmed");
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ userId: 9, kind: "report", body: "## Welding\nAll on time." });
    expect(h.prisma.aiUsage.update.mock.calls[0][0].data).toMatchObject({ calls: 2, costUsd: expect.any(Number), finishedAt: expect.any(Date) });
  });

  it("is skipped, not failed, when the assistant is not available to the owner", async () => {
    h.status.ok = false;
    h.status.reason = "userCap";
    await runAutomation(auto({ action: "report", prompt: "x" }), { cause: "schedule", now });
    expect(h.ask).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ lastStatus: "skipped" });
  });

  it("act: what it prepared waits in the owner's inbox, the changes on its cards", async () => {
    h.perms.add("ai.automations.act");
    h.ask.mockImplementation(async (o: { events: { action: (v: { id: number }) => void } }) => {
      o.events.action({ id: 41 });
      o.events.action({ id: 42 });
      return answer({ text: "Two orders to hold." });
    });
    await runAutomation(auto({ action: "act", prompt: "Hold what has no steel", recipientIds: [] }), { cause: "schedule", now });
    expect(h.deliverToInbox.mock.calls[0][0]).toEqual([expect.objectContaining({ userId: 7, kind: "suggestion", actionIds: [41, 42], body: "Two orders to hold." })]);
  });
});

describe("a test run", () => {
  it("sends to the one testing, marked, and leaves the schedule as it was", async () => {
    await runAutomation(auto(), { cause: "manual", now, testTo: { ...owner, id: 1, name: "Owner" } as never });
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ userId: 1, title: "[Test] \u2068Late welding\u2069" });
    expect(lastUpdate()).toEqual({ lockedUntil: null });
  });

  it("a test of an act automation prepares its changes and runs none of them unasked", async () => {
    h.perms.add("ai.automations.act");
    h.ask.mockResolvedValue(askAnswer);
    await runAutomation(auto({ action: "act", message: null, prompt: "Move held orders' dates", recipientIds: [] }), { cause: "manual", now, testTo: { ...owner, id: 1, name: "Owner" } as never });
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.ask.mock.calls[0][0]).toMatchObject({ allowAuto: false });
  });
});

describe("a tick", () => {
  it("does nothing while the owner has paused the automations", async () => {
    h.settings.automationsPaused = true;
    expect(await runDueAutomations({ now })).toMatchObject({ ran: 0, skipped: expect.stringContaining("paused") });
    expect(h.prisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("runs what is due, each claimed first so two ticks never run it twice", async () => {
    h.prisma.automation.findMany.mockResolvedValue([auto({ id: 3 }), auto({ id: 4 })]);
    // #4's claim fails: another tick has it
    const isClaim = (data: Record<string, unknown>) => Object.keys(data).length === 1 && "lockedUntil" in data;
    h.prisma.automation.updateMany.mockImplementation(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({ count: isClaim(data) && where.id === 4 ? 0 : 1 }));
    expect(await runDueAutomations({ now, deadline: Date.now() + 60_000 })).toEqual({ ran: 1, checked: 0 });
    expect(h.deliverToInbox).toHaveBeenCalledTimes(1);
    // the claim is for the row as fetched: one another tick ran meanwhile (nextRunAt moved on) is not due any more
    expect(h.prisma.automation.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 3, nextRunAt: now, enabled: true }, data: { lockedUntil: expect.any(Date) } });
  });

  it("gives a run started late in the tick only the time the tick has left", async () => {
    h.ask.mockResolvedValue(askAnswer);
    const deadline = Date.now() + 100_000;
    await runAutomation(auto({ action: "report", message: null, prompt: "Welding vs plan" }), { cause: "schedule", now, deadline });
    const t = h.ask.mock.calls[0][0].timeoutMs as number;
    expect(t).toBeGreaterThan(140_000);
    expect(t).toBeLessThanOrEqual(150_000);
    expect(h.ask.mock.calls[0][0]).not.toHaveProperty("allowAuto");
  });

  it("keeps a time or condition saved while the run was going, instead of writing the old schedule back", async () => {
    // the row moved on (nextRunAt changed by an edit): the schedule write finds nothing
    h.prisma.automation.updateMany.mockResolvedValue({ count: 0 });
    expect(await runAutomation(auto(), { cause: "schedule", now })).toBe(true);
    const schedule = h.prisma.automation.updateMany.mock.calls.at(-1)![0];
    expect(schedule).toMatchObject({ where: { id: 3, nextRunAt: now }, data: { lastStatus: "ok", nextRunAt: new Date("2026-10-13T04:30:00Z") } });
    // the run's own record is still written — without touching the schedule
    const fallback = h.prisma.automation.update.mock.calls.at(-1)![0];
    expect(fallback.data).toMatchObject({ lastStatus: "ok", failures: 0, lockedUntil: null });
    expect(fallback.data).not.toHaveProperty("nextRunAt");
  });
});

describe("the owner's hours", () => {
  it("outside them nothing runs: a schedule due now is moved on to its next time, the skip on its record", async () => {
    h.settings.autoFrom = "08:00";
    h.settings.autoTo = "18:00"; // 07:30 Cairo is before
    h.prisma.automation.findMany.mockResolvedValue([auto({ id: 3 })]);
    h.prisma.automation.updateMany.mockResolvedValue({ count: 1 });
    expect(await runDueAutomations({ now })).toMatchObject({ ran: 0, skipped: expect.stringContaining("hours") });
    expect(h.prisma.automation.findMany.mock.calls[0][0].where).toMatchObject({ trigger: "schedule" });
    expect(h.prisma.automation.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 3, nextRunAt: now },
      data: { nextRunAt: new Date("2026-10-13T04:30:00Z"), lastStatus: "skipped", lastNote: expect.stringContaining("08:00–18:00") },
    });
    expect(h.prisma.automationRun.create.mock.calls[0][0].data).toMatchObject({ automationId: 3, status: "skipped" });
    expect(h.deliverToInbox).not.toHaveBeenCalled();
  });

  it("a weekday not ticked counts as outside them", async () => {
    h.settings.autoWeekdays = [0, 2, 3]; // not Monday
    h.prisma.automation.findMany.mockResolvedValue([]);
    expect(await runDueAutomations({ now })).toMatchObject({ ran: 0, skipped: expect.stringContaining("hours") });
  });

  it("inside them it runs as before", async () => {
    h.settings.autoFrom = "07:00";
    h.settings.autoTo = "19:00";
    h.prisma.automation.findMany.mockResolvedValue([auto()]);
    h.prisma.automation.updateMany.mockResolvedValue({ count: 1 });
    expect(await runDueAutomations({ now, deadline: Date.now() + 60_000 })).toEqual({ ran: 1, checked: 0 });
  });
});

describe("an AI run", () => {
  it("uses the automations' own model, effort and steps", async () => {
    h.ask.mockResolvedValue({ added: [], tokens: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 1, queries: 0, changes: 0, stop: "end_turn", text: "Report" });
    await runAutomation(auto({ action: "report", message: null, prompt: "Welding vs plan" }), { cause: "schedule", now });
    expect(h.ask.mock.calls[0][0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", maxCalls: 10 });
    expect(h.prisma.aiUsage.create.mock.calls[0][0].data).toMatchObject({ model: "claude-sonnet-5-5" });
  });
});

describe("an event", () => {
  const rule = (o: Partial<Automation> = {}) =>
    auto({ trigger: "event", times: [], nextRunAt: null, eventTypes: ["order.closed"], eventActorIds: [], eventMatch: null, message: "{who}: {detail}", ...o });
  const event = (o: Partial<AppEventView> = {}): AppEventView => ({
    id: 1, type: "order.closed", at: now.toISOString(), actorId: 10, actorName: "Ahmed", subject: "SF01/MO/1", summary: "Closed SF01/MO/1", ...o,
  });
  const fire = async (a: Automation, e: AppEventView = event()) => {
    h.prisma.automation.findMany.mockResolvedValue([a]);
    return runEventAutomations(e, now);
  };

  beforeEach(() => {
    h.prisma.automationRun.count.mockResolvedValue(0);
    h.prisma.automation.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.user.findUnique.mockResolvedValue({ ...owner, hiddenTabs: "" });
  });

  it("tells at once, in the owner's words, about what happened — and books no next run", async () => {
    expect(await fire(rule())).toBe(1);
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ userId: 9, kind: "message", title: "\u2068Late welding\u2069 — \u2068Ahmed: Closed SF01/MO/1\u2069", body: "Ahmed: Closed SF01/MO/1" });
    expect(h.prisma.automationRun.create.mock.calls[0][0].data).toMatchObject({ cause: "event" });
    expect(lastUpdate()).toMatchObject({ lastStatus: "ok", nextRunAt: null });
  });

  it("listens only for its people and its words", async () => {
    expect(await fire(rule({ eventActorIds: [9] }))).toBe(0);
    expect(await fire(rule({ eventMatch: "MO/2" }))).toBe(0);
    expect(await fire(rule({ eventActorIds: [10], eventMatch: "mo/1" }))).toBe(1);
  });

  it("tells of a task only someone on the task, and of a screen only someone who sees it", async () => {
    const task = event({ type: "task.done", subject: "Task #5", summary: "Marked done “Clean bay 2”", participants: [1, 9] });
    expect(await fire(rule({ eventTypes: ["task.done"] }), task)).toBe(0);
    expect(await fire(rule({ eventTypes: ["task.done"] }), { ...task, participants: [7, 9] })).toBe(1);
    h.prisma.user.findUnique.mockResolvedValue({ ...owner, hiddenTabs: "odoo" });
    expect(await fire(rule({ eventTypes: ["odoo.logged"] }), event({ type: "odoo.logged" }))).toBe(0);
  });

  it("stays quiet while paused, and past so many messages an hour", async () => {
    h.settings.automationsPaused = true;
    expect(await fire(rule())).toBe(0);
    h.settings.automationsPaused = false;
    h.prisma.automationRun.count.mockResolvedValue(30);
    expect(await fire(rule())).toBe(0);
    expect(h.deliverToInbox).not.toHaveBeenCalled();
  });

  it("writes a report only inside the automations' hours, and not again within minutes", async () => {
    h.settings.autoFrom = "08:00";
    h.settings.autoTo = "16:00"; // now is 07:30 Cairo
    expect(await fire(rule({ action: "report", message: null, prompt: "Say what this means for the week." }))).toBe(0);
    h.settings.autoFrom = null;
    h.settings.autoTo = null;
    expect(await fire(rule({ action: "report", message: null, prompt: "Say what this means.", lastRunAt: new Date(now.getTime() - 5 * 60_000) }))).toBe(0);
    expect(h.ask).not.toHaveBeenCalled();
  });
});

describe("a task automation", () => {
  const cond = (o: Partial<Automation> = {}) =>
    auto({ trigger: "condition", conditionSql: "SELECT mo AS key, mo FROM x", action: "task", message: "Chase {mo}\nCall the line about {mo} ({count} new)", ...o });
  const form = (n: number) => Object.fromEntries((h.createTask.mock.calls[n][0] as FormData).entries());
  beforeEach(() => h.perms.add("tasks.assign"));

  it("gives one task per new row, as the owner, due in working days", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A", mo: "A" }, { key: "B", mo: "B" }, { key: "C", mo: "C" }] });
    await runAutomation(cond({ lastKeys: ["A"], taskDueDays: 1, taskUrgent: true }), { cause: "condition", now });
    expect(h.createTask).toHaveBeenCalledTimes(2);
    expect(form(0)).toEqual({ title: "Chase B", details: "Call the line about B (2 new)", people: "9", priority: "urgent", due: "2026-10-13" });
    expect(form(1)).toMatchObject({ title: "Chase C" });
    expect(lastUpdate()).toMatchObject({ lastStatus: "ok", lastKeys: ["A", "B", "C"], lastNote: "Gave 2 task(s): #200, #201." });
  });

  it("given part-way, keeps the rows it saw to and tries the rest again", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A", mo: "A" }, { key: "B", mo: "B" }, { key: "C", mo: "C" }] });
    h.createTask.mockResolvedValueOnce({ ok: true, ids: [300] }).mockResolvedValueOnce({ ok: false, error: "Too many tasks this hour." });
    await runAutomation(cond(), { cause: "condition", now });
    expect(lastUpdate()).toMatchObject({ lastStatus: "failed", failures: 1, lastKeys: ["A"], lastNote: expect.stringContaining("Gave 1 task(s): #300; then: Too many tasks this hour.") });
  });

  it("stops when its owner may no longer give tasks", async () => {
    h.perms.delete("tasks.assign");
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A", mo: "A" }] });
    await runAutomation(cond(), { cause: "condition", now });
    expect(h.createTask).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ enabled: false, lastStatus: "skipped" });
  });

  it("past the rows a run may task, gives one task that lists them, within the details' limit", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ key: `K${i}`, mo: `MO-${i}`, note: "x".repeat(110) }));
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows });
    await runAutomation(cond({ message: "Chase the late ones\nThere are {count}." }), { cause: "condition", now });
    expect(h.createTask).toHaveBeenCalledTimes(1);
    expect(form(0).title).toBe("Chase the late ones");
    expect(String(form(0).details).length).toBeLessThanOrEqual(4000);
    expect(String(form(0).details)).toContain("There are 30.");
  });
});

describe("escalation", () => {
  const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const cond = (o: Partial<Automation> = {}) => auto({ trigger: "condition", conditionSql: "SELECT mo AS key, mo FROM x", message: "{count} stopped", escalateAfterMin: 60, ...o });

  it("sends a row still there after the time up to the plant's owner, once — on a check with nothing new too", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A", mo: "A" }] });
    expect(await runAutomation(cond({ lastKeys: ["A"], keySeenAt: { A: twoHoursAgo } }), { cause: "condition", now })).toBe(false);
    expect(h.deliverToInbox).toHaveBeenCalledTimes(1);
    expect(h.deliverToInbox.mock.calls[0][0].map((m: { userId: number }) => m.userId)).toEqual([1, 7]);
    expect(h.deliverToInbox.mock.calls[0][0][0].title).toContain("still there after 1 h");
    expect(lastUpdate()).toMatchObject({ escalatedKeys: ["A"], keySeenAt: { A: twoHoursAgo } });

    h.deliverToInbox.mockClear();
    await runAutomation(cond({ lastKeys: ["A"], keySeenAt: { A: twoHoursAgo }, escalatedKeys: ["A"] }), { cause: "condition", now });
    expect(h.deliverToInbox).not.toHaveBeenCalled();
  });

  it("what went up stays up when the run then fails — it is not sent up again", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A", mo: "A" }, { key: "B", mo: "B" }] });
    h.deliverToInbox.mockImplementationOnce(async (items: unknown[]) => items.map((_, i) => 100 + i)).mockRejectedValueOnce(new Error("database gone"));
    await runAutomation(cond({ lastKeys: ["A"], keySeenAt: { A: twoHoursAgo } }), { cause: "condition", now });
    expect(lastUpdate()).toMatchObject({ lastStatus: "failed", escalatedKeys: ["A"] });
    expect(lastUpdate()).not.toHaveProperty("lastKeys");
  });
});

describe("an event's task", () => {
  const rule = (o: Partial<Automation> = {}) =>
    auto({ trigger: "event", times: [], nextRunAt: null, eventTypes: ["order.closed"], action: "task", message: "Check {about}", ...o });
  const event = (o: Partial<AppEventView> = {}): AppEventView => ({
    id: 1, type: "order.closed", at: now.toISOString(), actorId: 10, actorName: "Ahmed", subject: "SF01/MO/1", summary: "Closed SF01/MO/1", ...o,
  });
  beforeEach(() => {
    h.perms.add("tasks.assign");
    h.prisma.automationRun.count.mockResolvedValue(0);
  });

  it("goes like a message — at any hour and minutes after the last — not like a report", async () => {
    h.settings.autoFrom = "08:00";
    h.settings.autoTo = "16:00"; // now is 07:30 Cairo
    h.prisma.automation.findMany.mockResolvedValue([rule({ lastRunAt: new Date(now.getTime() - 5 * 60_000) })]);
    expect(await runEventAutomations(event(), now)).toBe(1);
    expect(Object.fromEntries((h.createTask.mock.calls[0][0] as FormData).entries())).toMatchObject({ title: "Check SF01/MO/1" });
  });

  it("is never set off by what an automation did itself", async () => {
    h.prisma.automation.findMany.mockResolvedValue([rule({ eventTypes: ["task.given"] })]);
    expect(await runEventAutomations(event({ type: "task.given", participants: [7], byAutomation: true }), now)).toBe(0);
    expect(h.createTask).not.toHaveBeenCalled();
  });
});
