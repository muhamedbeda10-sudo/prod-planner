import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { PageHeader, Card } from "@/components/ui";
import { monthStart } from "@/lib/domain/ai";
import { UsersManager } from "./UsersManager";

export const metadata = { title: "Users & Permissions — ATC" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  // the owner's page alone — admins included out
  if (!me.isOwner) redirect("/");

  const [users, access, spent] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ isOwner: "desc" }, { isAdmin: "desc" }, { name: "asc" }],
      select: { id: true, email: true, name: true, isAdmin: true, isOwner: true, perms: true, hiddenTabs: true, active: true, createdAt: true },
    }),
    prisma.aiAccess.findMany(),
    prisma.aiUsage.groupBy({ by: ["userId"], where: { at: { gte: monthStart(new Date()) } }, _sum: { costUsd: true } }),
  ]);
  // the AI assistant: who may use it, their monthly allowance, and this month's spend
  const accessOf = new Map(access.map((a) => [a.userId, a]));
  const spentOf = new Map(spent.map((u) => [u.userId, u._sum.costUsd ?? 0]));
  const rows = users.map((u) => ({
    ...u,
    ai: { enabled: u.isOwner || !!accessOf.get(u.id)?.enabled, monthlyUsd: accessOf.get(u.id)?.monthlyUsd ?? 0, spent: spentOf.get(u.id) ?? 0 },
  }));

  return (
    <div>
      <PageHeader title="👥 Users & Permissions" />
      <Card className="p-3 sm:p-5">
        <UsersManager users={rows} myId={me.id} />
      </Card>
    </div>
  );
}
