import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getAllMachines } from "@/lib/server/machines";
import { PageHeader, Card } from "@/components/ui";
import { MachinesManager } from "./MachinesManager";

export const metadata = { title: "Machines — ATC" };
export const dynamic = "force-dynamic";

export default async function MachinesPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasPerm(me, "machines.manage")) redirect("/");

  const machines = await getAllMachines();

  return (
    <div>
      <PageHeader title="🏭 Machines & lines" />
      <Card className="p-5">
        <MachinesManager machines={machines} />
      </Card>
    </div>
  );
}
