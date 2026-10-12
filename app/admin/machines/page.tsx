import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getAllMachines } from "@/lib/server/machines";
import { getAllMachineRules } from "@/lib/server/machineRules";
import { isMachinePlanningOn } from "@/lib/server/data";
import { PageHeader, Card } from "@/components/ui";
import { MachinesManager } from "./MachinesManager";

export const metadata = { title: "Machines — ATC" };
export const dynamic = "force-dynamic";

export default async function MachinesPage() {
  await guardTab("/admin/machines");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasPerm(me, "machines.manage")) redirect("/");

  const [machines, rules, planningOn] = await Promise.all([getAllMachines(), getAllMachineRules(), isMachinePlanningOn()]);

  return (
    <div>
      <PageHeader title="🏭 Machines & lines" />
      <Card className="p-5">
        <MachinesManager machines={machines} rules={rules} planningOn={planningOn} />
      </Card>
    </div>
  );
}
