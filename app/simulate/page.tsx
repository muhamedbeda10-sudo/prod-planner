import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { PageHeader } from "@/components/ui";
import { WhatIfSimulator } from "@/components/WhatIfSimulator";

export const metadata = { title: "What-if Simulator — ATC" };
export const dynamic = "force-dynamic";

export default async function SimulatePage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const inputs = await getWhatIfInputs();
  return (
    <div>
      <PageHeader title="🧪 What-if Simulator" />
      <WhatIfSimulator inputs={inputs} />
    </div>
  );
}
