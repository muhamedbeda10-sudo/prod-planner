import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { apiKeyOf, getAiSettings, todayStart } from "@/lib/server/ai/access";
import { monthStart } from "@/lib/domain/ai";
import { AI_PERM_KEYS, parsePerms } from "@/lib/domain/permissions";
import { AiAdmin } from "@/components/AiAdmin";
import { schedulerStatus } from "@/lib/server/automations/scheduler";
import { automationViews } from "@/lib/server/automations/views";
import { getWatchSettings } from "@/lib/server/watchdog";

export const metadata = { title: "AI assistant settings — ATC" };
export const dynamic = "force-dynamic";
// a test run of an automation from here waits for the assistant
export const maxDuration = 300;

// The AI assistant's settings — the owner's alone: the Claude API key, the
// models and how hard they think, who may use it and how much each may spend
// a day and a month, when automations run, and what it has cost and changed.
export default async function AiAdminPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isOwner) redirect("/");

  const now = new Date();
  const from = monthStart(now);
  const today = todayStart(now);
  const lastFrom = monthStart(new Date(from.getTime() - 86_400_000));
  const [s, users, access, byUser, byUserToday, plant, plantToday, lastMonth, recent] = await Promise.all([
    getAiSettings(),
    prisma.user.findMany({ orderBy: [{ isOwner: "desc" }, { active: "desc" }, { name: "asc" }], select: { id: true, name: true, email: true, isOwner: true, active: true, perms: true } }),
    prisma.aiAccess.findMany(),
    prisma.aiUsage.groupBy({ by: ["userId"], where: { at: { gte: from } }, _sum: { costUsd: true }, _count: { _all: true }, _max: { at: true } }),
    prisma.aiUsage.groupBy({ by: ["userId"], where: { at: { gte: today } }, _sum: { costUsd: true } }),
    prisma.aiUsage.aggregate({ where: { at: { gte: from } }, _sum: { costUsd: true }, _count: { _all: true } }),
    prisma.aiUsage.aggregate({ where: { at: { gte: today } }, _sum: { costUsd: true }, _count: { _all: true } }),
    prisma.aiUsage.aggregate({ where: { at: { gte: lastFrom, lt: from } }, _sum: { costUsd: true } }),
    prisma.aiUsage.findMany({ orderBy: { at: "desc" }, take: 60, include: { user: { select: { name: true } } } }),
  ]);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const [changes, clock, automations, feedback, rated30, checks, openCount, watch] = await Promise.all([
    prisma.aiAction.findMany({ orderBy: { id: "desc" }, take: 80, include: { user: { select: { name: true } } } }),
    schedulerStatus(),
    automationViews({}),
    prisma.aiFeedback.findMany({ orderBy: [{ status: "desc" }, { id: "desc" }], take: 120, include: { user: { select: { name: true } } } }),
    prisma.aiFeedback.groupBy({ by: ["rating"], where: { createdAt: { gte: since30 } }, _count: { _all: true } }),
    prisma.aiCheck.findMany({ orderBy: { id: "asc" } }),
    prisma.aiFeedback.count({ where: { status: "new", rating: "down" } }),
    getWatchSettings(),
  ]);
  const accessOf = new Map(access.map((a) => [a.userId, a]));
  const usageOf = new Map(byUser.map((u) => [u.userId, u]));
  const todayOf = new Map(byUserToday.map((u) => [u.userId, u._sum.costUsd ?? 0]));

  return (
    <AiAdmin
      clock={clock}
      automations={automations}
      data={{
        hasKey: !!s.apiKeyEnc,
        keyReadable: !s.apiKeyEnc || apiKeyOf(s) !== null,
        keyHint: s.apiKeyHint,
        enabled: s.enabled,
        chat: { model: s.model, effort: s.effort },
        auto: { model: s.autoModel, effort: s.autoEffort },
        plantCap: s.monthlyUsd,
        plantDayCap: s.dailyUsd,
        maxCalls: s.maxCalls,
        plantSpent: plant._sum.costUsd ?? 0,
        plantQuestions: plant._count._all,
        plantSpentToday: plantToday._sum.costUsd ?? 0,
        plantQuestionsToday: plantToday._count._all,
        lastMonthSpent: lastMonth._sum.costUsd ?? 0,
        actionsPaused: s.actionsPaused,
        automationsPaused: s.automationsPaused,
        hours: { from: s.autoFrom, to: s.autoTo, weekdays: s.autoWeekdays },
        reviewAt: s.reviewAt,
        reviewPaused: s.reviewPaused,
        updatedBy: s.updatedBy,
        users: users.map((u) => {
          const a = accessOf.get(u.id);
          const used = usageOf.get(u.id);
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            isOwner: u.isOwner,
            active: u.active,
            enabled: u.isOwner || !!a?.enabled,
            monthlyUsd: a?.monthlyUsd ?? 0,
            dailyUsd: a?.dailyUsd ?? 0,
            spent: used?._sum.costUsd ?? 0,
            spentToday: todayOf.get(u.id) ?? 0,
            questions: used?._count._all ?? 0,
            lastAt: used?._max.at?.toISOString() ?? null,
            // what the assistant may do for them, as stored (the owner's rights are implied)
            aiKeys: AI_PERM_KEYS.filter((k) => parsePerms(u.perms).has(k)),
          };
        }),
        changes: changes.map((c) => ({
          id: c.id,
          at: c.createdAt.toISOString(),
          who: c.user.name,
          title: c.title,
          summary: c.summary,
          status: c.status,
          risk: c.risk,
          auto: c.auto,
          automationId: c.automationId,
          error: c.error,
        })),
        recent: recent.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          who: r.user?.name ?? "(deleted account)",
          question: r.question,
          model: r.model,
          queries: r.queries,
          tokens: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens,
          costUsd: r.costUsd,
          error: r.error,
          running: !r.finishedAt,
          totalMs: r.totalMs,
          firstTokenMs: r.firstTokenMs,
        })),
        watchdog: {
          enabled: watch.enabled, at: watch.at, dropPct: watch.dropPct, absencePct: watch.absencePct, chronicDays: watch.chronicDays, chronicOf: watch.chronicOf,
          lateMinDays: watch.lateMinDays, recipientIds: watch.recipientIds, aiSummary: watch.aiSummary, lastRunAt: watch.lastRunAt?.toISOString() ?? null,
          lastFindings: watch.lastFindings, people: users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, isOwner: u.isOwner })),
        },
        meId: me.id,
        quality: {
          feedback: feedback.map((f) => ({
            id: f.id, at: f.createdAt.toISOString(), who: f.user?.name ?? "(deleted account)", rating: f.rating === "up" ? "up" : "down",
            note: f.note, question: f.question, answer: f.answer, model: f.model, done: f.status === "done",
          })),
          up30: rated30.find((r) => r.rating === "up")?._count._all ?? 0,
          down30: rated30.find((r) => r.rating === "down")?._count._all ?? 0,
          openCount,
          checks: checks.map((c) => ({
            id: c.id, question: c.question, expect: c.expect, referenceSql: c.referenceSql, active: c.active, lastRunAt: c.lastRunAt?.toISOString() ?? null,
            lastPass: c.lastPass, lastWhy: c.lastWhy, lastAnswer: c.lastAnswer, lastCostUsd: c.lastCostUsd,
          })),
        },
      }}
    />
  );
}
