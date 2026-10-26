import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getFloorPeriod } from "@/lib/server/kpis";
import { getLvFloorPeriod } from "@/lib/server/lvKpis";
import { loadProductionAll } from "@/lib/server/dashboards";
import { getActiveLine } from "@/lib/server/line";
import { floorDefault, floorRequest } from "@/lib/domain/floorKpis";
import { lvFloorDeptOf } from "@/lib/domain/lvKpis";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDate } from "@/lib/domain/format";
import { DASH_SCOPE_NAME, resolveDashScope } from "@/lib/domain/dashboardScope";
import type { CockpitAction } from "@/lib/domain/kpis";
import { FloorPerformance } from "@/components/FloorPerformance";
import { LvFloorPerformance } from "@/components/LvFloorPerformance";
import { PlantProduction } from "@/components/PlantProduction";
import { ProductionExtras } from "@/components/ProductionExtras";
import { LossWaterfallCard } from "@/components/LossWaterfallCard";
import { CockpitDecisions } from "@/components/CockpitDecisions";
import { LineScopeTabs } from "@/components/LineScopeTabs";
import { ErrorState } from "@/components/DataTable";
import { PageHead } from "@/components/ui";
import { PrintHeader } from "@/components/PrintHeader";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Production dashboard — ATC" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const failed = (
  <section className="bg-surface border rounded-xl" aria-label="Floor performance">
    <ErrorState title="The floor's figures could not load" detail="Reload the page to try again." />
  </section>
);
/** A loader's failure is logged and shown as the error state, never a crash of the page. */
const tryLoad = <T,>(what: string, p: Promise<T>) => p.catch((e: unknown) => { console.error(`production: ${what} could not load`, e); return null; });

// The Production dashboard, in the Dashboards tab: what did we make, at what
// efficiency, where did we lose time, what needs intervention — over the
// period and the department picked (?from=&to=&dept=), for one line or the
// whole plant (?line=all|TR|LV; with none named, the line the person's
// screens open on). The shift log's figures: seen with the Shifts screen (the
// "shifts" tab id). The transformers' side carries the machines and the
// tanks' quality; the panels' side its own four departments; the plant's the
// two lines' sums where they add, side by side where they do not.
export default async function ProductionDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  await guardTab("/dashboards/production");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  // with no line named, the one the person's screens open on (the proxy's header)
  const scope = resolveDashScope(sp.line, await getActiveLine());
  const todayISO = factoryDayISO(new Date());
  const req = floorRequest(sp, todayISO);
  const lvDept = lvFloorDeptOf(sp.dept);
  const defaultRange = floorDefault(todayISO);
  const shell = (o: { printTitle: string; sub: string; actions: readonly CockpitAction[]; children: ReactNode }) => (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboards:production" />
      <PrintHeader title={o.printTitle} subtitle="How the floor worked" date={formatDate(todayISO)} />
      <PageHead title="Production" sub={o.sub} actions={<CockpitDecisions actions={o.actions} kind="intervention" />}>
        <LineScopeTabs scope={scope} />
      </PageHead>
      {o.children}
    </div>
  );

  if (scope === "LV") {
    const period = await tryLoad("the panels' period", getLvFloorPeriod({ ...req, dept: lvDept }));
    return shell({
      printTitle: "Production — LV Panels",
      sub: `Dashboard · ${DASH_SCOPE_NAME.LV} · how the panels' floor worked, in the panels' standard hours`,
      actions: period?.actions ?? [],
      children: period === null ? failed : <LvFloorPerformance period={period} todayISO={todayISO} defaultRange={defaultRange} />,
    });
  }

  if (scope === "all") {
    const all = await tryLoad("the plant's period", loadProductionAll(req, lvDept));
    return shell({
      printTitle: "Production — whole plant",
      sub: `Dashboard · ${DASH_SCOPE_NAME.all} · the two lines' sums where they add, side by side where they do not`,
      actions: all?.actions ?? [],
      // the browser gets what the plant's page shows, not the whole of both lines
      children: all === null ? failed : (
        <PlantProduction
          tr={{ fromISO: all.tr.fromISO, toISO: all.tr.toISO, clamped: all.tr.clamped, dates: all.tr.dates, summary: all.tr.summary, groups: all.tr.groups, output: all.tr.output, losses: all.tr.losses, pricedShare: all.tr.pricedShare }}
          lv={{ clamped: all.lv.clamped, dates: all.lv.dates, summary: all.lv.summary, groups: all.lv.groups, output: all.lv.output, moved: all.lv.moved, pricedShare: all.lv.pricedShare }}
          todayISO={todayISO} defaultRange={defaultRange} actions={all.actions}
        />
      ),
    });
  }

  const period = await tryLoad("the floor's period", getFloorPeriod(req));
  return shell({
    printTitle: "Production — Transformers",
    sub: `Dashboard · ${DASH_SCOPE_NAME.TR} · how the floor worked, in standard hours`,
    actions: period?.actions ?? [],
    children: (
      <>
        {period === null ? failed : (
          <>
            <FloorPerformance period={period} todayISO={todayISO} defaultRange={defaultRange} />
            <ProductionExtras period={period} />
          </>
        )}
        <LossWaterfallCard />
      </>
    ),
  });
}
