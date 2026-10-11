import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { apiKeyOf, getAiSettings } from "@/lib/server/ai/access";
import { monthStart } from "@/lib/domain/ai";
import { PageHead } from "@/components/ui";
import { AiAdmin } from "@/components/AiAdmin";

export const metadata = { title: "AI assistant settings — ATC" };
export const dynamic = "force-dynamic";

// The AI assistant's settings — the owner's alone: the Claude API key, the
// model, who may use it and how much each may spend a month, and what it
// has cost so far.
export default async function AiAdminPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isOwner) redirect("/");

  const now = new Date();
  const from = monthStart(now);
  const lastFrom = monthStart(new Date(from.getTime() - 86_400_000));
  const [s, users, access, byUser, plant, lastMonth, recent] = await Promise.all([
    getAiSettings(),
    prisma.user.findMany({ orderBy: [{ isOwner: "desc" }, { active: "desc" }, { name: "asc" }], select: { id: true, name: true, email: true, isOwner: true, active: true } }),
    prisma.aiAccess.findMany(),
    prisma.aiUsage.groupBy({ by: ["userId"], where: { at: { gte: from } }, _sum: { costUsd: true }, _count: { _all: true }, _max: { at: true } }),
    prisma.aiUsage.aggregate({ where: { at: { gte: from } }, _sum: { costUsd: true }, _count: { _all: true } }),
    prisma.aiUsage.aggregate({ where: { at: { gte: lastFrom, lt: from } }, _sum: { costUsd: true } }),
    prisma.aiUsage.findMany({ orderBy: { at: "desc" }, take: 40, include: { user: { select: { name: true } } } }),
  ]);
  const accessOf = new Map(access.map((a) => [a.userId, a]));
  const usageOf = new Map(byUser.map((u) => [u.userId, u]));

  return (
    <div className="max-w-6xl">
      <PageHead title="AI assistant settings" />
      <AiAdmin
        data={{
          hasKey: !!s.apiKeyEnc,
          keyReadable: !s.apiKeyEnc || apiKeyOf(s) !== null,
          keyHint: s.apiKeyHint,
          enabled: s.enabled,
          model: s.model,
          plantCap: s.monthlyUsd,
          plantSpent: plant._sum.costUsd ?? 0,
          plantQuestions: plant._count._all,
          lastMonthSpent: lastMonth._sum.costUsd ?? 0,
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
              spent: used?._sum.costUsd ?? 0,
              questions: used?._count._all ?? 0,
              lastAt: used?._max.at?.toISOString() ?? null,
            };
          }),
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
          })),
        }}
      />
    </div>
  );
}
