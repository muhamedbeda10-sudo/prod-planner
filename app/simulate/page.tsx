import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { PageHead } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { WhatIfSimulator } from "@/components/WhatIfSimulator";

export const metadata = { title: "Simulator — ATC" };
export const dynamic = "force-dynamic";

// The what-if control room — a view of the Plan Tracker tab: move the dates
// and the capacity and see what lands. It models the transformers' plan, so
// it always shows the transformers, and the panels' tracker does not offer it.
export default async function SimulatePage() {
  await guardTab("/simulate");
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const [inputs, saved, applied] = await Promise.all([
    getWhatIfInputs(),
    prisma.simScenario.findMany({ orderBy: { updatedAt: "desc" }, select: { name: true, data: true, savedBy: true } }),
    prisma.runOrderEntry.findFirst({ orderBy: { appliedAt: "desc" }, select: { appliedAt: true, appliedBy: true } }),
  ]);

  return (
    <div>
      {/* view / dept were the Floor's, gone — a browser that remembers them drops them */}
      <RememberLastVisit storageKey="simulate:last" forget={["view", "dept"]} />
      <PageHead title="What-if Simulator" sub="Transformers · move the dates and the capacity and see what lands" />
      <WhatIfSimulator
        inputs={inputs}
        isAdmin={me.isAdmin}
        canSave={hasPerm(me, "simulator.edit")}
        savedScenarios={saved.map((s) => ({ name: s.name, data: s.data, savedBy: s.savedBy }))}
        appliedRunOrder={applied ? { atISO: applied.appliedAt.toISOString(), by: applied.appliedBy } : null}
      />
    </div>
  );
}
