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
      automationRun: { create: fn(), update: fn(), findFirst: fn() },
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
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({
  effectiveUser: (u: unknown) => u,
  hasPerm: (_u: unknown, k: string) => h.perms.has(k),
  hiddenTabsOf: () => new Set<string>(),
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

import type { Automation } from "@prisma/client";
import { runAutomation, runDueAutomations } from "@/lib/server/automations/runner";

const owner = { id: 7, name: "Sara", active: true, isOwner: false, isAdmin: false, hiddenTabs: "" };
const now = new Date("2026-10-12T04:30:00Z"); // Monday 07:30 Cairo
const auto = (o: Partial<Automation> = {}): Automation => ({
  id: 3, ownerId: 7, name: "Late welding", enabled: true, trigger: "schedule", times: ["07:30"], days: "working", weekdays: [],
  conditionSql: null, checkEveryMin: 30, activeFrom: null, activeTo: null, action: "notify", message: "Good morning — {name}", prompt: null,
  recipientIds: [9], lastKeys: [], nextRunAt: now, lastRunAt: null, lastCheckAt: null, lastStatus: null, lastNote: null, failures: 0,
  lockedUntil: null, deletedAt: null, createdBy: "Sara (AI)", updatedBy: null, createdAt: now, updatedAt: now, ...o,
});
const lastUpdate = () => h.prisma.automation.update.mock.calls.at(-1)![0].data;

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
  h.deliverToInbox.mockImplementation(async (items: unknown[]) => items.map((_, i) => 100 + i));
  h.toolsFor.mockReturnValue([{ kind: "read", name: "query_database" }]);
});

describe("a scheduled message", () => {
  it("goes to the people named, as the owner's automation, and books the next working day", async () => {
    expect(await runAutomation(auto(), { cause: "schedule", now })).toBe(true);
    expect(h.deliverToInbox).toHaveBeenCalledWith([
      { userId: 9, kind: "message", title: "Late welding", body: "Good morning — Late welding", fromName: "Sara's automation “Late welding”", automationId: 3, runId: 50 },
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
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ title: "Late welding — 1 new", body: "1 held\n\n| mo |\n| --- |\n| B |" });
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
    expect(h.deliverToInbox).toHaveBeenLastCalledWith([expect.objectContaining({ userId: 7, title: "Automation stopped: Late welding", body: expect.stringContaining("failed 5 times") })]);
  });

  it("an owner who lost automations stops it, and is told why", async () => {
    h.perms.clear();
    await runAutomation(auto(), { cause: "schedule", now });
    expect(lastUpdate()).toMatchObject({ enabled: false, lastStatus: "skipped", lastNote: expect.stringContaining("AI — automations") });
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ userId: 7, title: "Automation stopped: Late welding" });
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
    expect(h.deliverToInbox.mock.calls[0][0][0]).toMatchObject({ userId: 1, title: "[Test] Late welding" });
    expect(lastUpdate()).toEqual({ lockedUntil: null });
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
    h.prisma.automation.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await runDueAutomations({ now, deadline: Date.now() + 60_000 })).toEqual({ ran: 1, checked: 0 });
    expect(h.deliverToInbox).toHaveBeenCalledTimes(1);
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
