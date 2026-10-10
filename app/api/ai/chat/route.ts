import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { ask, questionMessage, type AiMessageParam } from "@/lib/server/ai/agent";
import { AI_DENY_TEXT, AI_MAX_MESSAGES, AI_MAX_QUESTION, conversationTitle, costUsd } from "@/lib/domain/ai";

// One question to the AI assistant, answered as a stream of JSON lines:
//   {type:"start", conversationId, title}
//   {type:"status", text}   — what it is looking up now
//   {type:"text", delta}    — a piece of the answer
//   {type:"done", costUsd, error?}
// The access and the month's caps are checked before anything is spent; the
// question, the answer and what it cost are kept when it ends.

export const dynamic = "force-dynamic";
// a question with several look-ups can take a minute or two
export const maxDuration = 300;

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return fail(401, "You are not logged in — refresh the page.");

  let body: { conversationId?: unknown; question?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, "Bad request.");
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return fail(400, "Type a question.");
  if (question.length > AI_MAX_QUESTION) return fail(400, `The question is too long (at most ${AI_MAX_QUESTION} characters).`);

  const status = await aiStatusFor(user);
  if (!status.ok) return fail(403, AI_DENY_TEXT[status.reason!]);
  const settings = await getAiSettings();
  const apiKey = apiKeyOf(settings);
  if (!apiKey) return fail(503, "The stored Claude API key cannot be read any more — the owner should enter it again on AI assistant settings.");

  // the conversation: the person's own, or a new one on today's model
  const wanted = Number(body.conversationId);
  const existing = Number.isInteger(wanted) && wanted > 0
    ? await prisma.aiConversation.findFirst({ where: { id: wanted, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } })
    : null;
  if (Number.isInteger(wanted) && wanted > 0 && !existing) return fail(404, "That conversation is not there any more.");
  if (existing && existing.messages.length >= AI_MAX_MESSAGES) return fail(400, "This chat has grown long — start a new one (every question re-reads the whole chat).");
  // one question at a time: one still being answered (started inside the
  // route's own time limit) blocks the next, so a burst cannot run past the
  // caps before its cost is counted
  const running = await prisma.aiUsage.count({ where: { userId: user.id, finishedAt: null, at: { gte: new Date(Date.now() - (maxDuration + 30) * 1000) } } });
  if (running > 0) return fail(429, "One question at a time — wait for the answer, then ask again.");

  const conversation = existing ?? (await prisma.aiConversation.create({ data: { userId: user.id, title: conversationTitle(question), model: settings.model } }));
  // logged before the first call, finished after the last — what the caps
  // and the one-at-a-time rule read
  const usage = await prisma.aiUsage.create({ data: { userId: user.id, conversationId: conversation.id, model: conversation.model, question: question.slice(0, 500) } });
  const history: AiMessageParam[] = (existing?.messages ?? []).map((m) => ({ role: m.role as "user" | "assistant", content: m.content as unknown as AiMessageParam["content"] }));

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (o: object) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        } catch {
          open = false; // the page went away — the answer is still kept
        }
      };
      send({ type: "start", conversationId: conversation.id, title: conversation.title });

      const result = await ask({
        apiKey,
        model: conversation.model,
        history,
        question: questionMessage(question, user.name, new Date()),
        events: { status: (text) => send({ type: "status", text }), text: (delta) => send({ type: "text", delta }) },
      });
      const cost = costUsd(conversation.model, result.tokens);

      try {
        await prisma.$transaction([
          ...result.added.map((m) =>
            prisma.aiMessage.create({ data: { conversationId: conversation.id, role: m.role, content: m.content as unknown as Prisma.InputJsonValue } }),
          ),
          prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
          prisma.aiUsage.update({
            where: { id: usage.id },
            data: { calls: result.calls, queries: result.queries, ...result.tokens, costUsd: cost, error: result.error?.slice(0, 1000) ?? null, finishedAt: new Date() },
          }),
        ]);
      } catch (e) {
        console.error("AI: could not keep the conversation", e);
        await prisma.aiUsage.update({ where: { id: usage.id }, data: { costUsd: cost, error: "could not be saved", finishedAt: new Date() } }).catch(() => {});
      }

      send({ type: "done", costUsd: cost, ...(result.error ? { error: result.error } : {}) });
      if (open) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
