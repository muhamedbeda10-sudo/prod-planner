import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AiCheck, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hiddenTabsOf } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { ask, apiErrorText, questionMessages } from "@/lib/server/ai/agent";
import { withoutFollowups } from "@/lib/domain/aiAnswer";
import { toolsFor } from "@/lib/server/ai/tools";
import { getPlaybookText } from "@/lib/server/ai/playbook";
import { runAiQuery } from "@/lib/server/ai/reader";
import { getActiveLine } from "@/lib/server/line";
import { AI_DENY_TEXT, addTokens, costUsd, questionContext } from "@/lib/domain/ai";
import { AI_AUTO_MODEL, judgePrompt, parseVerdict, routeModel } from "@/lib/domain/aiLearn";
import { factoryDayISO } from "@/lib/domain/dates";

// One quality check of the assistant (lib/domain/aiLearn.ts): the reference
// SQL run as the assistant's read-only login, the question asked as the owner
// with the chat's model and effort — reading only, nothing prepared — and the
// cheapest model judging the answer against the reference. What it cost is
// counted like any question; the last run is kept on the check.

const JUDGE = "claude-haiku-5-5";

export type CheckRun = { ok: true; pass: boolean; why: string; costUsd: number } | { ok: false; error: string };

export async function runCheck(check: AiCheck, owner: User): Promise<CheckRun> {
  const status = await aiStatusFor(owner);
  if (!status.ok) return { ok: false, error: status.reason ? AI_DENY_TEXT[status.reason] : "The assistant is not available right now." };
  const settings = await getAiSettings();
  const apiKey = apiKeyOf(settings);
  if (!apiKey) return { ok: false, error: "The Claude API key cannot be read — enter it again on General." };

  const reference = check.referenceSql ? await runAiQuery(check.referenceSql) : null;
  if (reference && !reference.ok) return { ok: false, error: `The reference SQL failed: ${reference.text}` };

  const now = new Date();
  const hidden = hiddenTabsOf(owner);
  const line = await getActiveLine();
  const model = settings.model === AI_AUTO_MODEL ? routeModel(check.question) : settings.model;
  const usage = await prisma.aiUsage.create({ data: { userId: owner.id, model, question: `Quality check: ${check.question}`.slice(0, 500) } });
  try {
    return await askAndJudge(check, owner, { apiKey, model, effort: settings.effort, maxCalls: settings.maxCalls, hidden, line, now, usageId: usage.id, reference: reference?.text ?? null });
  } catch (e) {
    // a failure half-way still closes the usage row — never "running" for ever
    await prisma.aiUsage.update({ where: { id: usage.id }, data: { error: apiErrorText(e).slice(0, 1000), finishedAt: new Date() } }).catch(() => {});
    throw e;
  }
}

async function askAndJudge(
  check: AiCheck,
  owner: User,
  o: { apiKey: string; model: string; effort: string; maxCalls: number; hidden: ReadonlySet<string>; line: Awaited<ReturnType<typeof getActiveLine>>; now: Date; usageId: number; reference: string | null },
): Promise<CheckRun> {
  const { apiKey, model, hidden, line, now } = o;
  const reference = o.reference === null ? null : { text: o.reference };
  // reading only: the changes are off for a check, whatever the settings say
  const tools = toolsFor(owner, { hidden, actionsPaused: true, unattended: true });
  const context = questionContext({ askedBy: owner.name, now, areas: [], canDelete: false, noconfirm: false, paused: true, notes: [], line });
  const answer = await ask({
    apiKey,
    model,
    effort: o.effort,
    history: [],
    question: questionMessages(check.question, context),
    tools,
    ctx: { user: owner, hidden, now, todayISO: factoryDayISO(now), conversationId: null, automationId: null, line },
    settings: { actionsPaused: true },
    playbook: await getPlaybookText(),
    events: { status: () => {}, text: () => {} },
    via: "automation",
    allowAuto: false,
    maxCalls: o.maxCalls,
  });

  // the chat's follow-up questions are not part of the answer judged or kept
  const written = withoutFollowups(answer.text);
  let tokens = answer.tokens;
  let cost = costUsd(model, answer.tokens);
  let verdict: { pass: boolean; why: string };
  if (answer.error || !written.trim()) {
    verdict = { pass: false, why: answer.error ?? "It gave no answer." };
  } else {
    try {
      const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
      const msg = await client.messages.create({
        model: JUDGE,
        max_tokens: 400,
        messages: [{ role: "user", content: judgePrompt({ question: check.question, expect: check.expect, reference: reference ? reference.text.slice(0, 6000) : null, answer: written.slice(0, 12_000) }) }],
      });
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      verdict = parseVerdict(text);
      const judged = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
      tokens = addTokens(tokens, judged);
      cost += costUsd(JUDGE, judged);
    } catch (e) {
      verdict = { pass: false, why: `The judge could not be asked: ${apiErrorText(e)}` };
    }
  }

  await prisma.$transaction([
    prisma.aiUsage.update({
      where: { id: o.usageId },
      data: { calls: answer.calls + 1, queries: answer.queries + (reference ? 1 : 0), ...tokens, costUsd: cost, error: answer.error?.slice(0, 1000) ?? null, firstTokenMs: answer.firstTokenMs, totalMs: answer.totalMs, finishedAt: new Date() },
    }),
    prisma.aiCheck.update({
      where: { id: check.id },
      data: { lastRunAt: new Date(), lastPass: verdict.pass, lastWhy: verdict.why, lastAnswer: written.slice(0, 12_000), lastModel: model, lastCostUsd: cost },
    }),
  ]);
  return { ok: true, pass: verdict.pass, why: verdict.why, costUsd: cost };
}
