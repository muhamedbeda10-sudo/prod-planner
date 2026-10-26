import { after } from "next/server";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, getFloorPeriod, recordKpiSnapshot, withoutFloor } from "@/lib/server/kpis";
import { getActiveLine } from "@/lib/server/line";
import { getLvDashboard } from "@/lib/server/lvDashboard";
import { LvDashboard } from "@/components/LvDashboard";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions } from "@/components/CockpitDecisions";
import { FloorPerformance } from "@/components/FloorPerformance";
import { ViewTabs, TRACKER_VIEWS } from "@/components/ViewTabs";
import { formatDate } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { isFloorDept } from "@/lib/domain/floorKpis";

export const dynamic = "force-dynamic";

// The home page is the planner's cockpit, a view of the Plan Tracker tab: is
// the plan on its day, did each centre work at the standard, where the crunch
// is, whether welding has parts, and what stopped the floor — with what needs
// a decision on top. The figures are the transformers'; the LV panels keep
// their own dashboard here. Under the plan, the floor's performance over the
// period and the department picked (?from=&to=&dept=), for the accounts that
// see Shifts.
export default async function Home({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; dept?: string }> }) {
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
  const sp = await searchParams;
  const floor = !hiddenTabsOf(me).has("shifts");
  const todayISO = factoryDayISO(new Date());
  // the floor section's own period: the last 7 days, unless the URL picks one
  const lastWeek = { label: "Last 7 days", from: addDaysISO(todayISO, -6), to: todayISO };
  const fromISO = sp.from && parseISODate(sp.from) ? sp.from : lastWeek.from;
  const toISO = sp.to && parseISODate(sp.to) ? sp.to : lastWeek.to;
  const dept = isFloorDept(sp.dept) ? sp.dept : "all";
  const [data, period] = await Promise.all([getCockpit(), floor ? getFloorPeriod({ fromISO, toISO, dept }) : null]);
  // today's point of the trend, kept once the page is on its way — the
  // cockpit's own figures, whatever period the floor section shows
  after(() => recordKpiSnapshot(data));
  // the shift log's figures stay with the accounts that see Shifts
  const shown = floor ? data : withoutFloor(data);
  return (
    <div className="space-y-3">
      <PrintHeader title="Cockpit" subtitle={data.week.planNo ? `Weekly plan ${data.week.planNo}` : undefined} date={formatDate(data.todayISO)} />
      <PageHead
        title="Cockpit"
        sub={`Transformers · today ${formatDate(data.todayISO)}${data.lastDayISO ? ` · last recorded day ${formatDate(data.lastDayISO)}` : ""} · everything in standard hours`}
        actions={<><CockpitDecisions actions={shown.actions} /><PrintButton /></>}
        views={<ViewTabs views={TRACKER_VIEWS} current="/" label="Tracker view" />}
      />
      <RememberLastVisit storageKey="cockpit:last" />
      <Cockpit data={shown} floor={floor} />
      {period && <FloorPerformance period={period} todayISO={data.todayISO} defaultRange={lastWeek} />}
    </div>
  );
}
