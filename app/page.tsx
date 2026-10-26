import { after } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, recordKpiSnapshot } from "@/lib/server/kpis";
import { getLvPlanning } from "@/lib/server/lvKpis";
import { loadOrNull, lvPlanningFor, trPlanningFor } from "@/lib/server/dashboards";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions, PrintDecisions } from "@/components/CockpitDecisions";
import { LineSection } from "@/components/LineSection";
import { LvPlanning } from "@/components/LvPlanning";
import { PlantPlanning } from "@/components/PlantPlanning";
import { PlanningBar } from "@/components/PlanningParts";
import { LoadFailed } from "@/components/DataTable";
import { formatDate, formatDateTime } from "@/lib/domain/format";
import { parseISODate } from "@/lib/domain/dates";
import { productionRedirectOf } from "@/lib/domain/dashboardLinks";
import { mergeActions } from "@/lib/domain/plantKpis";
import { PLANNING_SCOPE_LABEL, lvView, planningFiltersOf, showsLv, showsTr, trView } from "@/lib/domain/planningDashboard";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The home page is the Planning dashboard, the first place of the Dashboards
// tab: will we make the plan, where is the shortfall, what does it take?
// One bar on top — All | Transformers | LV Panels first, each line's filters,
// how current the page is and the decisions — all of it in the address
// (lib/domain/planningDashboard.ts). Under All the plant's figures come first
// (each line's headline, then the hours and people that add), then a section
// per line; a line's scope shows its section alone. Each section reads what
// the figures rest on, its headline figures, the plan by its days beside its
// decisions, two secondary charts, the month and its people and the lines at
// risk; a figure opens the rows it is the sum of. How the floor worked is the
// Production dashboard (/dashboards/production).
export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  // the floor's figures moved to the Production dashboard: an old link to them here lands there
  const moved = productionRedirectOf(sp);
  if (moved) redirect(moved);
  await guardTab("/");
  const me = await getCurrentUser();
  const floor = !hiddenTabsOf(me).has("shifts");
  const f = planningFiltersOf(sp);
  const now = new Date();
  // each line on its own, and only the lines on screen: one that fails to load leaves the other
  const [trRaw, lvRaw] = await Promise.all([
    showsTr(f) ? loadOrNull("planning", "the transformers' cockpit", getCockpit(now, { planNo: f.plan })) : null,
    // the panels' stage table reads a period of its own
    showsLv(f) ? loadOrNull("planning", "the panels' month", getLvPlanning({ from: f.from ? parseISODate(f.from) : null, to: f.to ? parseISODate(f.to) : null, family: f.family }, now)) : null,
  ]);
  // today's point of the trend, kept once the page is on its way — the newest plan's only
  if (trRaw?.week.newest) after(() => recordKpiSnapshot(trRaw));
  // the shift log's figures stay with the accounts that see Shifts
  const tr = trRaw && trPlanningFor(trRaw, floor);
  const lv = lvRaw && lvPlanningFor(lvRaw, floor);
  const trv = tr && trView(tr, f, { floor });
  const lvv = lv && lvView(lv, f, { floor });
  const actions = mergeActions(tr?.actions ?? [], lv?.actions ?? []);
  const lastDay = (iso: string | null | undefined) => (floor && iso ? ` · last recorded day ${formatDate(iso)}` : "");
  const asOf = formatDateTime(now);

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboard:last" />
      <PrintHeader
        title={`Planning — ${f.scope === "all" ? "whole plant" : PLANNING_SCOPE_LABEL[f.scope]}`}
        subtitle={[tr?.week.planNo ? `Weekly plan ${tr.week.planNo}` : null, lv?.month.monthLabel].filter(Boolean).join(" · ") || undefined}
        date={asOf}
      />
      <PageHead title="Planning" sub="Will we make the plan, where is the shortfall, and what does it take" />
      <PlanningBar f={f} planNos={tr?.week.planNos ?? []} activePlan={tr?.week.planNo ?? null} asOf={asOf}
        actions={<CockpitDecisions actions={actions} />} />
      <PrintDecisions actions={actions} />

      {f.scope === "all" && (tr && lv && trv && lvv ? (
        <PlantPlanning
          // the browser gets what the plant's figures show; each section gets its own line's
          tr={{ monthLabel: tr.manpower.monthLabel, planNo: tr.week.planNo, finish: trv.finish, lateCount: trv.late.length, people: trv.people }}
          lv={{ monthLabel: lv.month.monthLabel, panels: lv.month.panels, complete: lv.month.complete, doneShare: lv.month.pace.doneShare, expectedShare: lv.month.pace.expectedShare, urgentShort: lvv.atRisk.filter((r) => r.status === "urgent").length, urgentOpen: lv.open.urgent, people: lvv.people }}
          f={f} floor={floor}
        />
      ) : <LoadFailed what="The plant's figures" />)}

      {showsTr(f) && (
        <LineSection id="tr" page="planning" foldable={f.scope === "all"} title="Transformers" sub={tr ? `${tr.week.planNo ? `weekly plan ${tr.week.planNo}` : "no weekly plan yet"}${lastDay(tr.lastDayISO)} · in standard hours` : undefined}>
          {tr && trv ? (
            <Cockpit view={trv} f={f} floor={floor}
              // what the section reads, no more: the plan's lines go as the view's, filtered
              data={{ todayISO: tr.todayISO, trend: tr.trend, leads: tr.leads, horizonDays: tr.horizonDays, coverage: tr.coverage, wip: tr.wip, manpower: tr.manpower, load: tr.load, week: { planNo: tr.week.planNo, newest: tr.week.newest } }} />
          ) : <LoadFailed what="The transformers' cockpit" />}
        </LineSection>
      )}

      {showsLv(f) && (
        <LineSection id="lv" page="planning" foldable={f.scope === "all"} title="LV panels" sub={lv ? `${lv.month.monthLabel}'s plan through four stages${lastDay(lv.lastDayISO)}` : undefined}>
          {lv && lvv ? (
            <LvPlanning view={lvv} f={f} floor={floor}
              data={{ todayISO: lv.todayISO, month: lv.month, open: lv.open, wip: lv.wip, manpower: lv.manpower, days: lv.days, family: lv.family }} />
          ) : <LoadFailed what="The panels' month" />}
        </LineSection>
      )}
    </div>
  );
}
