import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getFloorPeriod } from "@/lib/server/kpis";
import { floorDefault, floorRequest } from "@/lib/domain/floorKpis";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDate } from "@/lib/domain/format";
import { DashboardSections } from "@/components/DashboardSections";
import { FloorPerformance } from "@/components/FloorPerformance";
import { LossWaterfallCard } from "@/components/LossWaterfallCard";
import { ErrorState } from "@/components/DataTable";
import { PageHead } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Production dashboard — ATC" };
export const dynamic = "force-dynamic";

// The Production dashboard, in the Dashboards tab: how the floor worked over
// the period and the department picked (?from=&to=&dept=) — efficiency,
// productivity, output and stops (FloorPerformance) — and where the hours
// went (LossWaterfallCard). The shift log's figures: seen with the Shifts
// screen (the "shifts" tab id), and the transformers' only.
export default async function ProductionDashboardPage({ searchParams }: { searchParams: Promise<{ from?: string | string[]; to?: string | string[]; dept?: string | string[] }> }) {
  await guardTab("/dashboards/production");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const todayISO = factoryDayISO(new Date());

  const sp = await searchParams;
  // the floor's figures are the transformers' (PINNED_LINE)
  const req = floorRequest(sp, todayISO);
  const period = await getFloorPeriod(req).catch((e: unknown) => { console.error("production: the floor's period could not load", e); return null; });
  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboards:production" />
      <PrintHeader title="Production" subtitle="How the floor worked" date={formatDate(todayISO)} />
      <DashboardSections current="production" />
      <PageHead title="Production" sub="Dashboard · Transformers · how the floor worked, in standard hours" actions={<PrintButton />} />
      {period === null ? (
        <section className="bg-surface border rounded-xl" aria-label="Floor performance">
          <ErrorState title="The floor's figures could not load" detail="Reload the page to try again." />
        </section>
      ) : (
        <FloorPerformance period={period} todayISO={todayISO} defaultRange={floorDefault(todayISO)} />
      )}
      <LossWaterfallCard />
    </div>
  );
}
