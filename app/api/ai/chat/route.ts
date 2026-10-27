import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { ask, questionMessages, type AiMessageParam } from "@/lib/server/ai/agent";
import { markOutcomesTold, pendingOutcomes } from "@/lib/server/ai/changes";
import { toolsFor } from "@/lib/server/ai/tools";
import { getPlaybookText } from "@/lib/server/ai/playbook";
import { fileExpander, linkFiles, questionFiles, seenBlocks, withoutSeen } from "@/lib/server/ai/files";
import { AI_FILE_LIMITS, attachmentNote, fileRef } from "@/lib/domain/aiFiles";
import { AI_DENY_TEXT, AI_MAX_MESSAGES, AI_MAX_QUESTION, costUsd, questionContext } from "@/lib/domain/ai";
import { aiPageContext } from "@/lib/domain/aiScreen";
import { getActiveLine } from "@/lib/server/line";
import { pageLineOf } from "@/lib/domain/planningDashboard";
import { reserveChatTurn } from "@/lib/server/ai/chatReservation";
import { AI_DELETE_KEY, AI_NOCONFIRM_KEY, type AiArea } from "@/lib/domain/aiActions";
import { factoryDayISO } from "@/lib/domain/dates";
import type { WorkingScenario } from "@/lib/server/ai/tools/types";
import { memoryNote, routeModel } from "@/lib/domain/aiLearn";
import { DEFAULT_AI_DEPTH, depthPlan, isAiDepth } from "@/lib/domain/aiAnswer";
import { compactHistory } from "@/lib/domain/aiHistory";
import { memoriesOf } from "@/lib/server/ai/memory";

// One question to the AI assistant, answered as a stream of JSON lines:
//   {type:"start", conversationId, title, model}
//   {type:"status", text}   — what it is looking up or preparing now
//   {type:"step", id, kind, text, state, ms?, rows?}
//                           — a look-up or a change starting, done or failed
//   {type:"text", delta}    — a piece of the answer
//   {type:"action", action} — a change it prepared (or made), as its card
//   {type:"done", costUsd, totalMs?, error?}
// The chat is on Auto: each question takes the model it needs, and may say
// how deep to go (depth: quick | standard | deep — lib/domain/aiAnswer
// depthPlan), which sets its effort. A right-click's "Ask AI" (explain: true)
// only explains what is on the screen, and sends the page's own text unread
// by the person — so it gets the reading tools alone: nothing written on the
// page can have it prepare a change.
// The chat's working what-if (keep_scenario) is read off the conversation
// and handed to the tools. The access and the month's caps are checked before
// anything is spent; the question, the answer and what it cost are kept when
// it ends.

export const dynamic = "force-dynamic";
// a question with several look-ups can take minutes — a Deep one longer;
// Vercel's Fluid compute allows this much, and the agent keeps a minute in
// hand to save the answer (AI_ASK_TIMEOUT_MAX)
export const maxDuration = 800;

/** The largest request read, in bytes and in characters — a question, its
 *  files' numbers and the page's context fit well inside. */
const MAX_BODY = 1_000_000;

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return fail(401, "You are not logged in — refresh the page.");

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return fail(413, "The request is too large.");
  let body: { conversationId?: unknown; question?: unknown; fileIds?: unknown; page?: unknown; depth?: unknown; explain?: unknown };
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return fail(413, "The request is too large.");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "Bad request.");
    body = parsed as typeof body;
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
  // the files sent with it: the person's own, and this chat's (or none's yet)
  const files = await questionFiles(user.id, fileIds, existing?.id ?? null);
  if (!files.ok) return fail(400, files.error);

  // Auto: the model this question needs, then the depth the person asked for
  // (Quick / Standard / Deep) — its effort and calls. Each question on its own
  // model: a chat moved up for one hard question comes back down after it.
  const routed = routeModel(question, { files: files.files.length });
  const depth = isAiDepth(body.depth) ? body.depth : DEFAULT_AI_DEPTH;
  const { model, effort, maxCalls } = depthPlan(depth, { routed, maxCalls: settings.maxCalls });
  const reservation = await reserveChatTurn({ userId: user.id, question, model, existing, now: new Date(), runningWindowMs: (maxDuration + 30) * 1000 });
  if (!reservation) return fail(429, "One question at a time — wait for the answer, then ask again.");
  const { usage, conversation } = reservation;
  try {
    await linkFiles(user.id, fileIds, conversation.id);
    // logged before the first call, finished after the last — what the caps
    // and the one-at-a-time rule read
    // the old look-ups' big results folded (lib/domain/aiHistory) — the
    // chat as kept is not touched
    const history: AiMessageParam[] = compactHistory((existing?.messages ?? []).map((m) => ({ role: m.role as AiMessageParam["role"], content: m.content as unknown as AiMessageParam["content"] })));

    // what this person's assistant may do, and what became of what it prepared
    const now = new Date();
    const hidden = hiddenTabsOf(user);
    const page = aiPageContext(body.page, hidden);
    const line = await getActiveLine();
    const tools = toolsFor(user, { hidden, actionsPaused: settings.actionsPaused, readOnly: body.explain === true });
    const areas = [...new Set(tools.flatMap((t) => (t.kind === "write" ? [t.area] : [])))] as AiArea[];
    const [outcomes, playbook, memories] = await Promise.all([existing ? pendingOutcomes(conversation.id) : { ids: [], notes: [] }, getPlaybookText(), memoriesOf(user.id)]);
    // the what-if this chat is working on (read against today's jobs only
    // where a tool starts from it) — none for someone the what-ifs are closed to
    const working: WorkingScenario = { scenario: hidden.has("simulate") ? null : (existing?.scenario ?? null) };
    const context = questionContext({
      askedBy: user.name,
      now,
      areas,
      canDelete: hasPerm(user, AI_DELETE_KEY),
      noconfirm: hasPerm(user, AI_NOCONFIRM_KEY),
      paused: settings.actionsPaused,
      notes: outcomes.notes,
      workingScenario: working.scenario !== null,
      // a plant dashboard shows both lines (or Planning one line's scope), whatever line the person's screens open on
      line: pageLineOf(page) ?? line,
      memory: memoryNote(memories),
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
        send({ type: "start", conversationId: conversation.id, title: conversation.title, model });

        const startedAt = Date.now();
        const result = await ask({
          apiKey,
          model,
          // the person's Stop (the connection closed) stops the model too;
          // what was written is kept, and the question's turn is freed
          signal: request.signal,
          timeoutMs: (maxDuration - 60) * 1000,
          effort,
          maxCalls,
          history,
          question: questionMessages(
            question,
            context,
            files.files.length ? attachmentNote(files.files) : undefined,
            seenBlocks(files.files, fileRef),
            page,
          ),
          // the photos and PDFs go to the model as the files themselves
          expand: fileExpander(user.id),
          tools,
          ctx: { user, hidden, now, todayISO: factoryDayISO(now), conversationId: conversation.id, automationId: null, working, line, page },
          settings,
          playbook,
          events: {
            source: (source) => send({ type: "source", source }),
            status: (text) => send({ type: "status", text }),
            step: (step) => send({ type: "step", ...step }),
            text: (delta) => send({ type: "text", delta }),
            action: (action) => send({ type: "action", action }),
            memory: (text) => send({ type: "memory", text }),
          },
        }).catch(async () => {
          const error = "The answer could not finish. Reopen the chat and check any change cards before trying again.";
          await prisma.aiUsage.update({ where: { id: usage.id }, data: { error, finishedAt: new Date() } }).catch(() => {});
          send({ type: "done", costUsd: 0, totalMs: Date.now() - startedAt, error });
          if (open) controller.close();
          return null;
        });
        if (!result) return;
        const cost = costUsd(model, result.tokens);
        // a question the model refused to read keeps its files as lines only —
        // a file it cannot take would be refused again with every later question
        const names = new Map(files.files.map((f) => [f.id, f.name]));
        const keep = result.badRequest && files.files.length ? result.added.map((m) => withoutSeen(m, names)) : result.added;

        let finalError = result.error;
        try {
          await prisma.$transaction([
            ...keep.map((m) =>
              prisma.aiMessage.create({ data: { conversationId: conversation.id, role: m.role, content: m.content as unknown as Prisma.InputJsonValue } }),
            ),
            prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
            prisma.aiUsage.update({
              where: { id: usage.id },
              data: { calls: result.calls, queries: result.queries, ...result.tokens, costUsd: cost, error: result.error?.slice(0, 1000) ?? null, firstTokenMs: result.firstTokenMs, totalMs: result.totalMs, finishedAt: new Date() },
            }),
          ]);
        } catch (e) {
          console.error("AI: could not keep the conversation", e);
          finalError = "This answer could not be saved. Keep a copy and check any change cards before sending the question again.";
          await prisma.aiUsage.update({ where: { id: usage.id }, data: { costUsd: cost, error: "could not be saved", finishedAt: new Date() } }).catch(() => {});
        }

        // A bookkeeping failure must not label an already saved answer unsaved.
        if (!finalError) await markOutcomesTold(outcomes.ids).catch((e) => console.error("AI: could not mark outcomes read", e));

        send({ type: "done", costUsd: cost, totalMs: result.totalMs, ...(finalError ? { error: finalError } : {}) });
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
  } catch (e) {
    console.error("AI: could not start the question", e);
    await prisma.aiUsage.update({ where: { id: usage.id }, data: { error: "could not start", finishedAt: new Date() } }).catch(() => {});
    return fail(503, "The question could not start. Your files are still available; try again.");
  }
}
