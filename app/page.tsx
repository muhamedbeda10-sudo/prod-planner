import { after } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, recordKpiSnapshot } from "@/lib/server/kpis";
import { getLvPlanning } from "@/lib/server/lvKpis";
import { loadOrNull, lvPlanningFor, planningSummary, trPlanningFor } from "@/lib/server/dashboards";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions, PrintDecisions } from "@/components/CockpitDecisions";
import { LineSection } from "@/components/LineSection";
import { LvPlanning } from "@/components/LvPlanning";
import { PlantPlanning } from "@/components/PlantPlanning";
import { LoadFailed } from "@/components/DataTable";
import { formatDate } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { productionRedirectOf } from "@/lib/domain/dashboardLinks";
import { mergeActions } from "@/lib/domain/plantKpis";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const dayOf = (v: string | string[] | undefined) => (typeof v === "string" ? parseISODate(v) : null);

// The home page is the Planning dashboard, the first place of the Dashboards
// tab: will we make the plan, where is the next shortfall, what does it take?
// Both lines on one page: the plant's figures first (each line's headline,
// both lines' decisions, who is needed where), then the transformers'
// cockpit and the panels' month on the chain, each in a section of its own.
// How the floor worked is the Production dashboard (/dashboards/production).
export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  // the floor's figures moved to the Production dashboard: an old link to them here lands there
  const moved = productionRedirectOf(sp);
  if (moved) redirect(moved);
  await guardTab("/");
  const me = await getCurrentUser();
  const floor = !hiddenTabsOf(me).has("shifts");
  const todayISO = factoryDayISO(new Date());
  // each line on its own: one that fails to load leaves the other on screen
  const [trRaw, lvRaw] = await Promise.all([
    loadOrNull("planning", "the transformers' cockpit", getCockpit()),
    // the panels' stage table reads a period of its own
    loadOrNull("planning", "the panels' month", getLvPlanning({ from: dayOf(sp.from), to: dayOf(sp.to) })),
  ]);
  // today's point of the trend, kept once the page is on its way
  if (trRaw) after(() => recordKpiSnapshot(trRaw));
  // the shift log's figures stay with the accounts that see Shifts
  const tr = trRaw && trPlanningFor(trRaw, floor);
  const lv = lvRaw && lvPlanningFor(lvRaw, floor);
  const actions = mergeActions(tr?.actions ?? [], lv?.actions ?? []);
  const lastDay = (iso: string | null | undefined) => (floor && iso ? ` · last recorded day ${formatDate(iso)}` : "");

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboard:last" />
      <PrintHeader
        title="Planning — whole plant"
        subtitle={[tr?.week.planNo ? `Weekly plan ${tr.week.planNo}` : null, lv?.month.monthLabel].filter(Boolean).join(" · ") || undefined}
        date={formatDate(todayISO)}
      />
      <PageHead title="Planning" sub={`Both lines, today ${formatDate(todayISO)}: the plant's figures, then the transformers and the LV panels`}
        actions={<><CockpitDecisions actions={actions} /><PrintButton /></>} />
      <PrintDecisions actions={actions} />

      {tr && lv ? (
        <PlantPlanning
          // the browser gets what the plant's figures show; each section gets its own line's
          tr={{ todayISO: tr.todayISO, week: tr.week, manpower: tr.manpower }}
          lv={{ month: lv.month, open: lv.open, urgentStuck: lv.urgentStuck, manpower: lv.manpower }}
          floor={floor} actions={actions} summary={planningSummary(tr, lv)}
        />
      ) : <LoadFailed what="The plant's figures" />}

      <LineSection id="tr" page="planning" title="Transformers" sub={tr ? `${tr.week.planNo ? `weekly plan ${tr.week.planNo}` : "no weekly plan yet"}${lastDay(tr.lastDayISO)} · in standard hours` : undefined}>
        {tr ? <Cockpit data={tr} floor={floor} /> : <LoadFailed what="The transformers' cockpit" />}
      </LineSection>

      <LineSection id="lv" page="planning" title="LV panels" sub={lv ? `${lv.month.monthLabel}'s plan through four stages${lastDay(lv.lastDayISO)}` : undefined}>
        {lv ? <LvPlanning data={lv} floor={floor} /> : <LoadFailed what="The panels' month" />}
      </LineSection>
    </div>
  );
}
