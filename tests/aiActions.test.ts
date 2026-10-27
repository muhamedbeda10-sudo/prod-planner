import { beforeEach, describe, expect, it, vi } from "vitest";

// The chat's own actions (app/ai/actions.ts): an answer shared on — to
// colleagues' inboxes under the inbox's own key and caps, kept as one's own
// report, or posted in the team chat as text — and chats renamed, pinned or
// deleted, only one's own.

const h = vi.hoisted(() => ({
  prisma: { aiConversation: { updateMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() }, aiFeedback: { deleteMany: vi.fn() }, $executeRaw: vi.fn(), $transaction: vi.fn(), user: { findMany: vi.fn() }, chatGroup: { findMany: vi.fn() }, aiInboxItem: { count: vi.fn() } },
  me: { id: 7, name: "Sara" },
  perms: new Set<string>(),
  hidden: new Set<string>(),
  deliver: vi.fn(),
  send: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => h.me, hasPerm: (_u: unknown, k: string) => h.perms.has(k), hiddenTabsOf: () => h.hidden }));
vi.mock("@/lib/server/ai/access", () => ({ aiStatusFor: async () => ({ ok: true, visible: true }), apiKeyOf: () => "sk", getAiSettings: async () => ({ model: "claude-opus-5-5" }) }));
vi.mock("@/lib/server/ai/vision", () => ({ seenMeasurer: () => undefined }));
vi.mock("@/lib/server/ai/files", () => ({ discardFile: vi.fn(), storeAiFile: vi.fn() }));
vi.mock("@/lib/server/ai/changes", () => ({ actionsOfConversation: vi.fn(), approveAction: vi.fn(), rejectAction: vi.fn(), undoAction: vi.fn() }));
vi.mock("@/lib/server/ai/tools", () => ({ READ_TOOL_TITLES: {} }));
vi.mock("@/lib/server/ai/memory", () => ({ forgetFor: vi.fn(), memoriesOf: vi.fn(), rememberFor: vi.fn() }));
vi.mock("@/lib/server/inbox", () => ({ deliverToInbox: h.deliver }));
vi.mock("@/app/chat/actions", () => ({ sendChatMessage: h.send }));

import { deleteAiConversations, loadAiShareTargets, pinAiConversations, renameAiConversation, shareAiAnswer, shareAiAnswerToChat } from "@/app/ai/actions";

const answer = "**Ten late** ([Source](#ai-source-a)).\n\n```followups\n[\"Why?\"]\n```";

beforeEach(() => {
  vi.resetAllMocks();
  h.perms.clear();
  h.hidden.clear();
  h.prisma.user.findMany.mockImplementation(async ({ where }: { where: { id?: { in?: number[] } } }) => (where.id?.in ? where.id.in.map((id) => ({ id })) : [{ id: 2, name: "Ahmed" }, { id: 3, name: "Mona" }]));
  h.prisma.chatGroup.findMany.mockResolvedValue([{ id: 5, name: "Welding" }]);
  h.prisma.aiInboxItem.count.mockResolvedValue(0);
  h.deliver.mockImplementation(async (items: unknown[]) => items.map((_, i) => 30 + i));
});

describe("sharing an answer", () => {
  it("sends to colleagues as a message from me, without the chat's follow-ups and source links, and keeps a report for me", async () => {
    h.perms.add("ai.automations");
    expect(await shareAiAnswer({ title: "Late", body: answer, question: "Who is late?", userIds: [2, 2, 7, 3], keep: true })).toEqual({ ok: true, sent: 3 });
    expect(h.deliver.mock.calls[0][0]).toEqual([
      expect.objectContaining({ userId: 2, kind: "message", title: "Late", body: "> Who is late?\n\n**Ten late**.", fromName: "Sara — from their AI chat", fromUserId: 7 }),
      expect.objectContaining({ userId: 3, kind: "message" }),
    ]);
    expect(h.deliver.mock.calls[1][0]).toEqual([expect.objectContaining({ userId: 7, kind: "report", fromName: "Kept from your AI chat", fromUserId: 7 })]);
  });
  it("needs the automations key for colleagues, never for one's own inbox", async () => {
    expect((await shareAiAnswer({ title: "", body: "x", userIds: [2] })).error).toContain("automations key");
    expect(h.deliver).not.toHaveBeenCalled();
    expect(await shareAiAnswer({ title: "", body: "x", userIds: [], keep: true })).toEqual({ ok: true, sent: 1 });
    expect(h.deliver.mock.calls[0][0][0]).toMatchObject({ userId: 7, kind: "report", title: "From the AI assistant" });
  });
  it("holds the inbox's caps: nobody, too many, the hour's messages, the length", async () => {
    h.perms.add("ai.automations");
    expect((await shareAiAnswer({ title: "", body: "x", userIds: [7] })).error).toBe("Pick who gets it.");
    expect((await shareAiAnswer({ title: "", body: "x", userIds: Array.from({ length: 21 }, (_, i) => i + 10) })).error).toContain("1 to 20");
    h.prisma.aiInboxItem.count.mockResolvedValue(60);
    expect((await shareAiAnswer({ title: "", body: "x", userIds: [2] })).error).toContain("in an hour");
    expect((await shareAiAnswer({ title: "", body: "x".repeat(60_001), userIds: [2] })).ok).toBe(false);
    expect((await shareAiAnswer({ title: "", body: "   ", userIds: [2] })).error).toBe("There is nothing to send.");
  });
  it("offers colleagues' inboxes only with the key, and the chat only when it is open", async () => {
    expect(await loadAiShareTargets()).toEqual({ ok: true, people: [{ id: 2, name: "Ahmed" }, { id: 3, name: "Mona" }], groups: [{ id: 5, name: "Welding" }], inbox: false, chat: true });
    h.hidden.add("chat");
    expect(await loadAiShareTargets()).toEqual({ ok: true, people: [], groups: [], inbox: false, chat: false });
  });
  it("posts in the chat through its own action, cut to its length, and never when the chat is hidden", async () => {
    h.send.mockResolvedValue({ ok: true });
    const r = await shareAiAnswerToChat({ kind: "group", to: 5, body: `**A** ${"x".repeat(2500)}` });
    expect(r).toEqual({ ok: true, cut: true });
    const fd = h.send.mock.calls[0][0] as FormData;
    expect(fd.get("kind")).toBe("group");
    expect(fd.get("to")).toBe("5");
    expect(String(fd.get("body")).length).toBeLessThanOrEqual(2000);
    expect(String(fd.get("body")).endsWith("…")).toBe(true);
    expect(String(fd.get("body")).startsWith("A x")).toBe(true);
    h.hidden.add("chat");
    expect((await shareAiAnswerToChat({ kind: "user", to: 2, body: "hi" })).ok).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("a chat's name and place", () => {
  it("renames and pins only the person's own chat", async () => {
    h.prisma.aiConversation.updateMany.mockResolvedValue({ count: 1 });
    expect(await renameAiConversation(4, "  Welding   week 43 ")).toEqual({ ok: true });
    expect(h.prisma.aiConversation.updateMany).toHaveBeenCalledWith({ where: { id: 4, userId: 7 }, data: { title: "Welding week 43" } });
    expect((await renameAiConversation(4, "x".repeat(81))).ok).toBe(false);
    expect((await renameAiConversation(4, "  ")).ok).toBe(false);
  });

  it("pins only the person's own chats, without touching when they were last used", async () => {
    h.prisma.aiConversation.findMany.mockResolvedValue([{ id: 4 }]);
    h.prisma.$executeRaw.mockResolvedValue(1);
    expect(await pinAiConversations([4, 9, 4, -1], true)).toEqual({ ok: true, changed: [4] });
    expect(h.prisma.aiConversation.findMany).toHaveBeenCalledWith({ where: { id: { in: [4, 9] }, userId: 7 }, select: { id: true } });
    // raw SQL: a client update would stamp updatedAt
    expect(h.prisma.aiConversation.updateMany).not.toHaveBeenCalled();
    const [, pinned, ids, userId] = h.prisma.$executeRaw.mock.calls[0];
    expect([pinned, ids, userId]).toEqual([true, [4], 7]);
    expect((await pinAiConversations([], true)).ok).toBe(false);
  });

  it("deletes only the person's own chats, with their ratings, together", async () => {
    h.prisma.aiConversation.findMany.mockResolvedValue([{ id: 4 }]);
    h.prisma.$transaction.mockResolvedValue([]);
    expect(await deleteAiConversations([4, 9])).toEqual({ ok: true, deleted: [4] });
    expect(h.prisma.aiConversation.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [4] }, userId: 7 } });
    expect(h.prisma.aiFeedback.deleteMany).toHaveBeenCalledWith({ where: { conversationId: { in: [4] } } });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    // none of theirs: nothing deleted
    h.prisma.aiConversation.findMany.mockResolvedValue([]);
    expect(await deleteAiConversations([9])).toEqual({ ok: true, deleted: [] });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((await deleteAiConversations("1,2" as unknown as number[])).ok).toBe(false);
  });
});
