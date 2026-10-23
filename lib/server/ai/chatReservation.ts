import "server-only";
import type { AiConversation } from "@prisma/client";
import { prisma } from "@/lib/db";
import { conversationTitle } from "@/lib/domain/ai";

/** The lock covers the check AND reservation across tabs and app instances. */
export async function reserveChatTurn(o: {
  userId: number; question: string; model: string; existing: Pick<AiConversation, "id" | "title" | "model"> | null;
  now: Date; runningWindowMs: number;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(1095320392::int, ${o.userId}::int)`;
    const running = await tx.aiUsage.count({ where: {
      userId: o.userId, finishedAt: null, conversationId: { not: null },
      at: { gte: new Date(o.now.getTime() - o.runningWindowMs) },
    } });
    if (running > 0) return null;
    const conversation = o.existing ?? await tx.aiConversation.create({ data: {
      userId: o.userId, title: conversationTitle(o.question), model: o.model,
    } });
    const usage = await tx.aiUsage.create({ data: {
      userId: o.userId, conversationId: conversation.id, model: conversation.model, question: o.question.slice(0, 500),
    } });
    return { conversation, usage };
  }, { maxWait: 10_000, timeout: 15_000 });
}
