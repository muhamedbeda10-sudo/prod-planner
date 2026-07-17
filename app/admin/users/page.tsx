import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { PageHeader, Card } from "@/components/ui";
import { UsersManager } from "./UsersManager";

export const metadata = { title: "Users & Permissions — ATC" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const users = await prisma.user.findMany({
    orderBy: [{ isAdmin: "desc" }, { name: "asc" }],
    select: { id: true, email: true, name: true, isAdmin: true, perms: true, active: true, createdAt: true },
  });

  return (
    <div>
      <PageHeader title="👥 Users & Permissions" />
      <Card className="p-5">
        <UsersManager users={users} myId={me.id} />
      </Card>
    </div>
  );
}
