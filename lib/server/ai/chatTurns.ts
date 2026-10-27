import "server-only";
import { prisma } from "@/lib/db";
import { READ_TOOL_TITLES } from "./tools";
import { actionsOfConversation } from "./changes";
import { displayTurns, withModelsByTime, type AiChatTurn } from "@/lib/domain/ai";
import type { AiActionView } from "@/lib/domain/aiActions";
import type { AiFeedbackRating } from "@/lib/domain/aiLearn";

type KeptChat = { id: number; messages: readonly { role: string; content: unknown; createdAt: Date }[] };

/** A kept chat as people read it, each answer with the model that wrote it —
 *  on Auto every question takes its own. */
export async function chatTurnsOf(c: KeptChat): Promise<AiChatTurn[]> {
  const asked = await prisma.aiUsage.findMany({ where: { conversationId: c.id }, orderBy: { id: "asc" }, select: { at: true, model: true } });
  return displayTurns(withModelsByTime(c.messages, asked), READ_TOOL_TITLES);
}

/** A chat opened again — on the assistant's page or in the side panel: its
 *  turns, the changes it prepared and the person's ratings of its answers. */
export async function openedChatOf(c: KeptChat): Promise<{ turns: AiChatTurn[]; actions: AiActionView[]; ratings: Record<number, AiFeedbackRating> }> {
  const [turns, actions, feedback] = await Promise.all([
    chatTurnsOf(c),
    actionsOfConversation(c.id),
    prisma.aiFeedback.findMany({ where: { conversationId: c.id }, select: { turn: true, rating: true } }),
  ]);
  return { turns, actions, ratings: Object.fromEntries(feedback.map((f) => [f.turn, f.rating as AiFeedbackRating])) };
}
