import { beforeEach, describe, expect, it, vi } from "vitest";

// The morning review (lib/server/automations/review.ts) and the playbook's
// tools: who gets a review and when, that it runs once a day as the person
// and only ever asks, and that rules of the plant are an admin's to write.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      user: { findMany: fn() },
      userPref: { findUnique: fn(), updateMany: fn(), create: fn() },
      aiUsage: { create: fn(), update: fn(), findFirst: fn() },
      holiday: { findMany: fn() },
      aiPlaybookEntry: { findUnique: fn() },
    },
    perms: new Set<string>(),
    status: { ok: true },
    settings: { model: "claude-opus-5-5", effort: "high", autoModel: "claude-haiku-5-5", autoEffort: "low", maxCalls: 12, actionsPaused: false, reviewAt: "07:30", reviewPaused: false },
    ask: fn(),
    toolsFor: fn(),
    deliverToInbox: fn(),
    savePlaybookRule: fn(),
    setPlaybookRuleActive: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ effectiveUser: (u: unknown) => u, hasPerm: (_u: unknown, k: string) => h.perms.has(k), hiddenTabsOf: () => new Set<string>() }));
vi.mock("@/lib/server/ai/access", () => ({ aiStatusFor: async () => h.status, apiKeyOf: () => "sk", getAiSettings: async () => h.settings }));
vi.mock("@/lib/server/ai/agent", () => ({ ask: h.ask, questionMessages: (q: string, c: string) => [{ role: "user", content: q }, { role: "system", content: c }] }));
vi.mock("@/lib/server/ai/tools", () => ({ toolsFor: h.toolsFor }));
vi.mock("@/lib/server/ai/playbook", async (orig) => ({ ...(await orig<typeof import("@/lib/server/ai/playbook")>()), getPlaybookText: async () => "" }));
vi.mock("@/lib/server/inbox", () => ({ deliverToInbox: h.deliverToInbox }));
vi.mock("@/app/ai/playbook/actions", () => ({ savePlaybookRule: h.savePlaybookRule, setPlaybookRuleActive: h.setPlaybookRuleActive }));

import type { User } from "@prisma/client";
import { runDailyReviews } from "@/lib/server/automations/review";
import { savePlaybookRuleTool, setPlaybookRuleActiveTool } from "@/lib/server/ai/tools/playbook";
import type { ToolCtx } from "@/lib/server/ai/tools/types";

const sara = { id: 7, name: "Sara", active: true, isAdmin: false, perms: "ai.suggestions" };
const monday0730 = new Date("2026-10-12T04:30:00Z");
const answer = { added: [], tokens: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: 3, queries: 2, changes: 1, stop: "end_turn", text: "Two orders slip today." };

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.perms.add("ai.suggestions");
  h.status.ok = true;
  h.settings.reviewAt = "07:30";
  h.settings.reviewPaused = false;
  h.prisma.holiday.findMany.mockResolvedValue([]);
  h.prisma.user.findMany.mockResolvedValue([sara]);
  h.prisma.userPref.findUnique.mockResolvedValue(null);
  h.prisma.userPref.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.userPref.create.mockResolvedValue({});
  h.prisma.aiUsage.create.mockResolvedValue({ id: 5 });
  h.prisma.aiUsage.findFirst.mockResolvedValue({ question: "إيه الأوردرات المتأخرة؟" });
  h.toolsFor.mockReturnValue([{ kind: "write", area: "tracker" }]);
  h.ask.mockImplementation(async (o: { events: { action: (v: { id: number }) => void } }) => {
    o.events.action({ id: 88 });
    return answer;
  });
});

describe("the morning review", () => {
  it("runs from 07:30 on a working day, as the person, asks before every change, and lands in their inbox", async () => {
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(1);
    const call = h.ask.mock.calls[0][0];
    expect(call).toMatchObject({ allowAuto: false, via: "automation", ctx: { user: sara, conversationId: null } });
    expect(call.question[0].content).toContain("Write it in Egyptian Arabic");
    expect(call.question[1].content).toContain("Every one waits for their approval — none runs by itself.");
    expect(h.deliverToInbox).toHaveBeenCalledWith([expect.objectContaining({ userId: 7, kind: "suggestion", title: "Today's review — 2026-10-12", body: "Two orders slip today.", actionIds: [88] })]);
    expect(h.prisma.aiUsage.update.mock.calls[0][0].data).toMatchObject({ calls: 3, costUsd: expect.any(Number) });
  });

  it("not before 07:30, not on a Friday or a holiday", async () => {
    expect(await runDailyReviews({ now: new Date("2026-10-12T04:00:00Z"), deadline: Date.now() + 60_000 })).toBe(0);
    expect(await runDailyReviews({ now: new Date("2026-10-16T06:00:00Z"), deadline: Date.now() + 60_000 })).toBe(0);
    h.prisma.holiday.findMany.mockResolvedValue([{ date: new Date("2026-10-12T00:00:00Z") }]);
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(0);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it("goes out from the owner's time, on the automations' model, and not while switched off", async () => {
    h.settings.reviewAt = "09:00";
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(0);
    h.settings.reviewAt = "07:00";
    h.settings.reviewPaused = true;
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(0);
    expect(h.ask).not.toHaveBeenCalled();
    h.settings.reviewPaused = false;
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(1);
    expect(h.ask.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-5-5", effort: "low", maxCalls: 12 });
  });

  it("once a day: a person reviewed today, or being reviewed by another tick, is passed by", async () => {
    h.prisma.userPref.findUnique.mockResolvedValue({ value: "2026-10-12" });
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(0);
    h.prisma.userPref.findUnique.mockResolvedValue({ value: "2026-10-11" });
    h.prisma.userPref.create.mockRejectedValueOnce(new Error("unique"));
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(0);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it("writes in English for someone who asks in English, and says nothing when the assistant is not open to them", async () => {
    h.prisma.aiUsage.findFirst.mockResolvedValue({ question: "Which orders are late?" });
    await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 });
    expect(h.ask.mock.calls[0][0].question[0].content).toContain("Write it in English");
    vi.clearAllMocks();
    h.prisma.userPref.updateMany.mockResolvedValue({ count: 1 });
    h.status.ok = false;
    await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 });
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.deliverToInbox).not.toHaveBeenCalled();
  });

  it("only for the people the owner ticked it for", async () => {
    h.perms.clear();
    expect(await runDailyReviews({ now: monday0730, deadline: Date.now() + 60_000 })).toBe(0);
  });
});

describe("the playbook through the assistant", () => {
  const ctx = (isAdmin: boolean): ToolCtx => ({ user: { id: 1, name: "Omar", isAdmin } as User, hidden: new Set(), now: new Date(), todayISO: "2026-10-12", conversationId: 1, automationId: null });
  const rule = { topic: "planning", title: "Big tanks first", body: "Tanks of 1000 kVA and up are welded first in bay 2." };

  it("is an admin's; a new rule is undone by retiring it, a rewrite by its old words", async () => {
    expect(await savePlaybookRuleTool.describe(rule, ctx(false))).toEqual({ error: "Only an admin keeps the plant's playbook." });
    expect(await savePlaybookRuleTool.describe(rule, ctx(true))).toMatchObject({ title: "New playbook rule: Big tanks first", summary: expect.stringContaining("for everyone") });
    h.savePlaybookRule.mockResolvedValue({ ok: true, id: 12 });
    expect((await savePlaybookRuleTool.execute(rule, ctx(true))).undo).toEqual({ tool: "set_playbook_rule_active", input: { id: 12, active: false } });
    h.prisma.aiPlaybookEntry.findUnique.mockResolvedValue({ id: 12, topic: "planning", title: "Big tanks", body: "Old words.", active: true, updatedAt: new Date() });
    expect((await savePlaybookRuleTool.execute({ ...rule, id: 12 }, ctx(true))).undo).toEqual({ tool: "save_playbook_rule", input: { id: 12, topic: "planning", title: "Big tanks", body: "Old words." } });
    expect(savePlaybookRuleTool.risk).toBe("high");
  });

  it("retiring a rule is undone by bringing it back", async () => {
    h.prisma.aiPlaybookEntry.findUnique.mockResolvedValue({ id: 12, topic: "planning", title: "Big tanks", body: "x", active: true, updatedAt: new Date() });
    expect(await setPlaybookRuleActiveTool.describe({ id: 12, active: true }, ctx(true))).toEqual({ error: "Rule #12 is in force already." });
    h.setPlaybookRuleActive.mockResolvedValue({ ok: true, id: 12 });
    expect((await setPlaybookRuleActiveTool.execute({ id: 12, active: false }, ctx(true))).undo).toEqual({ tool: "set_playbook_rule_active", input: { id: 12, active: true } });
  });
});
