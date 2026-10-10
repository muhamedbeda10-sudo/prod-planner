"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { displayTurns, type AiChatTurn } from "@/lib/domain/ai";

// A person's own AI conversations — read and deleted by them alone. Asking
// goes through the streaming route (app/api/ai/chat).

export async function loadAiConversation(id: number): Promise<{ ok: boolean; turns?: AiChatTurn[]; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "You are not logged in — refresh the page." };
  const c = await prisma.aiConversation.findFirst({ where: { id, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } });
  if (!c) return { ok: false, error: "That conversation is not there any more." };
  return { ok: true, turns: displayTurns(c.messages) };
}

export async function deleteAiConversation(id: number): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "You are not logged in — refresh the page." };
  // what it cost stays in the usage log; only the chat goes
  await prisma.aiConversation.deleteMany({ where: { id, userId: user.id } });
  return { ok: true };
}
