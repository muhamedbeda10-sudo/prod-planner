import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { PageHeader } from "@/components/ui";
import { WhatIfSimulator } from "@/components/WhatIfSimulator";

export const metadata = { title: "What-if Simulator — ATC" };
export const dynamic = "force-dynamic";

export default async function SimulatePage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const [inputs, saved, applied] = await Promise.all([
    getWhatIfInputs(),
    prisma.simScenario.findMany({ orderBy: { updatedAt: "desc" }, select: { name: true, data: true, savedBy: true } }),
    prisma.runOrderEntry.findFirst({ orderBy: { appliedAt: "desc" }, select: { appliedAt: true, appliedBy: true } }),
  ]);

  return (
    <div>
      <PageHeader title="🧪 What-if Simulator" />
      <WhatIfSimulator
        inputs={inputs}
        isAdmin={me.isAdmin}
        savedScenarios={saved.map((s) => ({ name: s.name, data: s.data, savedBy: s.savedBy }))}
        appliedRunOrder={applied ? { atISO: applied.appliedAt.toISOString(), by: applied.appliedBy } : null}
      />
    </div>
  );
}
