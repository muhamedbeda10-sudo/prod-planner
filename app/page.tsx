import { after } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, recordKpiSnapshot, withoutFloor } from "@/lib/server/kpis";
import { getActiveLine } from "@/lib/server/line";
import { getLvDashboard } from "@/lib/server/lvDashboard";
import { LvDashboard } from "@/components/LvDashboard";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions } from "@/components/CockpitDecisions";
import { DashboardSections } from "@/components/DashboardSections";
import { formatDate } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

// The home page is the Planning dashboard, the first place of the Dashboards
// tab: what needs a decision, the week's plan and the lines behind, the load
// ahead, the month's pace and its people, and welding's parts. The figures
// are the transformers'; the LV panels keep their own dashboard here. How the
// floor worked is the Production dashboard (/dashboards/production).
export default async function Home({ searchParams }: { searchParams: Promise<{ from?: string | string[]; to?: string | string[]; dept?: string | string[] }> }) {
  await guardTab("/");
  const sp = await searchParams;
  if ((await getActiveLine()) === "LV") {
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="dashboard:last" />
        <DashboardSections current="planning" />
        <LvDashboard today={factoryDayISO(new Date())} d={await getLvDashboard({ from: typeof sp.from === "string" ? parseISODate(sp.from) : null, to: typeof sp.to === "string" ? parseISODate(sp.to) : null })} />
      </div>
    );
  }
  // the floor's period and department moved with it to the Production
  // dashboard — an old link (or the assistant's) lands there as it was
  if (sp.from || sp.to || sp.dept) {
    const q = new URLSearchParams();
    for (const k of ["from", "to", "dept"] as const) if (typeof sp[k] === "string") q.set(k, sp[k] as string);
    redirect(`/dashboards/production${q.size ? `?${q}` : ""}`);
  }

  const me = await getCurrentUser();
  const floor = !hiddenTabsOf(me).has("shifts");
  const data = await getCockpit();
  // today's point of the trend, kept once the page is on its way
  after(() => recordKpiSnapshot(data));
  // the shift log's figures stay with the accounts that see Shifts
  const shown = floor ? data : withoutFloor(data);
  return (
    <div className="space-y-3">
      <PrintHeader title="Planning" subtitle={data.week.planNo ? `Weekly plan ${data.week.planNo}` : undefined} date={formatDate(data.todayISO)} />
      <DashboardSections current="planning" />
      <PageHead
        title="Planning"
        sub={`Transformers · today ${formatDate(data.todayISO)}${data.lastDayISO ? ` · last recorded day ${formatDate(data.lastDayISO)}` : ""} · everything in standard hours`}
        actions={<><CockpitDecisions actions={shown.actions} /><PrintButton /></>}
      />
      <Cockpit data={shown} floor={floor} />
    </div>
  );
}
