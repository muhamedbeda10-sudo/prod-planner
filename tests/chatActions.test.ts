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
      chatMessage: { create: fn(), update: fn(), updateMany: fn(), findUnique: fn(), findFirst: fn(), findMany: fn(), groupBy: fn(), count: fn() },
      chatGroup: { create: fn(), findUnique: fn(), delete: fn() },
      chatGroupMember: { findUnique: fn(), findMany: fn(), updateMany: fn(), createMany: fn(), deleteMany: fn(), count: fn() },
      chatMessageHide: { upsert: fn() },
      chatReaction: { findUnique: fn(), upsert: fn(), delete: fn() },
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
  togglePinChatMessage, toggleChatReaction, createChatGroup,
} from "@/app/chat/actions";
import { getChatContacts, getChatThread, getChatUnreadCount } from "@/lib/server/chat";

const ME = { id: 1, name: "Beda", active: true };
const NOW = new Date("2026-08-04T10:00:00Z");

// a stored row as the include-shaped loaders see it
const row = (over: Partial<Record<string, unknown>>) => ({
  id: 1, fromId: 2, toId: 1, groupId: null, body: "hi", mo: null, attachments: null,
  pinnedAt: null, replyTo: null, createdAt: NOW, from: { name: "Aly" }, reactions: [],
  ...over,
});

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
  h.prisma.chatMessage.findFirst.mockResolvedValue(null);
  h.prisma.chatMessage.groupBy.mockResolvedValue([]);
  h.prisma.chatMessage.count.mockResolvedValue(0);
  h.prisma.chatGroupMember.findMany.mockResolvedValue([]);
  h.prisma.chatGroupMember.findUnique.mockResolvedValue(null);
  h.prisma.chatGroupMember.updateMany.mockResolvedValue({ count: 0 });
  h.blobPut.mockResolvedValue({ url: "https://blob.example/chat/x" });
});

describe("sendChatMessage — direct", () => {
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

  it("stores the trimmed message and broadcasts to both users' topics", async () => {
    h.prisma.chatMessage.create.mockResolvedValue({ id: 7, fromId: 1, toId: 2, groupId: null, body: "hi", mo: null, createdAt: NOW });

    const res = await sendChatMessage(form({ to: "2", body: "  hi  " }));

    expect(res.ok).toBe(true);
    expect(res.message).toMatchObject({ id: 7, fromId: 1, toId: 2, body: "hi", fromName: "Beda" });
    expect(h.prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromId: 1, toId: 2, groupId: null, body: "hi" }) }),
    );
    const topics = h.broadcast.mock.calls.map((c) => c[0]);
    expect(topics).toContain("chat-user-2"); // the recipient's tab
    expect(topics).toContain("chat-user-1"); // the sender's other tabs
  });

  it("rejects an attached MO that is not in the orders registry", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue(null);
    const res = await sendChatMessage(form({ to: "2", body: "look", mo: "PF01/MO/999" }));
    expect(res.ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("uploads whitelisted files to blob storage and stores their metadata", async () => {
    h.prisma.chatMessage.create.mockResolvedValue({ id: 9, fromId: 1, toId: 2, groupId: null, body: "", mo: null, createdAt: NOW });
    const pdf = new File([new Uint8Array(100)], "report.pdf", { type: "application/pdf" });

    const res = await sendChatMessage(form({ to: "2", body: "" }, [pdf]));

    expect(res.ok).toBe(true);
    const stored = JSON.parse(h.prisma.chatMessage.create.mock.calls[0][0].data.attachments);
    expect(stored).toEqual([
      { url: "https://blob.example/chat/x", name: "report.pdf", size: 100, type: "application/pdf" },
    ]);
  });

  it("rejects file types outside the whitelist and files over 10 MB", async () => {
    const exe = new File([new Uint8Array(10)], "virus.exe", { type: "application/x-msdownload" });
    expect((await sendChatMessage(form({ to: "2", body: "" }, [exe]))).ok).toBe(false);
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    expect((await sendChatMessage(form({ to: "2", body: "" }, [big]))).ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("stores a reply to a message from the SAME conversation, with its quote", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({
      id: 40, fromId: 2, toId: 1, groupId: null, body: "original text", mo: null, attachments: null,
      from: { name: "Aly" },
    });
    h.prisma.chatMessage.create.mockResolvedValue({ id: 41, fromId: 1, toId: 2, groupId: null, body: "reply", mo: null, createdAt: NOW });

    const res = await sendChatMessage(form({ to: "2", body: "reply", replyTo: "40" }));

    expect(res.ok).toBe(true);
    expect(h.prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyToId: 40 }) }),
    );
    expect(res.message?.replyTo).toEqual({ id: 40, fromId: 2, fromName: "Aly", snippet: "original text" });
  });

  it("refuses a reply that quotes a message from ANOTHER conversation", async () => {
    // the quoted message lives in a chat between users 2 and 3 — not ours
    h.prisma.chatMessage.findUnique.mockResolvedValue({
      id: 40, fromId: 2, toId: 3, groupId: null, body: "elsewhere", mo: null, attachments: null,
      from: { name: "Aly" },
    });
    const res = await sendChatMessage(form({ to: "2", body: "reply", replyTo: "40" }));
    expect(res.ok).toBe(false);
    expect(h.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("falls back to an inline data URL for photos when Blob is absent on Vercel", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "1");
    h.prisma.chatMessage.create.mockResolvedValue({ id: 10, fromId: 1, toId: 2, groupId: null, body: "", mo: null, createdAt: NOW });
    const img = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });

    const res = await sendChatMessage(form({ to: "2", body: "" }, [img]));

    expect(res.ok).toBe(true);
    expect(res.message?.attachments[0].url).toMatch(/^data:image\/jpeg;base64,/);
    expect(h.blobPut).not.toHaveBeenCalled();

    // documents cannot inline — clear refusal instead of a lost file
    const pdf = new File([new Uint8Array(10)], "doc.pdf", { type: "application/pdf" });
    expect((await sendChatMessage(form({ to: "2", body: "" }, [pdf]))).ok).toBe(false);
  });
});

describe("sendChatMessage — group", () => {
  it("requires membership and broadcasts to every member", async () => {
    // not a member
    expect((await sendChatMessage(form({ kind: "group", to: "5", body: "hi" }))).ok).toBe(false);

    h.prisma.chatGroupMember.findUnique.mockResolvedValue({ id: 1 });
    h.prisma.chatGroupMember.findMany.mockResolvedValue([{ userId: 1 }, { userId: 2 }, { userId: 3 }]);
    h.prisma.chatMessage.create.mockResolvedValue({ id: 11, fromId: 1, toId: null, groupId: 5, body: "hi", mo: null, createdAt: NOW });

    const res = await sendChatMessage(form({ kind: "group", to: "5", body: "hi" }));

    expect(res.ok).toBe(true);
    expect(h.prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toId: null, groupId: 5 }) }),
    );
    const topics = h.broadcast.mock.calls.map((c) => c[0]);
    expect(topics).toEqual(expect.arrayContaining(["chat-user-1", "chat-user-2", "chat-user-3"]));
  });
});

describe("deleteChatMessageForMe", () => {
  it("hides the caller's OWN side of a DM only", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 1, toId: 2, groupId: null });
    await deleteChatMessageForMe(5);
    expect(h.prisma.chatMessage.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { hiddenForFrom: true } });

    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 1, groupId: null });
    await deleteChatMessageForMe(5);
    expect(h.prisma.chatMessage.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { hiddenForTo: true } });
  });

  it("uses a per-member hide row for group messages", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: null, groupId: 5 });
    h.prisma.chatGroupMember.findUnique.mockResolvedValue({ id: 1 });
    const res = await deleteChatMessageForMe(9);
    expect(res.ok).toBe(true);
    expect(h.prisma.chatMessageHide.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { messageId: 9, userId: 1 } }),
    );
    expect(h.prisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("refuses a message the caller is not part of", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 3, groupId: null });
    const res = await deleteChatMessageForMe(5);
    expect(res.ok).toBe(false);
    expect(h.prisma.chatMessage.update).not.toHaveBeenCalled();
  });
});

describe("pins & reactions", () => {
  it("pins and unpins, participants only, and broadcasts a sync", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 1, groupId: null, pinnedAt: null });
    const res = await togglePinChatMessage(4);
    expect(res.ok).toBe(true);
    expect(h.prisma.chatMessage.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { pinnedAt: expect.any(Date), pinnedBy: 1 },
    });
    expect(h.broadcast.mock.calls.some((c) => c[1] === "sync")).toBe(true);

    // outsider
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 3, groupId: null, pinnedAt: null });
    expect((await togglePinChatMessage(4)).ok).toBe(false);
  });

  it("same emoji removes the reaction, a different one replaces it", async () => {
    h.prisma.chatMessage.findUnique.mockResolvedValue({ fromId: 2, toId: 1, groupId: null });
    h.prisma.chatReaction.findUnique.mockResolvedValue({ id: 77, emoji: "👍" });

    await toggleChatReaction(4, "👍"); // same → delete
    expect(h.prisma.chatReaction.delete).toHaveBeenCalledWith({ where: { id: 77 } });

    await toggleChatReaction(4, "❤️"); // different → replace
    expect(h.prisma.chatReaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { emoji: "❤️" } }),
    );
  });
});

describe("createChatGroup", () => {
  it("creates the group with the caller inside and pings every member", async () => {
    h.prisma.user.findMany.mockResolvedValue([{ id: 2 }, { id: 3 }]);
    h.prisma.chatGroup.create.mockResolvedValue({ id: 8 });

    const res = await createChatGroup("Welding team", [2, 3, 3, 1]); // dupes + self are dropped

    expect(res).toEqual({ ok: true, groupId: 8 });
    const created = h.prisma.chatGroup.create.mock.calls[0][0].data;
    expect(created.members.create).toEqual([{ userId: 1 }, { userId: 2 }, { userId: 3 }]);
    expect(h.broadcast).toHaveBeenCalledTimes(3);
  });

  it("needs a name and at least one other member", async () => {
    expect((await createChatGroup("  ", [2])).ok).toBe(false);
    expect((await createChatGroup("Team", [1])).ok).toBe(false); // only self
  });
});

describe("visibility of hidden messages", () => {
  it("DM thread query excludes what the caller deleted, per side", async () => {
    await getChatThread(1, "user", 2);
    const where = h.prisma.chatMessage.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { fromId: 1, toId: 2, hiddenForFrom: false },
      { fromId: 2, toId: 1, hiddenForTo: false },
    ]);
  });

  it("group thread query excludes the caller's hide rows", async () => {
    await getChatThread(1, "group", 5);
    const where = h.prisma.chatMessage.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ groupId: 5, hides: { none: { userId: 1 } } });
  });

  it("unread count spans DMs and group cursors", async () => {
    h.prisma.chatMessage.count.mockResolvedValueOnce(2); // DM unread
    h.prisma.chatGroupMember.findMany.mockResolvedValue([{ groupId: 5, lastReadId: 10 }]);
    h.prisma.chatMessage.count.mockResolvedValueOnce(3); // group unread

    expect(await getChatUnreadCount(1)).toBe(5);
    expect(h.prisma.chatMessage.count).toHaveBeenNthCalledWith(2, {
      where: { fromId: { not: 1 }, OR: [{ groupId: 5, id: { gt: 10 } }] },
    });
  });
});

describe("openChatThread / pollChat", () => {
  it("DM open returns oldest-first and stamps the other side read", async () => {
    h.prisma.chatMessage.findMany.mockResolvedValue([
      row({ id: 9, body: "second" }),
      row({ id: 8, fromId: 1, toId: 2, body: "first", from: { name: "Beda" } }),
    ]);

    const res = await openChatThread("user", 2);

    expect(res.ok).toBe(true);
    expect(res.messages?.map((m) => m.id)).toEqual([8, 9]);
    expect(h.prisma.chatMessage.updateMany).toHaveBeenCalledWith({
      where: { fromId: 2, toId: 1, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it("DM read stamps broadcast a sync to the sender so their ticks go blue", async () => {
    h.prisma.chatMessage.updateMany.mockResolvedValue({ count: 2 }); // something became read
    await openChatThread("user", 2);
    expect(h.broadcast).toHaveBeenCalledWith("chat-user-2", "sync", { kind: "user", id: 1 });

    // nothing new became read → no broadcast, no sync loop
    h.broadcast.mockClear();
    h.prisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    await openChatThread("user", 2);
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("group open advances the member's read cursor to the latest id and pings members", async () => {
    h.prisma.chatGroupMember.findUnique.mockResolvedValue({ id: 1, lastReadId: 10 });
    h.prisma.chatGroupMember.findMany.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
    h.prisma.chatMessage.findFirst.mockResolvedValue({ id: 42 });

    const res = await openChatThread("group", 5);

    expect(res.ok).toBe(true);
    expect(h.prisma.chatGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: 5, userId: 1 },
      data: { lastReadId: 42 },
    });
    expect(h.broadcast.mock.calls.filter((c) => c[1] === "sync")).toHaveLength(2);

    // cursor already at the latest id → no write, no broadcast
    h.prisma.chatGroupMember.updateMany.mockClear();
    h.broadcast.mockClear();
    h.prisma.chatGroupMember.findUnique.mockResolvedValue({ id: 1, lastReadId: 42 });
    await openChatThread("group", 5);
    expect(h.prisma.chatGroupMember.updateMany).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("poll returns new messages plus a LIGHT state snapshot (no bodies, no attachments)", async () => {
    h.prisma.chatMessage.findMany
      .mockResolvedValueOnce([row({ id: 12, body: "new" })]) // thread increment
      .mockResolvedValueOnce([{ id: 11, pinnedAt: null, readAt: NOW, reactions: [{ userId: 2, emoji: "👍" }] }]) // state slice
      .mockResolvedValueOnce([]); // contacts preview slice
    h.prisma.user.findMany.mockResolvedValue([]);

    const res = await pollChat("user", 2, 11);

    expect(res.ok).toBe(true);
    expect(res.messages?.map((m) => m.id)).toEqual([12]);
    expect(h.prisma.chatMessage.findMany.mock.calls[0][0].where).toMatchObject({ id: { gt: 11 } });
    // the state query must stay light — ids/pins/reads/reactions ONLY
    const stateSelect = h.prisma.chatMessage.findMany.mock.calls[1][0].select;
    expect(stateSelect.body).toBeUndefined();
    expect(stateSelect.attachments).toBeUndefined();
    expect(res.state).toEqual([
      { id: 11, pinnedAt: null, readAt: NOW.toISOString(), reactions: [{ emoji: "👍", count: 1, mine: false }] },
    ]);
  });
});

describe("getChatContacts", () => {
  it("merges users and groups, unread first, with reaction-aware previews", async () => {
    h.prisma.user.findMany.mockResolvedValue([
      { id: 2, name: "Aly", isAdmin: false },
      { id: 3, name: "Mona", isAdmin: true },
    ]);
    h.prisma.chatGroupMember.findMany.mockResolvedValue([
      { lastReadId: 0, group: { id: 5, name: "Welding team", _count: { members: 3 } } },
    ]);
    h.prisma.chatMessage.groupBy
      .mockResolvedValueOnce([{ fromId: 3, _count: { _all: 2 } }]) // DM unread
      .mockResolvedValueOnce([{ groupId: 5, _count: { _all: 4 } }]); // group unread
    h.prisma.chatMessage.findMany.mockResolvedValue([
      row({ id: 20, fromId: 3, body: "urgent!", from: { name: "Mona" } }),
      row({ id: 18, fromId: 2, groupId: 5, toId: null, body: "in the group", from: { name: "Aly" }, createdAt: new Date("2026-08-03T09:00:00Z") }),
    ]);

    const contacts = await getChatContacts(1);

    expect(contacts.map((c) => `${c.kind}:${c.id}`)).toEqual(["user:3", "group:5", "user:2"]);
    expect(contacts[0]).toMatchObject({ unread: 2, lastBody: "urgent!" });
    expect(contacts[1]).toMatchObject({ kind: "group", unread: 4, memberCount: 3, lastFromName: "Aly" });
  });
});
