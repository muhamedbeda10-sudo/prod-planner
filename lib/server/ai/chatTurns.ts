import "server-only";
import { prisma } from "@/lib/db";
import { READ_TOOL_TITLES } from "./tools";
import { displayTurns, withModelsByTime, type AiChatTurn } from "@/lib/domain/ai";

/** A kept chat as people read it, each answer with the model that wrote it —
 *  on Auto every question takes its own. */
export async function chatTurnsOf(c: { id: number; messages: readonly { role: string; content: unknown; createdAt: Date }[] }): Promise<AiChatTurn[]> {
  const asked = await prisma.aiUsage.findMany({ where: { conversationId: c.id }, orderBy: { id: "asc" }, select: { at: true, model: true } });
  return displayTurns(withModelsByTime(c.messages, asked), READ_TOOL_TITLES);
}
