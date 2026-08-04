import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the chat server actions ---------------------------------
// The actions wrap Prisma + the session guard + Vercel Blob + the
// (fire-and-forget) Realtime broadcast. We stub all four and assert on the
// guards, the rows written, the topics broadcast to, and the visibility rules.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      user: { findUnique: fn(), findMany: fn() },
      masterOrder: { findUnique: fn(), findMany: fn() },
      chatMessage: { create: fn(), update: fn(), updateMany: fn(), findUnique: fn(), findMany: fn(), groupBy: fn(), count: fn() },
    },
    getCurrentUser: vi.fn(),
    broadcast: vi.fn(),
    blobPut: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: h.getCurrentUser }));
vi.mock("@/lib/server/realtimeBroadcast", () => ({ broadcast: h.broadcast, realtimeConfigured: true }));
vi.mock("@vercel/blob", () => ({ put: h.blobPut }));

import {
  sendChatMessage, openChatThread, pollChat, deleteChatMessageForMe,
} from "@/app/chat/actions";
import { getChatContacts, getChatThread, getChatUnreadCount } from "@/lib/server/chat";

const ME = { id: 1, name: "Beda", active: true };
const NOW = new Date("2026-08-04T10:00:00Z");

function form(fields: Record<string, string>, files: File[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const f of files) fd.append("files", f);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token"); // uploads go to the mocked blob
  h.getCurrentUser.mockResolvedValue(ME);
  h.prisma.user.findUnique.mockResolvedValue({ active: true });
  h.prisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.chatMessage.findMany.mockResolvedValue([]);
  h.prisma.chatMessage.groupBy.mockResolvedValue([]);
  h.prisma.chatMessage.count.mockResolvedValue(0);
  h.blobPut.mockResolvedValue({ url: "https://blob.example/chat/x" });
});

describe("sendChatMessage", () => {
  it("rejects a logged-out caller", async () => {
    h.getCurrentUser.mockResolvedValue(null);
    const res = await sendChatMessage(form({ to: "2", body: "hi" }));
    expect(res.ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("rejects empty, oversize, and self-addressed messages", async () => {
    expect((await sendChatMessage(form({ to: "2", body: "   " }))).ok).toBe(false);
    expect((await sendChatMessage(form({ to: "2", body: "x".repeat(2001) }))).ok).toBe(false);
    expect((await sendChatMessage(form({ to: "1", body: "hello me" }))).ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("rejects an inactive or unknown recipient", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    expect((await sendChatMessage(form({ to: "2", body: "hi" }))).ok).toBe(false);
    h.prisma.user.findUnique.mockResolvedValue({ active: false });
    expect((await sendChatMessage(form({ to: "2", body: "hi" }))).ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("stores the trimmed message and broadcasts to both users' topics", async () => {
    h.prisma.chatMessage.create.mockResolvedValue({ id: 7, fromId: 1, toId: 2, body: "hi", mo: null, createdAt: NOW });

    const res = await sendChatMessage(form({ to: "2", body: "  hi  " }));

    expect(res.ok).toBe(true);
    expect(res.message).toMatchObject({ id: 7, fromId: 1, toId: 2, body: "hi", createdAt: NOW.toISOString() });
    expect(h.prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromId: 1, toId: 2, body: "hi", mo: null, attachments: null }) }),
    );
    const topics = h.broadcast.mock.calls.map((c) => c[0]);
    expect(topics).toContain("chat-user-2"); // the recipient's tab
    expect(topics).toContain("chat-user-1"); // the sender's other tabs
  });

  it("rejects an attached MO that is not in the orders registry", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue(null);
    const res = await sendChatMessage(form({ to: "2", body: "look", mo: "PF01/MO/999" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("PF01/MO/999");
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("stores a valid MO chip and lets it stand alone as the whole message", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue({ mo: "PF01/MO/35271" });
    h.prisma.chatMessage.create.mockResolvedValue({ id: 8, fromId: 1, toId: 2, body: "", mo: "PF01/MO/35271", createdAt: NOW });

    const res = await sendChatMessage(form({ to: "2", body: "", mo: "PF01/MO/35271" }));

    expect(res.ok).toBe(true);
    expect(res.message?.mo).toBe("PF01/MO/35271");
  });

  it("uploads whitelisted files to blob storage and stores their metadata", async () => {
    h.prisma.chatMessage.create.mockResolvedValue({ id: 9, fromId: 1, toId: 2, body: "", mo: null, createdAt: NOW });
    const pdf = new File([new Uint8Array(100)], "report.pdf", { type: "application/pdf" });

    const res = await sendChatMessage(form({ to: "2", body: "" }, [pdf]));

    expect(res.ok).toBe(true);
    expect(h.blobPut).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(h.prisma.chatMessage.create.mock.calls[0][0].data.attachments);
    expect(stored).toEqual([
      { url: "https://blob.example/chat/x", name: "report.pdf", size: 100, type: "application/pdf" },
    ]);
    expect(res.message?.attachments[0]).toMatchObject({ name: "report.pdf" });
  });

  it("rejects file types outside the whitelist and files over 10 MB", async () => {
    const exe = new File([new Uint8Array(10)], "virus.exe", { type: "application/x-msdownload" });
    expect((await sendChatMessage(form({ to: "2", body: "" }, [exe]))).ok).toBe(false);

    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    expect((await sendChatMessage(form({ to: "2", body: "" }, [big]))).ok).toBe(false);

    expect(h.blobPut).not.toHaveBeenCalled();
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });
});

describe("deleteChatMessageForMe", () => {
  it("hides the caller's OWN side only — sender flag when caller sent it", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 1, toId: 2 });
    const res = await deleteChatMessageForMe(5);
    expect(res.ok).toBe(true);
    expect(h.prisma.chatMessage.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { hiddenForFrom: true },
    });
  });

  it("recipient flag when the caller received it", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 1 });
    await deleteChatMessageForMe(5);
    expect(h.prisma.chatMessage.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { hiddenForTo: true },
    });
  });

  it("refuses a message the caller is not part of", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 3 });
    const res = await deleteChatMessageForMe(5);
    expect(res.ok).toBe(false);
    expect(h.prisma.chatMessage.update).not.toHaveBeenCalled();
  });
});

describe("visibility of hidden messages", () => {
  it("thread query excludes what the caller deleted, per side", async () => {
    await getChatThread(1, 2);
    const where = h.prisma.chatMessage.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { fromId: 1, toId: 2, hiddenForFrom: false },
      { fromId: 2, toId: 1, hiddenForTo: false },
    ]);
  });

  it("unread count ignores messages the recipient deleted", async () => {
    await getChatUnreadCount(1);
    expect(h.prisma.chatMessage.count).toHaveBeenCalledWith({
      where: { toId: 1, readAt: null, hiddenForTo: false },
    });
  });
});

describe("openChatThread", () => {
  it("returns the thread oldest-first and stamps the other side's messages read", async () => {
    // the loader fetches newest-first (to cap at 200) and reverses
    h.prisma.chatMessage.findMany.mockResolvedValue([
      { id: 9, fromId: 2, toId: 1, body: "second", mo: null, attachments: null, createdAt: NOW },
      { id: 8, fromId: 1, toId: 2, body: "first", mo: null, attachments: null, createdAt: NOW },
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
      .mockResolvedValueOnce([{ id: 12, fromId: 2, toId: 1, body: "new", mo: null, attachments: null, createdAt: NOW }])
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
      { id: 20, fromId: 3, toId: 1, body: "urgent!", mo: null, attachments: null, createdAt: NOW },
      { id: 15, fromId: 1, toId: 2, body: "", mo: null, attachments: JSON.stringify([{ url: "u", name: "sheet.xlsx", size: 9, type: "application/vnd.ms-excel" }]), createdAt: new Date("2026-08-03T09:00:00Z") },
    ]);

    const contacts = await getChatContacts(1);

    expect(contacts.map((c) => c.id)).toEqual([3, 2]); // Mona's unread outranks the newer name sort
    expect(contacts[0]).toMatchObject({ unread: 2, lastBody: "urgent!", lastFromMe: false });
    // a text-less message previews as its attachment
    expect(contacts[1]).toMatchObject({ unread: 0, lastBody: "📎 sheet.xlsx", lastFromMe: true });
  });
});
