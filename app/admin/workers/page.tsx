import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getAllWorkers } from "@/lib/server/workers";
import { PageHeader, Card } from "@/components/ui";
import { WorkersManager } from "./WorkersManager";

export const metadata = { title: "Workers — ATC" };
export const dynamic = "force-dynamic";

export default async function WorkersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasPerm(me, "workers.manage")) redirect("/");

  const workers = await getAllWorkers();

  return (
    <div>
      <PageHeader title="🧑‍🏭 Production Workers" />
      <Card className="p-5">
        <WorkersManager workers={workers} />
      </Card>
    </div>
  );
}
