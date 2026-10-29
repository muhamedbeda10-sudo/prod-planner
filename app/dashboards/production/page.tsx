import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { loadProductionDashboard } from "@/lib/server/productionDashboard";
import { FLOOR_HISTORY_DAYS, floorDefault } from "@/lib/domain/floorKpis";
import { productionRequest } from "@/lib/domain/productionDashboard";
import { factoryDayISO } from "@/lib/domain/dates";
import { addDaysISO, slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { formatDateTime } from "@/lib/domain/format";
import { DataCoveragePopup, ProductionDashboard, WorthALookPopup } from "@/components/ProductionDashboard";
import { ProductionFilters } from "@/components/ProductionFilters";
import { CockpitDecisions, PrintDecisions } from "@/components/CockpitDecisions";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { LoadFailed } from "@/components/DataTable";
import { PageHead } from "@/components/ui";
import { PrintHeader } from "@/components/PrintHeader";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Production dashboard — ATC" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The Production dashboard, in the Dashboards tab: what did we make, at what
// efficiency, and where is the gap between the effort and the output — for
// the transformers, the LV panels or the whole plant (?scope=), over one
// period (?from=&to=), a department (?dept=) and on Fabrication a work
// centre (?centre=); the attendance card's shift (?shift=) and the output
// card's stage (?stage=) are theirs alone. One loader computes every figure
// on the server (lib/server/productionDashboard.ts) for the page and the
// assistant. Behind the Shifts screen's access (the "shifts" tab id).
export default async function ProductionDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  await guardTab("/dashboards/production");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  const now = new Date();
  const todayISO = factoryDayISO(now);
  const req = productionRequest(sp, todayISO);
  const data = await loadProductionDashboard(req, now).catch((e: unknown) => { console.error("production: the dashboard could not load", e); return null; });
  const range = slicerRangeLabel(req.fromISO, req.toISO);
  const beforeRange = data?.before ? slicerRangeLabel(data.before.fromISO, data.before.toISO) : null;
  const actions = data?.actions ?? [];
  const marks = data ? [...new Set(data.view.days.filter((d) => d.workedH > 0).map((d) => d.dateISO))].sort() : [];
  const allFailed = !data || data.failed.length === (req.scope === "all" ? 2 : 1);

  return (
    <div className="space-y-4">
      <RememberLastVisit storageKey="dashboards:production" />
      <PrintHeader title="Production" />
      <PageHead title="Production" sub={`What we made, at what efficiency, over ${range}`} />
      {/* the page's one bar: the line, the department and centre, the period, then its popups — the data's coverage, what is worth a look, the interventions */}
      <UrlDateSlicer
        encoding="fromTo" from={req.fromISO} to={req.toISO} min={addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1))} max={todayISO} today={todayISO} marks={marks} label="Period"
        presets={["yesterday", "thisWeek", "last14", "thisMonth", "lastMonth", "last30", "last90"]} defaultRange={floorDefault(todayISO)}
        start={<ProductionFilters scope={req.scope} dept={req.scope === "LV" ? (req.lvDept === "all" ? "" : req.lvDept) : req.trDept === "all" ? "" : req.trDept} centre={req.centre ?? ""} />}
        end={
          <>
            {data && !allFailed && <DataCoveragePopup view={data.view} req={req} asOf={formatDateTime(now)} failed={data.failed} beforeRange={beforeRange} />}
            {data && !allFailed && <WorthALookPopup view={data.view} scope={req.scope} />}
            <CockpitDecisions actions={actions} kind="intervention" />
          </>
        }
      />
      <PrintDecisions actions={actions} kind="intervention" />

      {!data || allFailed ? <LoadFailed what="The production figures" /> : (
        <ProductionDashboard
            view={data.view} req={req} range={range} beforeRange={beforeRange}
            // the browser gets what the cards show
            more={{
              trByType: data.tr?.byType ?? null,
              lvByType: data.lv?.byType ?? null,
              trExtras: data.tr ? { stops: data.tr.stops, quality: data.tr.quality } : null,
              stops: data.tr && req.scope !== "LV" ? data.tr.losses : null,
            }}
          />
      )}
    </div>
  );
}
