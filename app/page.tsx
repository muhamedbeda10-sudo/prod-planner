import { after } from "next/server";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, recordKpiSnapshot } from "@/lib/server/kpis";
import { getLvPlanning } from "@/lib/server/lvKpis";
import { loadOrNull, lvPlanningFor, trPlanningFor } from "@/lib/server/dashboards";
import { loadProductionDashboard } from "@/lib/server/productionDashboard";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions, PrintDecisions } from "@/components/CockpitDecisions";
import { LineSection } from "@/components/LineSection";
import { LvPlanning } from "@/components/LvPlanning";
import { PlantPlanning } from "@/components/PlantPlanning";
import { DashboardBar } from "@/components/PlanningParts";
import { DataCoveragePopup, ProductionDashboard, WorthALookPopup } from "@/components/ProductionDashboard";
import { LoadFailed } from "@/components/DataTable";
import { formatDate, formatDateTime } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { addDaysISO, slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { FLOOR_HISTORY_DAYS, floorDefault } from "@/lib/domain/floorKpis";
import { mergeActions } from "@/lib/domain/plantKpis";
import { dashboardActions, plantDashboardOf } from "@/lib/domain/plantDashboard";
import { PLANNING_SCOPE_LABEL, lvView, showsLv, showsTr, trView } from "@/lib/domain/planningDashboard";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The home page is the plant's one dashboard, the first place of the
// Dashboards tab: will we make the plan, where is the shortfall, what does it
// take — and what did the floor make, at what efficiency. One bar on top: All
// | Transformers | LV Panels first, the department, each line's plan filters,
// the floor's period, then how current the page is, the data's coverage,
// what is worth a look and one list of decisions — all of it in the address
// (lib/domain/plantDashboard.ts). Under All the plant's totals come first,
// then a section per line (its plan); the floor's figures are the last
// section, over the period. Every section folds. The floor's figures (the
// shift log's) stay with the accounts that see Shifts.
export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  await guardTab("/");
  const me = await getCurrentUser();
  const hidden = hiddenTabsOf(me);
  // the plan's sections are the home page's own tab; the floor's Production section is Shifts' —
  // the page is open with either (canSeePath), each half only with its own
  const plan = !hidden.has("dashboard");
  const floor = !hidden.has("shifts");
  const now = new Date();
  const todayISO = factoryDayISO(now);
  const { f, req } = plantDashboardOf(sp, todayISO);
  // each line on its own, and only the lines on screen: one that fails to load leaves the rest
  const [trRaw, lvRaw, prod] = await Promise.all([
    plan && showsTr(f) ? loadOrNull("dashboard", "the transformers' cockpit", getCockpit(now, { planNo: f.plan })) : null,
    // without the floor's figures, the panels' stage table reads the period of its own (with them it is not shown)
    plan && showsLv(f) ? loadOrNull("dashboard", "the panels' month", getLvPlanning({ from: !floor && f.from ? parseISODate(f.from) : null, to: !floor && f.to ? parseISODate(f.to) : null, family: f.family }, now)) : null,
    floor ? loadOrNull("dashboard", "the floor's figures", loadProductionDashboard(req, now)) : null,
  ]);
  // today's point of the trend, kept once the page is on its way — the newest plan's only
  if (trRaw?.week.newest) after(() => recordKpiSnapshot(trRaw));
  const tr = trRaw && trPlanningFor(trRaw, floor);
  const lv = lvRaw && lvPlanningFor(lvRaw, floor);
  const trv = tr && trView(tr, f, { floor });
  const lvv = lv && lvView(lv, f, { floor });
  const prodFailed = !prod || prod.failed.length === (req.scope === "all" ? 2 : 1);
  const actions = dashboardActions(mergeActions(tr?.actions ?? [], lv?.actions ?? []), prod && !prodFailed ? prod.actions : null);
  const lastDay = (iso: string | null | undefined) => (floor && iso ? ` · last recorded day ${formatDate(iso)}` : "");
  const asOf = formatDateTime(now);
  const range = slicerRangeLabel(req.fromISO, req.toISO);
  const beforeRange = prod?.before ? slicerRangeLabel(prod.before.fromISO, prod.before.toISO) : null;
  const marks = prod ? [...new Set(prod.view.days.filter((d) => d.workedH > 0).map((d) => d.dateISO))].sort() : [];

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboard:last" />
      <PrintHeader title={`Dashboard — ${f.scope === "all" ? "whole plant" : PLANNING_SCOPE_LABEL[f.scope]}`} />
      <PageHead title="Dashboard" sub={plan ? "Will we make the plan, and what did the floor make" : "What did the floor make, at what efficiency"} />
      <DashboardBar f={f} req={req} plan={plan} planNos={tr?.week.planNos ?? []} activePlan={tr?.week.planNo ?? null} asOf={asOf}
        period={floor ? {
          min: addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1)), max: todayISO, today: todayISO, marks, defaultRange: floorDefault(todayISO),
        } : null}
        actions={
          <>
            {prod && !prodFailed && <DataCoveragePopup view={prod.view} req={req} asOf={asOf} failed={prod.failed} beforeRange={beforeRange} />}
            {prod && !prodFailed && <WorthALookPopup view={prod.view} scope={req.scope} />}
            <CockpitDecisions actions={actions} />
          </>
        } />
      <PrintDecisions actions={actions} />

      {plan && f.scope === "all" && (tr && lv && trv && lvv ? (
        <PlantPlanning
          // the browser gets what the plant's totals show; each section gets its own line's
          monthLabel={tr.manpower.monthLabel} tr={{ people: trv.people }} lv={{ people: lvv.people }} floor={floor}
        />
      ) : <LoadFailed what="The plant's figures" />)}

      {plan && showsTr(f) && (
        <LineSection id="tr" page="planning" foldable={f.scope === "all"} title="Transformers" sub={tr ? `${tr.week.planNo ? `weekly plan ${tr.week.planNo}` : "no weekly plan yet"}${lastDay(tr.lastDayISO)} · in standard hours` : undefined}>
          {tr && trv ? (
            <Cockpit view={trv} f={f} floor={floor}
              // what the section reads, no more: the plan's lines go as the view's, filtered
              data={{ todayISO: tr.todayISO, trend: tr.trend, leads: tr.leads, horizonDays: tr.horizonDays, coverage: tr.coverage, wip: tr.wip, manpower: tr.manpower, load: tr.load, week: { planNo: tr.week.planNo, newest: tr.week.newest } }} />
          ) : <LoadFailed what="The transformers' cockpit" />}
        </LineSection>
      )}

      {plan && showsLv(f) && (
        <LineSection id="lv" page="planning" foldable={f.scope === "all"} title="LV panels" sub={lv ? `${lv.month.monthLabel}'s plan through four stages${lastDay(lv.lastDayISO)}` : undefined}>
          {lv && lvv ? (
            <LvPlanning view={lvv} f={f} floor={floor}
              data={{ todayISO: lv.todayISO, month: lv.month, open: lv.open, wip: lv.wip, manpower: lv.manpower, family: lv.family, ...(floor ? {} : { days: lv.days }) }} />
          ) : <LoadFailed what="The panels' month" />}
        </LineSection>
      )}

      {floor && (
        <LineSection id="floor" page="planning" foldable={plan} title="Production" sub={`what the floor made, at what efficiency · ${range}`}>
          {!prod || prodFailed ? <LoadFailed what="The production figures" /> : (
            <ProductionDashboard
              view={prod.view} req={req} range={range} beforeRange={beforeRange}
              // the browser gets what the cards show
              more={{
                trByType: prod.tr?.byType ?? null,
                lvByType: prod.lv?.byType ?? null,
                trExtras: prod.tr ? { stops: prod.tr.stops, quality: prod.tr.quality } : null,
                stops: prod.tr && req.scope !== "LV" ? prod.tr.losses : null,
              }}
            />
          )}
        </LineSection>
      )}
    </div>
  );
}
