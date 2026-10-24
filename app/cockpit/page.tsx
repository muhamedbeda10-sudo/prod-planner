import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getCockpit } from "@/lib/server/kpis";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { formatDate } from "@/lib/domain/format";

export const metadata = { title: "Planning cockpit — ATC" };
export const dynamic = "force-dynamic";

// The planner's one page: is the plan on its day, did each centre work at the
// standard, where the crunch is, whether welding has parts, and what stopped
// the floor — with what needs a decision on top. Viewing is free.
export default async function CockpitPage() {
  await guardTab("/cockpit");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const data = await getCockpit();
  return (
    <div className="space-y-3">
      <PrintHeader title="Planning cockpit" subtitle={data.week.planNo ? `Weekly plan ${data.week.planNo}` : undefined} date={formatDate(data.todayISO)} />
      <PageHead
        title="Planning cockpit"
        sub={`Today ${formatDate(data.todayISO)}${data.lastDayISO ? ` · last recorded day ${formatDate(data.lastDayISO)}` : ""} · everything in standard hours`}
        actions={<PrintButton />}
      />
      <Cockpit data={data} />
    </div>
  );
}
