"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { getChatContacts, getChatThread, type ChatContact, type ChatMessageDTO } from "@/lib/server/chat";
import { broadcast } from "@/lib/server/realtimeBroadcast";
import { chatTopic } from "@/lib/domain/chatTopic";

// Chat needs no permission key — every active account can message every other.
// What it DOES need is scoping: every query here pins the caller's id from the
// session, so nobody can read or mark a thread they aren't an end of.

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const MAX_BODY = 2000;

export async function sendChatMessage(
  toId: number,
  body: string,
): Promise<{ ok: boolean; error?: string; message?: ChatMessageDTO }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };

  const text = body.trim();
  if (!text) return { ok: false, error: "Message is empty." };
  if (text.length > MAX_BODY) return { ok: false, error: `Message is too long (max ${MAX_BODY} characters).` };
  if (!Number.isInteger(toId) || toId === me.id) return { ok: false, error: "Invalid recipient." };

  const recipient = await prisma.user.findUnique({ where: { id: toId }, select: { active: true } });
  if (!recipient?.active) return { ok: false, error: "Recipient not found." };

  const row = await prisma.chatMessage.create({
    data: { fromId: me.id, toId, body: text },
    select: { id: true, fromId: true, toId: true, body: true, createdAt: true },
  });
  const message: ChatMessageDTO = { ...row, createdAt: row.createdAt.toISOString() };

  // live delivery (best-effort): the recipient's tab, and the sender's OTHER
  // tabs so a conversation never forks between two open windows
  await Promise.all([
    broadcast(chatTopic(toId), "message", { message, fromName: me.name }),
    broadcast(chatTopic(me.id), "message", { message, fromName: me.name }),
  ]);

  return { ok: true, message };
}

/** Open (or refresh) a conversation: returns the thread and stamps everything
 *  the other user sent as read. */
export async function openChatThread(
  otherId: number,
): Promise<{ ok: boolean; error?: string; messages?: ChatMessageDTO[] }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(otherId)) return { ok: false, error: "Invalid user." };

  const [messages] = await Promise.all([
    getChatThread(me.id, otherId),
    prisma.chatMessage.updateMany({
      where: { fromId: otherId, toId: me.id, readAt: null },
      data: { readAt: new Date() },
    }),
  ]);
  return { ok: true, messages };
}

/** Mark the open thread read (called when messages arrive while it's open). */
export async function markChatThreadRead(otherId: number): Promise<{ ok: boolean }> {
  const me = await getCurrentUser();
  if (!me || !Number.isInteger(otherId)) return { ok: false };
  await prisma.chatMessage.updateMany({
    where: { fromId: otherId, toId: me.id, readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

/** The polling fallback (and reconnect catch-up): everything new in the open
 *  thread after `afterId`, plus a fresh contact list for the unread badges. */
export async function pollChat(
  openThreadWith: number | null,
  afterId: number,
): Promise<{ ok: boolean; error?: string; messages?: ChatMessageDTO[]; contacts?: ChatContact[] }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: NOT_LOGGED_IN };

  const [messages, contacts] = await Promise.all([
    openThreadWith && Number.isInteger(openThreadWith)
      ? getChatThread(me.id, openThreadWith, afterId)
      : Promise.resolve([]),
    getChatContacts(me.id),
  ]);
  return { ok: true, messages, contacts };
}
