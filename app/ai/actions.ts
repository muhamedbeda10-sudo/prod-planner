"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { seenMeasurer } from "@/lib/server/ai/vision";
import { discardFile, storeAiFile, type StoreResult } from "@/lib/server/ai/files";
import { approveAction, rejectAction, undoAction, type DecideResult } from "@/lib/server/ai/changes";
import { chatTurnsOf, openedChatOf } from "@/lib/server/ai/chatTurns";
import { AI_DENY_TEXT, DEFAULT_AI_MODEL, type AiChatTurn } from "@/lib/domain/ai";
import type { AiActionView } from "@/lib/domain/aiActions";
import { answerOf, checkFeedback, type AiFeedbackRating } from "@/lib/domain/aiLearn";
import { forgetFor, memoriesOf, rememberFor, type AiMemoryView } from "@/lib/server/ai/memory";
import { hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { deliverToInbox } from "@/lib/server/inbox";
import { sendMessageFromPerson } from "@/lib/server/inboxMessage";
import { sendChatMessage } from "@/app/chat/actions";
import { AI_CONVERSATION_TITLE_MAX, chatIdsOf, chatTextOf, withoutFollowups, withoutSourceLinks } from "@/lib/domain/aiAnswer";
import { INBOX_BODY_MAX, INBOX_TITLE_MAX } from "@/lib/domain/inbox";
import { CHAT_MESSAGE_MAX } from "@/lib/domain/chatTopic";
import { AUTOMATIONS_KEY } from "@/lib/server/automations/store";

// A person's own AI conversations — read and deleted by them alone — and
// their answers to what the assistant prepared for them. Asking goes through
// the streaming route (app/api/ai/chat).

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";

export async function loadAiConversation(id: number): Promise<{ ok: boolean; turns?: AiChatTurn[]; actions?: AiActionView[]; ratings?: Record<number, AiFeedbackRating>; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const c = await prisma.aiConversation.findFirst({ where: { id, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } });
  if (!c) return { ok: false, error: "That conversation is not there any more." };
  return { ok: true, ...(await openedChatOf(c)) };
}

/** A thumbs up or down on one of the person's own answers (its place among
 *  the chat's answers), with what was wrong — the owner reads it on AI
 *  settings → Quality. Rated again, the rating is replaced. */
export async function rateAiAnswer(conversationId: number, turn: number, rating: string, note: string, head?: string): Promise<{ ok: boolean; error?: string }> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  const user = a.user;
  const checked = checkFeedback(rating, note, turn);
  if ("error" in checked) return { ok: false, error: checked.error };
  if (!Number.isInteger(conversationId) || conversationId <= 0) return { ok: false, error: "Which chat?" };
  const c = await prisma.aiConversation.findFirst({ where: { id: conversationId, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } });
  if (!c) return { ok: false, error: "That conversation is not there any more." };
  // the model that wrote it, as the chat shows it under the answer (each question on Auto takes its own)
  const qa = answerOf(await chatTurnsOf(c), checked.turn, typeof head === "string" ? head.slice(0, 200) : undefined);
  if (!qa) return { ok: false, error: "That answer is not in this chat." };
  const data = { rating: checked.rating, note: checked.note, question: qa.question, answer: withoutFollowups(qa.answer), model: qa.model ?? c.model, status: "new" };
  await prisma.aiFeedback.upsert({
    where: { conversationId_turn: { conversationId: c.id, turn: qa.turn } },
    create: { ...data, userId: user.id, conversationId: c.id, turn: qa.turn },
    update: data,
  });
  return { ok: true };
}

/** What the assistant keeps about the person — theirs to read and change. */
export async function loadAiMemories(): Promise<{ ok: boolean; memories?: AiMemoryView[]; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  return { ok: true, memories: await memoriesOf(user.id) };
}

export async function saveAiMemory(text: string, id?: number): Promise<{ ok: boolean; error?: string }> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  const user = a.user;
  if (id !== undefined && (!Number.isInteger(id) || id <= 0)) return { ok: false, error: "Which memory?" };
  const r = await rememberFor(user.id, text, id);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function forgetAiMemory(id: number): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Which memory?" };
  return (await forgetFor(user.id, id)) ? { ok: true } : { ok: false, error: "That memory is not there any more." };
}

/** A chat's name, as the person wants it in the list. */
export async function renameAiConversation(id: number, title: string): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Which chat?" };
  const clean = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!clean) return { ok: false, error: "Give the chat a name." };
  if (clean.length > AI_CONVERSATION_TITLE_MAX) return { ok: false, error: `Keep the name under ${AI_CONVERSATION_TITLE_MAX} characters.` };
  const r = await prisma.aiConversation.updateMany({ where: { id, userId: user.id }, data: { title: clean } });
  return r.count > 0 ? { ok: true } : { ok: false, error: "That conversation is not there any more." };
}

/** Of these chats, the ones that are the person's own. */
async function ownChatIds(userId: number, ids: unknown): Promise<number[]> {
  const wanted = chatIdsOf(ids);
  if (wanted.length === 0) return [];
  return (await prisma.aiConversation.findMany({ where: { id: { in: wanted }, userId }, select: { id: true } })).map((c) => c.id);
}

/** Pin or unpin chats — only the person's own — at the top of the list, or back in order. */
export async function pinAiConversations(ids: number[], pinned: boolean): Promise<{ ok: boolean; changed?: number[]; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (chatIdsOf(ids).length === 0) return { ok: false, error: "Pick the chats first." };
  const own = await ownChatIds(user.id, ids);
  // raw: an update through the client would stamp updatedAt, and pinning is not using the chat
  if (own.length > 0) await prisma.$executeRaw`UPDATE "AiConversation" SET "pinned" = ${!!pinned} WHERE "id" = ANY(${own}::int[]) AND "userId" = ${user.id}`;
  return { ok: true, changed: own };
}

/** Who an answer can be sent to: colleagues' inboxes — for someone who may
 *  send messages (the automations key, as the inbox's own message action
 *  and the assistant's send_message) — and, where the team chat is open to
 *  the person, colleagues and their groups there. Keeping an answer in
 *  one's own inbox needs no key. */
export async function loadAiShareTargets(): Promise<{ ok: boolean; people?: { id: number; name: string }[]; groups?: { id: number; name: string }[]; inbox?: boolean; chat?: boolean; error?: string }> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  const me = a.user;
  const inbox = hasPerm(me, AUTOMATIONS_KEY);
  const chat = !hiddenTabsOf(me).has("chat");
  const [people, groups] = await Promise.all([
    inbox || chat ? prisma.user.findMany({ where: { active: true, id: { not: me.id } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
    chat ? prisma.chatGroup.findMany({ where: { members: { some: { userId: me.id } } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
  ]);
  return { ok: true, people, groups, inbox, chat };
}

/** The answer as it is sent on: without the chat's follow-up chips and
 *  its source links (they open cards only the chat has), the question it
 *  answered quoted first. */
function sharedBody(question: unknown, body: string): string {
  const q = typeof question === "string" && question.trim() ? `> ${question.replace(/\s+/g, " ").trim().slice(0, 300)}\n\n` : "";
  return `${q}${withoutSourceLinks(withoutFollowups(body)).trim()}`;
}

/** An answer sent on — to colleagues' inboxes as a message from the person
 *  (Markdown and charts as they are; needs the automations key, like any
 *  message to an inbox, under the same hour's cap), and/or kept in the
 *  person's own inbox as a report of theirs. The words are the answer as the
 *  person reads it. */
export async function shareAiAnswer(o: { title: string; body: string; userIds: number[]; question?: string; keep?: boolean }): Promise<{ ok: boolean; sent?: number; error?: string }> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  const me = a.user;
  const title = (typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim().slice(0, INBOX_TITLE_MAX) : "") || "From the AI assistant";
  const body = sharedBody(o.question, typeof o.body === "string" ? o.body : "");
  if (!body) return { ok: false, error: "There is nothing to send." };
  if (body.length > INBOX_BODY_MAX) return { ok: false, error: "The answer is too long to send — print it instead." };
  // the recipients' own rules (active, at most so many, the hour's cap) are the message core's
  const to = Array.isArray(o.userIds) ? o.userIds.filter((x): x is number => Number.isInteger(x) && x > 0 && x !== me.id) : [];
  if (to.length === 0 && !o.keep) return { ok: false, error: "Pick who gets it." };
  let sent = 0;
  if (to.length > 0) {
    if (!hasPerm(me, AUTOMATIONS_KEY)) return { ok: false, error: "Sending to colleagues' inboxes is not opened for your account — ask the owner for the automations key, or keep it in your own inbox." };
    const r = await sendMessageFromPerson(me, { to, title, body, fromName: `${me.name} — from their AI chat` });
    if (!r.ok) return r;
    sent += r.ids.length;
  }
  if (o.keep) sent += (await deliverToInbox([{ userId: me.id, kind: "report", title, body, fromName: "Kept from your AI chat", fromUserId: me.id }])).length;
  return sent > 0 ? { ok: true, sent } : { ok: false, error: "Nobody could receive it — are they still active?" };
}

/** An answer posted in the team chat as the person — to a colleague or one
 *  of their groups, through the chat's own action and rules. The chat takes
 *  plain text, so the charts are left out and a long answer is cut. */
export async function shareAiAnswerToChat(o: { kind: "user" | "group"; to: number; body: string }): Promise<{ ok: boolean; cut?: boolean; error?: string }> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  if (hiddenTabsOf(a.user).has("chat")) return { ok: false, error: "The team chat is not opened for your account." };
  const text = typeof o.body === "string" ? chatTextOf(o.body) : "";
  if (!text) return { ok: false, error: "There is nothing to send." };
  const cut = text.length > CHAT_MESSAGE_MAX;
  const fd = new FormData();
  fd.set("kind", o.kind === "group" ? "group" : "user");
  fd.set("to", String(o.to));
  fd.set("body", cut ? `${text.slice(0, CHAT_MESSAGE_MAX - 2).trimEnd()}…` : text);
  const r = await sendChatMessage(fd);
  return r.ok ? { ok: true, ...(cut ? { cut } : {}) } : { ok: false, error: r.error ?? "Could not send it." };
}

/** Delete several chats at once — only the person's own, with the ratings
 *  that quoted them, together. What they cost stays in the usage log. */
export async function deleteAiConversations(ids: number[]): Promise<{ ok: boolean; deleted?: number[]; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (chatIdsOf(ids).length === 0) return { ok: false, error: "Pick the chats to delete." };
  const own = await ownChatIds(user.id, ids);
  if (own.length > 0) {
    await prisma.$transaction([
      prisma.aiFeedback.deleteMany({ where: { conversationId: { in: own } } }),
      prisma.aiConversation.deleteMany({ where: { id: { in: own }, userId: user.id } }),
    ]);
  }
  return { ok: true, deleted: own };
}

/** Whoever the assistant was closed to since it prepared a change cannot
 *  have it run either. */
async function asker(): Promise<{ user?: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: NOT_LOGGED_IN };
  const status = await aiStatusFor(user);
  if (!status.visible) return { error: "The assistant is not opened for your account any more — ask the owner." };
  return { user };
}

/** Run a change the assistant prepared — if the data still reads as it did. */
export async function approveAiAction(id: number): Promise<DecideResult> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Invalid change." };
  return approveAction(id, a.user);
}

export async function rejectAiAction(id: number): Promise<DecideResult> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Invalid change." };
  return rejectAction(id, a.user);
}

/** Put a change back — only while nothing was changed after it. */
export async function undoAiAction(id: number): Promise<DecideResult> {
  const a = await asker();
  if (!a.user) return { ok: false, error: a.error };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Invalid change." };
  return undoAction(id, a.user);
}

/** A file attached in the chat — checked and kept for the question it goes
 *  with (a photo or a PDF measured by the model first). Only for someone the
 *  assistant answers now. */
export async function uploadAiFile(fd: FormData): Promise<StoreResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const status = await aiStatusFor(user);
  if (!status.ok) return { ok: false, error: status.reason ? AI_DENY_TEXT[status.reason] : "The assistant is not available to you right now." };
  const file = fd.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file." };
  try {
    const settings = await getAiSettings();
    const apiKey = apiKeyOf(settings);
    return await storeAiFile(user, file, new Date(), apiKey ? seenMeasurer(apiKey, DEFAULT_AI_MODEL) : undefined);
  } catch (e) {
    console.error("AI: could not keep an attached file", e);
    return { ok: false, error: "The file could not be kept — try again." };
  }
}

/** Take back a file attached but not sent yet. */
export async function discardAiFile(id: number): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Invalid file." };
  await discardFile(user.id, id);
  return { ok: true };
}
