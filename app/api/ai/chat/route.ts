import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { ask, questionMessages, type AiMessageParam } from "@/lib/server/ai/agent";
import { markOutcomesTold, pendingOutcomes } from "@/lib/server/ai/changes";
import { toolsFor } from "@/lib/server/ai/tools";
import { getPlaybookText } from "@/lib/server/ai/playbook";
import { linkFiles, questionFiles } from "@/lib/server/ai/files";
import { AI_FILE_LIMITS, attachmentNote } from "@/lib/domain/aiFiles";
import { AI_DENY_TEXT, AI_MAX_MESSAGES, AI_MAX_QUESTION, conversationTitle, costUsd, questionContext } from "@/lib/domain/ai";
import { AI_DELETE_KEY, AI_NOCONFIRM_KEY, type AiArea } from "@/lib/domain/aiActions";
import { factoryDayISO } from "@/lib/domain/dates";

// One question to the AI assistant, answered as a stream of JSON lines:
//   {type:"start", conversationId, title}
//   {type:"status", text}   — what it is looking up or preparing now
//   {type:"text", delta}    — a piece of the answer
//   {type:"action", action} — a change it prepared (or made), as its card
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

  let body: { conversationId?: unknown; question?: unknown; fileIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, "Bad request.");
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return fail(400, "Type a question.");
  if (question.length > AI_MAX_QUESTION) return fail(400, `The question is too long (at most ${AI_MAX_QUESTION} characters).`);
  const fileIds: unknown[] = Array.isArray(body.fileIds) ? body.fileIds : [];
  if (!fileIds.every((x): x is number => Number.isInteger(x) && (x as number) > 0)) return fail(400, "Bad request.");
  if (fileIds.length > AI_FILE_LIMITS.perQuestion) return fail(400, `Attach at most ${AI_FILE_LIMITS.perQuestion} files to one question.`);

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
  // caps before its cost is counted. An automation of theirs running now
  // (no conversation) does not hold the chat up.
  const running = await prisma.aiUsage.count({ where: { userId: user.id, finishedAt: null, conversationId: { not: null }, at: { gte: new Date(Date.now() - (maxDuration + 30) * 1000) } } });
  if (running > 0) return fail(429, "One question at a time — wait for the answer, then ask again.");
  // the files sent with it: the person's own, and this chat's (or none's yet)
  const files = await questionFiles(user.id, fileIds, existing?.id ?? null);
  if (!files.ok) return fail(400, files.error);

  const conversation = existing ?? (await prisma.aiConversation.create({ data: { userId: user.id, title: conversationTitle(question), model: settings.model } }));
  await linkFiles(user.id, fileIds, conversation.id);
  // logged before the first call, finished after the last — what the caps
  // and the one-at-a-time rule read
  const usage = await prisma.aiUsage.create({ data: { userId: user.id, conversationId: conversation.id, model: conversation.model, question: question.slice(0, 500) } });
  const history: AiMessageParam[] = (existing?.messages ?? []).map((m) => ({ role: m.role as AiMessageParam["role"], content: m.content as unknown as AiMessageParam["content"] }));

  // what this person's assistant may do, and what became of what it prepared
  const now = new Date();
  const hidden = hiddenTabsOf(user);
  const tools = toolsFor(user, { hidden, actionsPaused: settings.actionsPaused });
  const areas = [...new Set(tools.flatMap((t) => (t.kind === "write" ? [t.area] : [])))] as AiArea[];
  const [outcomes, playbook] = await Promise.all([existing ? pendingOutcomes(conversation.id) : { ids: [], notes: [] }, getPlaybookText()]);
  const context = questionContext({
    askedBy: user.name,
    now,
    areas,
    canDelete: hasPerm(user, AI_DELETE_KEY),
    noconfirm: hasPerm(user, AI_NOCONFIRM_KEY),
    paused: settings.actionsPaused,
    notes: outcomes.notes,
  });

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
        question: questionMessages(question, context, files.files.length ? attachmentNote(files.files) : undefined),
        tools,
        ctx: { user, hidden, now, todayISO: factoryDayISO(now), conversationId: conversation.id, automationId: null },
        settings,
        playbook,
        events: {
          status: (text) => send({ type: "status", text }),
          text: (delta) => send({ type: "text", delta }),
          action: (action) => send({ type: "action", action }),
        },
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
        // the assistant read the outcomes only if its answer was kept
        if (!result.error) await markOutcomesTold(outcomes.ids);
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
