import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getFloorPeriod } from "@/lib/server/kpis";
import { getLvFloorPeriod } from "@/lib/server/lvKpis";
import { loadOrNull } from "@/lib/server/dashboards";
import { FLOOR_HISTORY_DAYS, floorDefault, floorRequest } from "@/lib/domain/floorKpis";
import { productionLegacyRedirect } from "@/lib/domain/dashboardLinks";
import { lvFloorDeptOf } from "@/lib/domain/lvKpis";
import { factoryDayISO } from "@/lib/domain/dates";
import { addDaysISO, slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { formatDate } from "@/lib/domain/format";
import { mergeActions } from "@/lib/domain/plantKpis";
import { FloorPerformance } from "@/components/FloorPerformance";
import { LvFloorPerformance } from "@/components/LvFloorPerformance";
import { PlantProduction } from "@/components/PlantProduction";
import { ProductionExtras } from "@/components/ProductionExtras";
import { LossWaterfallCard } from "@/components/LossWaterfallCard";
import { CockpitDecisions, PrintDecisions } from "@/components/CockpitDecisions";
import { LineSection } from "@/components/LineSection";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { LoadFailed } from "@/components/DataTable";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Production dashboard — ATC" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The Production dashboard, in the Dashboards tab: what did we make, at what
// efficiency, where did we lose time, what needs intervention — both lines
// on one page, over one period (?from=&to=, the date bar at the top). The
// plant's figures first (the two lines' sums where they add, what was made
// item by item against the month's plan, both lines' interventions), then
// each line's section with its own department (?dept= the transformers',
// ?lvDept= the panels'). The shift log's figures: seen with the Shifts
// screen (the "shifts" tab id).
export default async function ProductionDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  await guardTab("/dashboards/production");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  // an older link that named the panels' department in `dept` keeps its view
  const legacy = productionLegacyRedirect(sp);
  if (legacy) redirect(legacy);
  const todayISO = factoryDayISO(new Date());
  const req = floorRequest(sp, todayISO);
  // each line on its own: one that fails to load leaves the other on screen
  const [tr, lv] = await Promise.all([
    loadOrNull("production", "the transformers' period", getFloorPeriod(req)),
    loadOrNull("production", "the panels' period", getLvFloorPeriod({ ...req, dept: lvFloorDeptOf(sp.lvDept) })),
  ]);
  const actions = mergeActions(tr?.actions ?? [], lv?.actions ?? []);
  const range = slicerRangeLabel(req.fromISO, req.toISO);
  const marks = [...new Set([...(tr?.dates ?? []), ...(lv?.dates ?? [])])].sort();

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboards:production" />
      <PrintHeader title="Production — whole plant" subtitle={`How the floor worked · ${range}`} date={formatDate(todayISO)} />
      <PageHead title="Production" sub={`Both lines over ${range}: the plant's figures, then the transformers and the LV panels`} />
      {/* the page's one bar: the period, then its buttons */}
      <UrlDateSlicer
        encoding="fromTo" from={req.fromISO} to={req.toISO} min={addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1))} max={todayISO} today={todayISO} marks={marks} label="Period"
        presets={["yesterday", "thisWeek", "last14", "thisMonth", "lastMonth", "last30", "last90"]} defaultRange={floorDefault(todayISO)}
        end={<><CockpitDecisions actions={actions} kind="intervention" /><PrintButton /></>}
      />
      <PrintDecisions actions={actions} kind="intervention" />

      {tr && lv ? (
        <PlantProduction
          // the browser gets what the plant's figures show; each section gets its own line's
          tr={{ fromISO: tr.fromISO, toISO: tr.toISO, summary: tr.summary, output: tr.output, losses: tr.losses, pricedShare: tr.pricedShare, byType: tr.byType }}
          lv={{ summary: lv.summary, output: lv.output, pricedShare: lv.pricedShare, byType: lv.byType }}
          actions={actions}
        />
      ) : <LoadFailed what="The plant's figures" />}

      <LineSection id="tr" page="production" title="Transformers" sub="floor performance, the machines, quality and rework — in standard hours">
        {tr === null ? <LoadFailed what="The transformers' figures" /> : (
          <>
            <FloorPerformance period={tr} />
            <ProductionExtras period={tr} />
          </>
        )}
        <LossWaterfallCard />
      </LineSection>

      <LineSection id="lv" page="production" title="LV panels" sub="floor performance in the panels' standard hours">
        {lv === null ? <LoadFailed what="The panels' figures" /> : <LvFloorPerformance period={lv} />}
      </LineSection>
    </div>
  );
}
