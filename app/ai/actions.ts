"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { seenMeasurer } from "@/lib/server/ai/vision";
import { discardFile, storeAiFile, type StoreResult } from "@/lib/server/ai/files";
import { actionsOfConversation, approveAction, rejectAction, undoAction, type DecideResult } from "@/lib/server/ai/changes";
import { READ_TOOL_TITLES } from "@/lib/server/ai/tools";
import { AI_DENY_TEXT, displayTurns, type AiChatTurn } from "@/lib/domain/ai";
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
    return await storeAiFile(user, file, new Date(), apiKey ? seenMeasurer(apiKey, settings.model) : undefined);
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
