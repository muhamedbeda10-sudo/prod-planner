import { beforeEach, describe, expect, it, vi } from "vitest";

// The automations' writes (app/automations/actions.ts) and the assistant's
// tools on top of them: who may keep, change, pause and delete one; that a
// condition is tried and baselined before it is saved; and how each change
// made through the assistant is undone.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      automation: { findUnique: fn(), create: fn(), update: fn(), count: fn() },
      user: { findMany: fn(), findUnique: fn() },
      holiday: { findMany: fn() },
      aiInboxItem: { findMany: fn() },
    },
    me: null as Record<string, unknown> | null,
    perms: new Set<string>(),
    runAiRows: fn(),
    testAutomation: fn(),
    sendInboxMessage: fn(),
    retractInboxMessages: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: async () => h.me,
  requirePerm: async (k: string) => (h.me && h.perms.has(k) ? { user: h.me } : { error: "You do not have permission for this action — ask the admin." }),
  effectiveUser: (u: unknown) => u,
  hasPerm: (_u: unknown, k: string) => h.perms.has(k),
  hiddenTabsOf: () => new Set<string>(),
}));
vi.mock("@/lib/server/ai/reader", () => ({ runAiRows: h.runAiRows }));
vi.mock("@/lib/server/automations/runner", () => ({ testAutomation: h.testAutomation }));
vi.mock("@/app/inbox/actions", () => ({ sendInboxMessage: h.sendInboxMessage, retractInboxMessages: h.retractInboxMessages }));

import { deleteAutomation, saveAutomation, setAutomationEnabled } from "@/app/automations/actions";
import { createAutomationTool, deleteAutomationTool, sendMessageTool, updateAutomationTool } from "@/lib/server/ai/tools/automations";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import type { User } from "@prisma/client";

const sara = { id: 7, name: "Sara", active: true, isOwner: false, isAdmin: false };
const ctx = (): ToolCtx => ({ user: sara as unknown as User, hidden: new Set(), now: new Date("2026-10-12T04:00:00Z"), todayISO: "2026-10-12", conversationId: 1, automationId: null });
const form = (o: Record<string, unknown>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return fd;
};
const schedule = { name: "Morning", trigger: "schedule", times: ["07:30"], days: "working", action: "notify", message: "Good morning" };
const stored = (o: Record<string, unknown> = {}) => ({
  id: 3, ownerId: 7, name: "Morning", enabled: true, trigger: "schedule", times: ["07:30"], days: "working", weekdays: [], conditionSql: null, checkEveryMin: 30,
  activeFrom: null, activeTo: null, action: "notify", message: "Good morning", prompt: null, recipientIds: [], lastKeys: [], deletedAt: null,
  updatedAt: new Date("2026-10-11T10:00:00Z"), ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.me = { ...sara };
  h.perms.clear();
  h.perms.add("ai.automations");
  h.prisma.automation.count.mockResolvedValue(0);
  h.prisma.automation.create.mockResolvedValue({ id: 11 });
  h.prisma.automation.update.mockResolvedValue({ id: 3 });
  h.prisma.holiday.findMany.mockResolvedValue([]);
  h.prisma.user.findMany.mockResolvedValue([]);
});

describe("saveAutomation", () => {
  it("needs AI — automations, and keeps the owner's own", async () => {
    // Monday 07:00 Cairo: the first run is this morning's 07:30
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T04:00:00Z"));
    h.perms.clear();
    expect(await saveAutomation(form({ config: schedule }))).toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    h.perms.add("ai.automations");
    const r = await saveAutomation(form({ config: schedule }));
    expect(r).toEqual({ ok: true, id: 11 });
    expect(h.prisma.automation.create.mock.calls[0][0].data).toMatchObject({ ownerId: 7, createdBy: "Sara", name: "Morning", times: ["07:30"], nextRunAt: new Date("2026-10-12T04:30:00Z") });
    vi.useRealTimers();
  });

  it("will not change someone else's", async () => {
    h.prisma.automation.findUnique.mockResolvedValue(stored({ ownerId: 8 }));
    expect(await saveAutomation(form({ id: "3", config: schedule }))).toEqual({ ok: false, error: "That automation is not yours to change." });
  });

  it("an automation that changes data needs its own key", async () => {
    expect(await saveAutomation(form({ config: { ...schedule, action: "act", message: undefined, prompt: "Hold what has no steel" } }))).toMatchObject({ ok: false, error: expect.stringContaining("may change data") });
  });

  it("tries a condition's query, and remembers what matches now so only what is new fires", async () => {
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "A" }, { key: "B" }] });
    await saveAutomation(form({ config: { ...schedule, trigger: "condition", conditionSql: "SELECT mo AS key FROM held", checkEveryMin: 30 } }));
    expect(h.prisma.automation.create.mock.calls[0][0].data).toMatchObject({ lastKeys: ["A", "B"], trigger: "condition" });
    h.runAiRows.mockResolvedValue({ ok: false, error: "column \"mo\" does not exist" });
    expect(await saveAutomation(form({ config: { ...schedule, trigger: "condition", conditionSql: "SELECT mo FROM held" } }))).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
  });

  it("keeps the number a person may have", async () => {
    h.prisma.automation.count.mockResolvedValue(25);
    expect(await saveAutomation(form({ config: schedule }))).toMatchObject({ ok: false, error: expect.stringContaining("at most 25") });
  });
});

describe("pause, turn on, delete", () => {
  it("turning a condition back on starts its watch afresh", async () => {
    h.prisma.automation.findUnique.mockResolvedValue(stored({ enabled: false, trigger: "condition", conditionSql: "SELECT 1 AS key" }));
    h.prisma.user.findUnique.mockResolvedValue({ ...sara });
    h.runAiRows.mockResolvedValue({ ok: true, truncated: false, rows: [{ key: "1" }] });
    expect(await setAutomationEnabled(form({ id: "3", enabled: "true" }))).toEqual({ ok: true, id: 3 });
    expect(h.prisma.automation.update.mock.calls[0][0].data).toMatchObject({ enabled: true, failures: 0, lastKeys: ["1"] });
  });

  it("the app's owner may pause or delete anyone's; nobody else may", async () => {
    h.prisma.automation.findUnique.mockResolvedValue(stored({ ownerId: 8 }));
    expect(await deleteAutomation(form({ id: "3" }))).toEqual({ ok: false, error: "That automation is not yours." });
    h.me = { ...sara, id: 1, isOwner: true };
    expect(await deleteAutomation(form({ id: "3" }))).toEqual({ ok: true, id: 3 });
    expect(h.prisma.automation.update.mock.calls[0][0].data).toMatchObject({ enabled: false, deletedAt: expect.any(Date) });
  });
});

describe("through the assistant", () => {
  it("making one shows when, what and to whom — and is undone by deleting it", async () => {
    h.prisma.user.findMany.mockImplementation(async ({ where }: { where: { name?: { equals?: string }; id?: { in: number[] } } }) =>
      where.id ? [{ id: 9, name: "Ahmed Ali" }] : where.name?.equals?.toLowerCase() === "ahmed ali" ? [{ id: 9, name: "Ahmed Ali" }] : [],
    );
    const input = { ...schedule, trigger: "schedule" as const, recipients: ["ahmed ali"] };
    const p = await createAutomationTool.describe(input, ctx());
    expect(p).toMatchObject({
      title: "New automation: Morning",
      summary: "Morning: every working day at 07:30 (Cairo) — sends a message to Ahmed Ali.",
      changes: expect.arrayContaining([{ label: "First run", before: "—", after: expect.stringContaining("07:30") }]),
    });
    const out = await createAutomationTool.execute(input, ctx());
    expect(out).toMatchObject({ ok: true, undo: { tool: "delete_automation", input: { id: 11 } } });
    expect(createAutomationTool.risk).toBe("high");
  });

  it("an unclear name is asked about, not guessed", async () => {
    h.prisma.user.findMany.mockImplementation(async ({ where }: { where: { name?: { equals?: string; contains?: string } } }) =>
      where.name?.contains ? [{ id: 9, name: "Ahmed Ali" }, { id: 10, name: "Ahmed Samir" }] : [],
    );
    expect(await createAutomationTool.describe({ ...schedule, trigger: "schedule", recipients: ["Ahmed"] }, ctx())).toEqual({ error: "\"Ahmed\" could be Ahmed Ali, Ahmed Samir — say which." });
  });

  it("a change shows only what changes, and is undone by the configuration it had", async () => {
    h.prisma.automation.findUnique.mockResolvedValue(stored());
    const p = await updateAutomationTool.describe({ id: 3, times: ["08:00"] }, ctx());
    expect(p).toMatchObject({ changes: [{ label: "When", before: "every working day at 07:30 (Cairo)", after: "every working day at 08:00 (Cairo)" }] });
    const out = await updateAutomationTool.execute({ id: 3, times: ["08:00"] }, ctx());
    expect(out.undo).toEqual({ tool: "update_automation", input: { id: 3, name: "Morning", trigger: "schedule", action: "notify", recipientIds: [], times: ["07:30"], days: "working", message: "Good morning" } });
  });

  it("deleting is a deletion, undone by bringing it back as it was", async () => {
    expect(deleteAutomationTool.risk).toBe("destructive");
    h.prisma.automation.findUnique.mockResolvedValue(stored({ enabled: false }));
    expect((await deleteAutomationTool.execute({ id: 3 }, ctx())).undo).toEqual({ tool: "restore_automation", input: { id: 3, enabled: false } });
  });

  it("a message goes through the inbox's own action, and is undone by taking it back", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 9, name: "Ahmed Ali" }]);
    h.sendInboxMessage.mockResolvedValue({ ok: true, ids: [61] });
    const out = await sendMessageTool.execute({ to: ["Ahmed Ali"], title: "Tanks", text: "Start the 1000 kVA tanks first." }, ctx());
    expect(Object.fromEntries((h.sendInboxMessage.mock.calls[0][0] as FormData).entries())).toEqual({ to: "9", title: "Tanks", body: "Start the 1000 kVA tanks first." });
    expect(out.undo).toEqual({ tool: "retract_message", input: { ids: [61] } });
    expect(sendMessageTool.risk).toBe("high");
  });
});
