import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the chat server actions ---------------------------------
// The actions wrap Prisma + the session guard + the (fire-and-forget) Realtime
// broadcast. We stub all three and assert on the guards, the rows written, and
// the topics broadcast to.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      user: { findUnique: fn(), findMany: fn() },
      chatMessage: { create: fn(), updateMany: fn(), findMany: fn(), groupBy: fn(), count: fn() },
    },
    getCurrentUser: vi.fn(),
    broadcast: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: h.getCurrentUser }));
vi.mock("@/lib/server/realtimeBroadcast", () => ({ broadcast: h.broadcast, realtimeConfigured: true }));

import { sendChatMessage, openChatThread, pollChat } from "@/app/chat/actions";
import { getChatContacts } from "@/lib/server/chat";

const ME = { id: 1, name: "Beda", active: true };
const NOW = new Date("2026-08-04T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.getCurrentUser.mockResolvedValue(ME);
  h.prisma.user.findUnique.mockResolvedValue({ active: true });
  h.prisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.chatMessage.findMany.mockResolvedValue([]);
  h.prisma.chatMessage.groupBy.mockResolvedValue([]);
  h.prisma.chatMessage.count.mockResolvedValue(0);
});

describe("sendChatMessage", () => {
  it("rejects a logged-out caller", async () => {
    h.getCurrentUser.mockResolvedValue(null);
    const res = await sendChatMessage(2, "hi");
    expect(res.ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("rejects empty, oversize, and self-addressed messages", async () => {
    expect((await sendChatMessage(2, "   ")).ok).toBe(false);
    expect((await sendChatMessage(2, "x".repeat(2001))).ok).toBe(false);
    expect((await sendChatMessage(1, "hello me")).ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("rejects an inactive or unknown recipient", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    expect((await sendChatMessage(2, "hi")).ok).toBe(false);
    h.prisma.user.findUnique.mockResolvedValue({ active: false });
    expect((await sendChatMessage(2, "hi")).ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("stores the trimmed message and broadcasts to both users' topics", async () => {
    h.prisma.chatMessage.create.mockResolvedValue({ id: 7, fromId: 1, toId: 2, body: "hi", createdAt: NOW });

    const res = await sendChatMessage(2, "  hi  ");

    expect(res.ok).toBe(true);
    expect(res.message).toEqual({ id: 7, fromId: 1, toId: 2, body: "hi", createdAt: NOW.toISOString() });
    expect(h.prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fromId: 1, toId: 2, body: "hi" } }),
    );
    const topics = h.broadcast.mock.calls.map((c) => c[0]);
    expect(topics).toContain("chat-user-2"); // the recipient's tab
    expect(topics).toContain("chat-user-1"); // the sender's other tabs
  });
});

describe("openChatThread", () => {
  it("returns the thread oldest-first and stamps the other side's messages read", async () => {
    // the loader fetches newest-first (to cap at 200) and reverses
    h.prisma.chatMessage.findMany.mockResolvedValue([
      { id: 9, fromId: 2, toId: 1, body: "second", createdAt: NOW },
      { id: 8, fromId: 1, toId: 2, body: "first", createdAt: NOW },
    ]);

    const res = await openChatThread(2);

    expect(res.ok).toBe(true);
    expect(res.messages?.map((m) => m.id)).toEqual([8, 9]);
    expect(h.prisma.chatMessage.updateMany).toHaveBeenCalledWith({
      where: { fromId: 2, toId: 1, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});

describe("pollChat", () => {
  it("returns only messages after the cursor for the open thread", async () => {
    h.prisma.chatMessage.findMany
      // thread increment (afterId path)
      .mockResolvedValueOnce([{ id: 12, fromId: 2, toId: 1, body: "new", createdAt: NOW }])
      // contacts preview slice
      .mockResolvedValueOnce([]);
    h.prisma.user.findMany.mockResolvedValue([]);

    const res = await pollChat(2, 11);

    expect(res.ok).toBe(true);
    expect(res.messages?.map((m) => m.id)).toEqual([12]);
    const threadCall = h.prisma.chatMessage.findMany.mock.calls[0][0];
    expect(threadCall.where).toMatchObject({ id: { gt: 11 } });
  });

  it("skips the thread query when no conversation is open", async () => {
    h.prisma.user.findMany.mockResolvedValue([]);
    const res = await pollChat(null, 0);
    expect(res.ok).toBe(true);
    expect(res.messages).toEqual([]);
    // only the contacts preview hit chatMessage.findMany
    expect(h.prisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("getChatContacts", () => {
  it("maps unread counts and previews, unread conversations first", async () => {
    h.prisma.user.findMany.mockResolvedValue([
      { id: 2, name: "Aly", isAdmin: false },
      { id: 3, name: "Mona", isAdmin: true },
    ]);
    h.prisma.chatMessage.groupBy.mockResolvedValue([{ fromId: 3, _count: { _all: 2 } }]);
    h.prisma.chatMessage.findMany.mockResolvedValue([
      { id: 20, fromId: 3, toId: 1, body: "urgent!", createdAt: NOW },
      { id: 15, fromId: 1, toId: 2, body: "ok", createdAt: new Date("2026-08-03T09:00:00Z") },
    ]);

    const contacts = await getChatContacts(1);

    expect(contacts.map((c) => c.id)).toEqual([3, 2]); // Mona's unread outranks the newer name sort
    expect(contacts[0]).toMatchObject({ unread: 2, lastBody: "urgent!", lastFromMe: false });
    expect(contacts[1]).toMatchObject({ unread: 0, lastBody: "ok", lastFromMe: true });
  });
});
