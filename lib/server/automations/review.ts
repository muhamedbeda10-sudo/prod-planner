import "server-only";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { effectiveUser, hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { aiStatusFor, apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { ask, questionMessages } from "@/lib/server/ai/agent";
import { toolsFor } from "@/lib/server/ai/tools";
import { getPlaybookText } from "@/lib/server/ai/playbook";
import { deliverToInbox } from "@/lib/server/inbox";
import { offDays } from "./store";
import { costUsd, reviewContext, reviewQuestion, writesArabic } from "@/lib/domain/ai";
import { AI_DELETE_KEY, type AiArea } from "@/lib/domain/aiActions";
import { factoryClockHHMM, factoryDayISO } from "@/lib/domain/dates";

// The morning review ("AI — daily review and suggestions", ticked per person
// by the owner): once every working day, from the owner's time on the factory clock (reviewAt),
// the assistant looks at the plant from that person's side and sends their
// inbox what matters today — each fix it can make prepared as a change that
// waits for their approval (never one that runs by itself). It runs as them,
// with their permissions and their month's allowance, like a question.

export const REVIEW_KEY = "ai.suggestions";
/** The person's day already reviewed — a server-side mark, not a preference
 *  anyone sets. */
const REVIEWED_ON = "ai:reviewedOn";

/** Take today's review for one person — false when another tick has it. */
async function claimToday(userId: number, today: string): Promise<boolean> {
  const moved = await prisma.userPref.updateMany({ where: { userId, key: REVIEWED_ON, NOT: { value: today } }, data: { value: today } });
  if (moved.count === 1) return true;
  try {
    await prisma.userPref.create({ data: { userId, key: REVIEWED_ON, value: today } });
    return true;
  } catch {
    // there already, with today on it: done, or being done
    return false;
  }
}

/** The language the person asks the assistant in — their latest question's. */
async function languageOf(userId: number): Promise<"Arabic" | "English"> {
  const last = await prisma.aiUsage.findFirst({ where: { userId, conversationId: { not: null } }, orderBy: { id: "desc" }, select: { question: true } });
  return last && !writesArabic(last.question) ? "English" : "Arabic";
}

/** Today's reviews that are due, until the deadline. The number run. */
export async function runDailyReviews(o: { now: Date; deadline: number }): Promise<number> {
  const today = factoryDayISO(o.now);
  const s = await getAiSettings();
  if (s.reviewPaused) return 0;
  if ((await offDays(o.now))(today) || factoryClockHHMM(o.now) < s.reviewAt) return 0;
  // the key is a CSV entry: a contains() narrows, hasPerm decides
  const candidates = await prisma.user.findMany({ where: { active: true, perms: { contains: REVIEW_KEY } } });
  let ran = 0;
  for (const row of candidates) {
    if (Date.now() > o.deadline) break;
    const user = effectiveUser(row);
    if (!hasPerm(user, REVIEW_KEY)) continue;
    const done = await prisma.userPref.findUnique({ where: { userId_key: { userId: user.id, key: REVIEWED_ON } }, select: { value: true } });
    if (done?.value === today) continue;
    if (!(await claimToday(user.id, today))) continue;
    try {
      await reviewFor(user, o.now);
      ran++;
    } catch (e) {
      console.error(`review: ${user.name} failed`, e);
    }
  }
  return ran;
}

/** One person's review: the assistant, as them, and what it says and
 *  prepares into their inbox. Skipped quietly when the assistant is not
 *  available to them (switched off, or their month's allowance spent). */
export async function reviewFor(user: User, now: Date): Promise<void> {
  const status = await aiStatusFor(user);
  if (!status.ok) return;
  const settings = await getAiSettings();
  const apiKey = apiKeyOf(settings);
  if (!apiKey) return;
  const hidden = hiddenTabsOf(user);
  const tools = toolsFor(user, { hidden, actionsPaused: settings.actionsPaused, unattended: true });
  const areas = [...new Set(tools.flatMap((t) => (t.kind === "write" ? [t.area] : [])))] as AiArea[];
  const usage = await prisma.aiUsage.create({ data: { userId: user.id, model: settings.autoModel, question: "Morning review" } });
  const actionIds: number[] = [];
  const answer = await ask({
    apiKey,
    model: settings.autoModel,
    effort: settings.autoEffort,
    history: [],
    question: questionMessages(reviewQuestion(user.name, await languageOf(user.id)), reviewContext({ name: user.name, now, areas, canDelete: hasPerm(user, AI_DELETE_KEY) })),
    tools,
    ctx: { user, hidden, now, todayISO: factoryDayISO(now), conversationId: null, automationId: null },
    settings,
    playbook: await getPlaybookText(),
    events: { status: () => {}, text: () => {}, action: (v) => actionIds.push(v.id) },
    via: "automation",
    // a suggestion is asked, never done: every change waits for the person
    allowAuto: false,
    maxCalls: settings.maxCalls,
  });
  await prisma.aiUsage.update({
    where: { id: usage.id },
    data: { calls: answer.calls, queries: answer.queries, ...answer.tokens, costUsd: costUsd(settings.autoModel, answer.tokens), error: answer.error?.slice(0, 1000) ?? null, finishedAt: new Date() },
  });
  if (answer.error) return;
  await deliverToInbox([{
    userId: user.id,
    kind: "suggestion",
    title: `Today's review — ${factoryDayISO(now)}`,
    body: answer.text.trim() || "Nothing needs your attention this morning.",
    fromName: "The assistant's morning review",
    actionIds,
  }]);
}
