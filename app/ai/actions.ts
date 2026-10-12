"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { aiStatusFor } from "@/lib/server/ai/access";
import { actionsOfConversation, approveAction, rejectAction, undoAction, type DecideResult } from "@/lib/server/ai/changes";
import { READ_TOOL_TITLES } from "@/lib/server/ai/tools";
import { displayTurns, type AiChatTurn } from "@/lib/domain/ai";
import type { AiActionView } from "@/lib/domain/aiActions";

// A person's own AI conversations — read and deleted by them alone — and
// their answers to what the assistant prepared for them. Asking goes through
// the streaming route (app/api/ai/chat).

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";

export async function loadAiConversation(id: number): Promise<{ ok: boolean; turns?: AiChatTurn[]; actions?: AiActionView[]; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const c = await prisma.aiConversation.findFirst({ where: { id, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } });
  if (!c) return { ok: false, error: "That conversation is not there any more." };
  return { ok: true, turns: displayTurns(c.messages, READ_TOOL_TITLES), actions: await actionsOfConversation(c.id) };
}

export async function deleteAiConversation(id: number): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  // what it cost stays in the usage log, and what it changed in the
  // assistant's log; only the chat goes
  await prisma.aiConversation.deleteMany({ where: { id, userId: user.id } });
  return { ok: true };
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
