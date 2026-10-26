"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import {
  getChatContacts, getChatInbox, getChatThread, getChatThreadState, isGroupMember, snippetOf,
  type ChatAttachment, type ChatInboxItem, type ChatContact, type ChatMessageDTO, type ChatMessageState,
  type ChatReplyRef, type ThreadKind,
} from "@/lib/server/chat";
import { unreadInboxCount } from "@/lib/server/inbox";
import { broadcast } from "@/lib/server/realtimeBroadcast";
import { chatTopic } from "@/lib/domain/chatTopic";
import { CHAT_MESSAGE_MAX } from "@/lib/domain/chatTopic";
import { filesOf, storeUploads } from "@/lib/server/uploads";

// Chat needs no permission key — every active account can message every other
// and can open a group. What it DOES need is scoping: every query here pins
// the caller's id from the session, so nobody can read, hide, pin or react in
// a thread they aren't part of.

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const MAX_BODY = CHAT_MESSAGE_MAX;
const MAX_FILES = 6;
const MAX_GROUP_NAME = 60;

const kindOf = (raw: unknown): ThreadKind => (raw === "group" ? "group" : "user");

/** Every user topic a thread event should reach: both DM ends, or all group
 *  members (the sender's own topic keeps their other tabs in sync). */
async function threadTopics(meId: number, kind: ThreadKind, otherId: number): Promise<string[]> {
  if (kind === "user") return [chatTopic(meId), chatTopic(otherId)];
  const members = await prisma.chatGroupMember.findMany({
    where: { groupId: otherId },
    select: { userId: true },
  });
  return members.map((m) => chatTopic(m.userId));
}

/** Tell every participant "re-read this thread" — pins and reactions change
 *  EXISTING rows, which the incremental poll never re-fetches. */
async function broadcastSync(meId: number, kind: ThreadKind, otherId: number): Promise<void> {
  const topics = await threadTopics(meId, kind, otherId);
  await Promise.all(topics.map((t) => broadcast(t, "sync", { kind, id: otherId })));
}

export async function sendChatMessage(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; message?: ChatMessageDTO }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };

  const kind = kindOf(formData.get("kind"));
  const targetId = Number(formData.get("to"));
  const text = String(formData.get("body") ?? "").trim();
  const moRaw = String(formData.get("mo") ?? "").trim();
  const replyToId = Number(formData.get("replyTo")) || 0;
  const files = filesOf(formData);

  if (text.length > MAX_BODY) return { ok: false, error: `Message is too long (max ${MAX_BODY} characters).` };
  if (!Number.isInteger(targetId)) return { ok: false, error: "Invalid conversation." };
  if (!text && files.length === 0 && !moRaw) return { ok: false, error: "Message is empty." };
  if (files.length > MAX_FILES) return { ok: false, error: `Max ${MAX_FILES} files per message.` };

  if (kind === "user") {
    if (targetId === me.id) return { ok: false, error: "Invalid recipient." };
    const recipient = await prisma.user.findUnique({ where: { id: targetId }, select: { active: true } });
    if (!recipient?.active) return { ok: false, error: "Recipient not found." };
  } else if (!(await isGroupMember(me.id, targetId))) {
    return { ok: false, error: "You are not in this group." };
  }

  // an attached order must be a REAL order — the chip links to its trace
  let mo: string | null = null;
  if (moRaw) {
    const order = await prisma.masterOrder.findUnique({ where: { mo: moRaw }, select: { mo: true } });
    if (!order) return { ok: false, error: `MO "${moRaw}" is not in the orders registry.` };
    mo = order.mo;
  }

  // a reply must quote a message from THIS conversation — no cross-thread quotes
  let replyRef: ChatReplyRef | null = null;
  if (replyToId) {
    const target = await prisma.chatMessage.findUnique({
      where: { id: replyToId },
      select: {
        id: true, fromId: true, toId: true, groupId: true, body: true, mo: true, attachments: true,
        from: { select: { name: true } },
      },
    });
    const sameThread =
      target &&
      (kind === "group"
        ? target.groupId === targetId
        : target.groupId === null &&
          ((target.fromId === me.id && target.toId === targetId) ||
            (target.fromId === targetId && target.toId === me.id)));
    if (!sameThread) return { ok: false, error: "The message you are replying to is not in this conversation." };
    replyRef = { id: target.id, fromId: target.fromId, fromName: target.from.name, snippet: snippetOf(target) };
  }

  // ---- attachments: whitelist, cap, then store (lib/server/uploads) ----
  const stored = await storeUploads(files, "chat");
  if (!stored.ok) return { ok: false, error: stored.error };
  const attachments: ChatAttachment[] = stored.files;

  const row = await prisma.chatMessage.create({
    data: {
      fromId: me.id,
      toId: kind === "user" ? targetId : null,
      groupId: kind === "group" ? targetId : null,
      body: text,
      mo,
      replyToId: replyRef?.id ?? null,
      attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
    },
    select: { id: true, fromId: true, toId: true, groupId: true, body: true, mo: true, createdAt: true },
  });
  const message: ChatMessageDTO = {
    id: row.id,
    fromId: row.fromId,
    fromName: me.name,
    toId: row.toId,
    groupId: row.groupId,
    body: row.body,
    mo: row.mo,
    attachments,
    pinnedAt: null,
    replyTo: replyRef,
    reactions: [],
    readAt: null,
    createdAt: row.createdAt.toISOString(),
  };

  // live delivery (best-effort) to every participant's own topic
  const topics = await threadTopics(me.id, kind, targetId);
  await Promise.all(topics.map((t) => broadcast(t, "message", { message, fromName: me.name })));

  return { ok: true, message };
}

/** "Delete for me": hide a message from the CALLER's view only — everyone
 *  else keeps it. The row itself is never removed. */
export async function deleteChatMessageForMe(messageId: number): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(messageId)) return { ok: false, error: "Invalid message." };

  const m = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { fromId: true, toId: true, groupId: true },
  });
  if (!m) return { ok: false, error: "Message not found." };

  if (m.groupId) {
    if (m.fromId !== me.id && !(await isGroupMember(me.id, m.groupId))) {
      return { ok: false, error: "Message not found." };
    }
    await prisma.chatMessageHide.upsert({
      where: { messageId_userId: { messageId, userId: me.id } },
      create: { messageId, userId: me.id },
      update: {},
    });
    return { ok: true };
  }

  if (m.fromId !== me.id && m.toId !== me.id) return { ok: false, error: "Message not found." };
  await prisma.chatMessage.update({
    where: { id: messageId },
    data: m.fromId === me.id ? { hiddenForFrom: true } : { hiddenForTo: true },
  });
  return { ok: true };
}

/** Pin / unpin a message to the top of its conversation (either side can). */
export async function togglePinChatMessage(messageId: number): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(messageId)) return { ok: false, error: "Invalid message." };

  const m = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { fromId: true, toId: true, groupId: true, pinnedAt: true },
  });
  if (!m) return { ok: false, error: "Message not found." };
  const allowed = m.groupId
    ? await isGroupMember(me.id, m.groupId)
    : m.fromId === me.id || m.toId === me.id;
  if (!allowed) return { ok: false, error: "Message not found." };

  await prisma.chatMessage.update({
    where: { id: messageId },
    data: m.pinnedAt ? { pinnedAt: null, pinnedBy: null } : { pinnedAt: new Date(), pinnedBy: me.id },
  });
  const kind: ThreadKind = m.groupId ? "group" : "user";
  const threadId = m.groupId ?? (m.fromId === me.id ? m.toId! : m.fromId);
  await broadcastSync(me.id, kind, threadId);
  return { ok: true };
}

/** React to a message with an emoji — one reaction per user; the same emoji
 *  again removes it, a different one replaces it. */
export async function toggleChatReaction(messageId: number, emoji: string): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const clean = emoji.trim();
  if (!Number.isInteger(messageId) || !clean || clean.length > 8) return { ok: false, error: "Invalid reaction." };

  const m = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { fromId: true, toId: true, groupId: true },
  });
  if (!m) return { ok: false, error: "Message not found." };
  const allowed = m.groupId
    ? await isGroupMember(me.id, m.groupId)
    : m.fromId === me.id || m.toId === me.id;
  if (!allowed) return { ok: false, error: "Message not found." };

  const existing = await prisma.chatReaction.findUnique({
    where: { messageId_userId: { messageId, userId: me.id } },
  });
  if (existing?.emoji === clean) {
    await prisma.chatReaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.chatReaction.upsert({
      where: { messageId_userId: { messageId, userId: me.id } },
      create: { messageId, userId: me.id, emoji: clean },
      update: { emoji: clean },
    });
  }
  const kind: ThreadKind = m.groupId ? "group" : "user";
  const threadId = m.groupId ?? (m.fromId === me.id ? m.toId! : m.fromId);
  await broadcastSync(me.id, kind, threadId);
  return { ok: true };
}

/** Create a group with a name and members (the caller is always in). */
export async function createChatGroup(
  name: string,
  memberIds: number[],
): Promise<{ ok: boolean; error?: string; groupId?: number }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the group a name." };
  if (clean.length > MAX_GROUP_NAME) return { ok: false, error: `Group name is too long (max ${MAX_GROUP_NAME}).` };

  const ids = [...new Set(memberIds.filter((n) => Number.isInteger(n) && n !== me.id))];
  if (ids.length === 0) return { ok: false, error: "Pick at least one member." };
  const valid = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
  if (valid.length !== ids.length) return { ok: false, error: "Some picked users no longer exist." };

  const group = await prisma.chatGroup.create({
    data: {
      name: clean,
      createdBy: me.id,
      members: { create: [me.id, ...ids].map((userId) => ({ userId })) },
    },
    select: { id: true },
  });
  // everyone's contact list should show the new group right away
  await Promise.all([me.id, ...ids].map((uid) => broadcast(chatTopic(uid), "sync", { kind: "group", id: group.id })));
  return { ok: true, groupId: group.id };
}

/** Add members — only the group's creator manages membership. */
export async function addChatGroupMembers(
  groupId: number,
  memberIds: number[],
): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  const group = await prisma.chatGroup.findUnique({ where: { id: groupId }, select: { createdBy: true } });
  if (!group) return { ok: false, error: "Group not found." };
  if (group.createdBy !== me.id) return { ok: false, error: "Only the group's creator can add members." };

  const ids = [...new Set(memberIds.filter((n) => Number.isInteger(n)))];
  const valid = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
  await prisma.chatGroupMember.createMany({
    data: valid.map((u) => ({ groupId, userId: u.id })),
    skipDuplicates: true,
  });
  await Promise.all(valid.map((u) => broadcast(chatTopic(u.id), "sync", { kind: "group", id: groupId })));
  return { ok: true };
}

/** Leave a group. The last member out deletes the group (and its messages). */
export async function leaveChatGroup(groupId: number): Promise<{ ok: boolean; error?: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  await prisma.chatGroupMember.deleteMany({ where: { groupId, userId: me.id } });
  const remaining = await prisma.chatGroupMember.count({ where: { groupId } });
  if (remaining === 0) await prisma.chatGroup.delete({ where: { id: groupId } }).catch(() => {});
  return { ok: true };
}

/** The group's members — the thread header line, and each member's read
 *  cursor so the sender's ticks can say who has seen how far. */
export async function getChatGroupMembers(
  groupId: number,
): Promise<{ ok: boolean; members: { id: number; name: string; lastReadId: number }[]; createdBy: number | null }> {
  const me = await getCurrentUser();
  if (!me || !(await isGroupMember(me.id, groupId))) return { ok: false, members: [], createdBy: null };
  const [group, members] = await Promise.all([
    prisma.chatGroup.findUnique({ where: { id: groupId }, select: { createdBy: true } }),
    prisma.chatGroupMember.findMany({
      where: { groupId },
      select: { lastReadId: true, user: { select: { id: true, name: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);
  return {
    ok: true,
    members: members.map((m) => ({ ...m.user, lastReadId: m.lastReadId })),
    createdBy: group?.createdBy ?? null,
  };
}

/** Order picker search for the composer: match MO or BOM, a few best hits. */
export async function searchChatOrders(
  q: string,
): Promise<{ ok: boolean; orders: { mo: string; bom: string; status: string }[] }> {
  const me = await getCurrentUser();
  const needle = q.trim();
  if (!me || needle.length < 2) return { ok: !!me, orders: [] };

  const orders = await prisma.masterOrder.findMany({
    where: {
      OR: [
        { mo: { contains: needle, mode: "insensitive" } },
        { bom: { contains: needle, mode: "insensitive" } },
      ],
    },
    select: { mo: true, bom: true, status: true },
    orderBy: { mo: "asc" },
    take: 20,
  });
  // open orders first — they are what people talk about
  orders.sort((a, b) => Number(a.status === "closed") - Number(b.status === "closed") || a.mo.localeCompare(b.mo));
  return { ok: true, orders: orders.slice(0, 10) };
}

/** Stamp a thread read for the caller (DM readAt / group read cursor). When
 *  something ACTUALLY became read, the other side gets a sync so the sender's
 *  ticks turn "seen" live. No change → no broadcast → no sync loops. */
async function stampRead(meId: number, kind: ThreadKind, otherId: number): Promise<void> {
  if (kind === "user") {
    const res = await prisma.chatMessage.updateMany({
      where: { fromId: otherId, toId: meId, readAt: null },
      data: { readAt: new Date() },
    });
    if (res.count > 0) {
      // from the SENDER's point of view this thread is "user <meId>"
      await broadcast(chatTopic(otherId), "sync", { kind: "user", id: meId });
    }
  } else {
    const [membership, latest] = await Promise.all([
      prisma.chatGroupMember.findUnique({
        where: { groupId_userId: { groupId: otherId, userId: meId } },
        select: { lastReadId: true },
      }),
      prisma.chatMessage.findFirst({
        where: { groupId: otherId },
        orderBy: { id: "desc" },
        select: { id: true },
      }),
    ]);
    if (latest && latest.id > (membership?.lastReadId ?? 0)) {
      await prisma.chatGroupMember.updateMany({
        where: { groupId: otherId, userId: meId },
        data: { lastReadId: latest.id },
      });
      await broadcastSync(meId, "group", otherId);
    }
  }
}

/** Open (or re-sync) a conversation: returns the thread and marks it read. */
export async function openChatThread(
  kind: ThreadKind,
  otherId: number,
): Promise<{ ok: boolean; error?: string; messages?: ChatMessageDTO[] }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(otherId)) return { ok: false, error: "Invalid conversation." };
  if (kind === "group" && !(await isGroupMember(me.id, otherId))) {
    return { ok: false, error: "You are not in this group." };
  }

  const [messages] = await Promise.all([
    getChatThread(me.id, kind, otherId),
    stampRead(me.id, kind, otherId),
  ]);
  return { ok: true, messages };
}

/** Mark the open thread read (called when messages arrive while it's open). */
export async function markChatThreadRead(kind: ThreadKind, otherId: number): Promise<{ ok: boolean }> {
  const me = await getCurrentUser();
  if (!me || !Number.isInteger(otherId)) return { ok: false };
  if (kind === "group" && !(await isGroupMember(me.id, otherId))) return { ok: false };
  await stampRead(me.id, kind, otherId);
  return { ok: true };
}

/** The polling fallback (and reconnect catch-up): everything new in the open
 *  thread after `afterId`, a LIGHT state snapshot of what's already on screen
 *  (pins / reads / reactions — no bodies, no attachments), the group's read
 *  cursors, and a fresh contact list for the unread badges. */
export async function pollChat(
  openKind: ThreadKind | null,
  openId: number,
  afterId: number,
): Promise<{
  ok: boolean;
  error?: string;
  messages?: ChatMessageDTO[];
  state?: ChatMessageState[];
  members?: { id: number; name: string; lastReadId: number }[];
  contacts?: ChatContact[];
}> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };

  const canRead =
    openKind === "user" ? Number.isInteger(openId) :
    openKind === "group" ? Number.isInteger(openId) && (await isGroupMember(me.id, openId)) :
    false;

  const [messages, state, memberRows, contacts] = await Promise.all([
    canRead && openKind ? getChatThread(me.id, openKind, openId, afterId) : Promise.resolve([]),
    canRead && openKind ? getChatThreadState(me.id, openKind, openId) : Promise.resolve([]),
    canRead && openKind === "group"
      ? prisma.chatGroupMember.findMany({
          where: { groupId: openId },
          select: { lastReadId: true, user: { select: { id: true, name: true } } },
          orderBy: { joinedAt: "asc" },
        })
      : Promise.resolve([]),
    getChatContacts(me.id),
  ]);
  return {
    ok: true,
    messages,
    state,
    members: memberRows.map((m) => ({ ...m.user, lastReadId: m.lastReadId })),
    contacts,
  };
}

/** The corner popup's poll: unread messages newer than `afterId` (the popup
 *  shows them), the badge total, and the cursor for the next call. */
export async function pollChatInbox(afterId: number): Promise<{
  ok: boolean;
  items?: ChatInboxItem[];
  unread?: number;
  latestId?: number;
  /** The assistant's inbox (the bell) rides on the same poll — one request,
   *  not two, from every open page. */
  inboxUnread?: number;
}> {
  const me = await getCurrentUser();
  if (!me || !Number.isInteger(afterId)) return { ok: false };
  const [chat, inboxUnread] = await Promise.all([getChatInbox(me.id, afterId), unreadInboxCount(me.id).catch(() => undefined)]);
  return { ok: true, ...chat, ...(inboxUnread === undefined ? {} : { inboxUnread }) };
}
