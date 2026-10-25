import { after } from "next/server";
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
import { ViewTabs, TRACKER_VIEWS } from "@/components/ViewTabs";
import { formatDate } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

// The home page is the planner's cockpit, a view of the Plan Tracker tab: is
// the plan on its day, did each centre work at the standard, where the crunch
// is, whether welding has parts, and what stopped the floor — with what needs
// a decision on top. The figures are the transformers'; the LV panels keep
// their own dashboard here.
export default async function Home({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await guardTab("/");
  if ((await getActiveLine()) === "LV") {
    const sp = await searchParams;
    return (
      <>
        <RememberLastVisit storageKey="dashboard:last" />
        <LvDashboard today={factoryDayISO(new Date())} d={await getLvDashboard({ from: sp.from ? parseISODate(sp.from) : null, to: sp.to ? parseISODate(sp.to) : null })} />
      </>
    );
  }

  const me = await getCurrentUser();
  const data = await getCockpit();
  // today's point of the trend, kept once the page is on its way
  after(() => recordKpiSnapshot(data));
  const floor = !hiddenTabsOf(me).has("shifts");
  return (
    <div className="space-y-3">
      <PrintHeader title="Cockpit" subtitle={data.week.planNo ? `Weekly plan ${data.week.planNo}` : undefined} date={formatDate(data.todayISO)} />
      <PageHead
        title="Cockpit"
        sub={`Transformers · today ${formatDate(data.todayISO)}${data.lastDayISO ? ` · last recorded day ${formatDate(data.lastDayISO)}` : ""} · everything in standard hours`}
        actions={<PrintButton />}
        views={<ViewTabs views={TRACKER_VIEWS} current="/" label="Tracker view" />}
      />
      {/* the shift log's figures stay with the accounts that see Shifts */}
      {floor ? <Cockpit data={data} /> : <Cockpit data={withoutFloor(data)} floor={false} />}
    </div>
  );
}
