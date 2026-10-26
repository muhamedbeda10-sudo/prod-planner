import { after } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { getCockpit, recordKpiSnapshot, withoutFloor } from "@/lib/server/kpis";
import { getLvPlanning, lvWithoutFloor } from "@/lib/server/lvKpis";
import { assemblePlanning } from "@/lib/server/dashboards";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { Cockpit } from "@/components/Cockpit";
import { CockpitDecisions, PrintDecisions } from "@/components/CockpitDecisions";
import { LineSection } from "@/components/LineSection";
import { LvPlanning } from "@/components/LvPlanning";
import { PlantPlanning } from "@/components/PlantPlanning";
import { ErrorState } from "@/components/DataTable";
import { formatDate } from "@/lib/domain/format";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { productionRedirectOf } from "@/lib/domain/dashboardLinks";
import { mergeActions } from "@/lib/domain/plantKpis";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const dayOf = (v: string | string[] | undefined) => (typeof v === "string" ? parseISODate(v) : null);

const failed = (what: string) => (
  <div className="bg-surface border rounded-xl">
    <ErrorState title={`${what} could not load`} detail="Reload the page to try again." />
  </div>
);
/** A loader's failure is logged and shown as the error state, never a crash of the page. */
const tryLoad = <T,>(what: string, p: Promise<T>) => p.catch((e: unknown) => { console.error(`planning: ${what} could not load`, e); return null; });

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
    tryLoad("the transformers' cockpit", getCockpit()),
    // the panels' stage table reads a period of its own
    tryLoad("the panels' month", getLvPlanning({ from: dayOf(sp.from), to: dayOf(sp.to) })),
  ]);
  // today's point of the trend, kept once the page is on its way
  if (trRaw) after(() => recordKpiSnapshot(trRaw));
  const plant = trRaw && lvRaw ? assemblePlanning(trRaw, lvRaw, floor) : null;
  // the shift log's figures stay with the accounts that see Shifts
  const tr = plant?.tr ?? (trRaw && (floor ? trRaw : withoutFloor(trRaw)));
  const lv = plant?.lv ?? (lvRaw && (floor ? lvRaw : lvWithoutFloor(lvRaw)));
  const actions = plant?.actions ?? mergeActions(tr?.actions ?? [], lv?.actions ?? []);
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

      {plant ? (
        <PlantPlanning
          // the browser gets what the plant's figures show; each section gets its own line's
          tr={{ todayISO: plant.tr.todayISO, week: plant.tr.week, manpower: plant.tr.manpower }}
          lv={{ month: plant.lv.month, open: plant.lv.open, urgentStuck: plant.lv.urgentStuck, manpower: plant.lv.manpower }}
          floor={floor} actions={plant.actions} summary={plant.summary}
        />
      ) : failed("The plant's figures")}

      <LineSection id="tr" page="planning" title="Transformers" sub={tr ? `${tr.week.planNo ? `weekly plan ${tr.week.planNo}` : "no weekly plan yet"}${lastDay(tr.lastDayISO)} · in standard hours` : undefined}>
        {tr ? <Cockpit data={tr} floor={floor} /> : failed("The transformers' cockpit")}
      </LineSection>

      <LineSection id="lv" page="planning" title="LV panels" sub={lv ? `${lv.month.monthLabel}'s plan through four stages${lastDay(lv.lastDayISO)}` : undefined}>
        {lv ? <LvPlanning data={lv} floor={floor} /> : failed("The panels' month")}
      </LineSection>
    </div>
  );
}
