import { after } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, recordKpiSnapshot, withoutFloor } from "@/lib/server/kpis";
import { getLvPlanning, lvWithoutFloor } from "@/lib/server/lvKpis";
import { loadPlanningAll } from "@/lib/server/dashboards";
import { getActiveLine } from "@/lib/server/line";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions } from "@/components/CockpitDecisions";
import { DashboardSections } from "@/components/DashboardSections";
import { LineScopeTabs } from "@/components/LineScopeTabs";
import { LvPlanning } from "@/components/LvPlanning";
import { PlantPlanning } from "@/components/PlantPlanning";
import { formatDate } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { DASH_SCOPE_NAME, productionRedirectOf, resolveDashScope } from "@/lib/domain/dashboardScope";
import type { CockpitAction } from "@/lib/domain/kpis";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const dayOf = (v: string | string[] | undefined) => (typeof v === "string" ? parseISODate(v) : null);

// The home page is the Planning dashboard, the first place of the Dashboards
// tab: will we make the plan, where is the next shortfall, what does it take?
// It shows one line or the whole plant (?line=all|TR|LV; the nav's toggle
// decides when the address says nothing): the transformers' cockpit, the
// panels' month on the chain, or the plant's summary with the two side by
// side. How the floor worked is the Production dashboard
// (/dashboards/production), which takes the same scope.
export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const active = await getActiveLine();
  const scope = resolveDashScope(sp.line, active);
  // the floor's figures moved to the Production dashboard: an old link to them here lands there
  const moved = productionRedirectOf(sp, scope);
  if (moved) redirect(moved);
  await guardTab("/");
  const me = await getCurrentUser();
  const floor = !hiddenTabsOf(me).has("shifts");
  const todayISO = factoryDayISO(new Date());
  // the panels' stage table reads a period of its own
  const period = { from: dayOf(sp.from), to: dayOf(sp.to) };
  const head = (sub: string, decisions: readonly CockpitAction[]) => (
    <PageHead title="Planning" sub={sub} actions={<><LineScopeTabs scope={scope} active={active} /><CockpitDecisions actions={decisions} /><PrintButton /></>} />
  );

  if (scope === "LV") {
    const data = await getLvPlanning(period);
    const shown = floor ? data : lvWithoutFloor(data);
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="dashboard:last" />
        <PrintHeader title="Planning — LV Panels" subtitle={`${data.month.monthLabel}'s plan`} date={formatDate(todayISO)} />
        <DashboardSections current="planning" />
        {head(`${DASH_SCOPE_NAME.LV} · today ${formatDate(todayISO)}${floor && data.lastDayISO ? ` · last recorded day ${formatDate(data.lastDayISO)}` : ""} · the month's plan through four stages`, shown.actions)}
        <LvPlanning data={shown} floor={floor} />
      </div>
    );
  }

  if (scope === "all") {
    const all = await loadPlanningAll(floor, period);
    // today's point of the trend, kept once the page is on its way
    after(() => recordKpiSnapshot(all.tr));
    const { tr, lv } = all;
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="dashboard:last" />
        <PrintHeader title="Planning — whole plant" subtitle={tr.week.planNo ? `Weekly plan ${tr.week.planNo} · ${lv.month.monthLabel}` : lv.month.monthLabel} date={formatDate(todayISO)} />
        <DashboardSections current="planning" />
        {head(`${DASH_SCOPE_NAME.all} · today ${formatDate(todayISO)} · each line in its own terms, the plant where figures add`, all.actions)}
        {/* the browser gets what the plant's page shows, not the whole of both lines */}
        <PlantPlanning
          tr={{ todayISO: tr.todayISO, week: tr.week, manpower: tr.manpower, wip: tr.wip }}
          lv={{ month: lv.month, open: lv.open, wip: lv.wip, urgentStuck: lv.urgentStuck, manpower: lv.manpower }}
          floor={floor} active={active} actions={all.actions} summary={all.summary}
        />
      </div>
    );
  }

  const tr = await getCockpit();
  after(() => recordKpiSnapshot(tr));
  // the shift log's figures stay with the accounts that see Shifts
  const shown = floor ? tr : withoutFloor(tr);
  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboard:last" />
      <PrintHeader title="Planning — Transformers" subtitle={tr.week.planNo ? `Weekly plan ${tr.week.planNo}` : undefined} date={formatDate(tr.todayISO)} />
      <DashboardSections current="planning" />
      {head(`${DASH_SCOPE_NAME.TR} · today ${formatDate(tr.todayISO)}${floor && tr.lastDayISO ? ` · last recorded day ${formatDate(tr.lastDayISO)}` : ""} · everything in standard hours`, shown.actions)}
      <Cockpit data={shown} floor={floor} />
    </div>
  );
}
