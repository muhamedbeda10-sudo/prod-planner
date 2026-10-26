import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getOdooDashboard } from "@/lib/server/odoo";
import { resolveBasis, resolveBom, resolveCompare, resolvePeriod, resolveProduct } from "@/lib/domain/odooStats";
import { factoryDayISO, factoryToday } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { OdooBasisPicker, OdooBomPicker, OdooComparePicker } from "@/components/OdooPickers";
import { OdooDashboard } from "@/components/LazyCharts";
import { DashboardSections } from "@/components/DashboardSections";
import { PageHead } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";

export const metadata = { title: "ODOO dashboard — ATC" };
export const dynamic = "force-dynamic";

// Odoo's dashboard, in the Dashboards tab: closed quantities per product and
// the close-out time, both lines. Seen with the ODOO screen (its tab id); the
// close-out log stays on the ODOO tab.
export default async function OdooDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; basis?: string; bom?: string; compare?: string; product?: string }>;
}) {
  await guardTab("/dashboards/odoo");
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  // the factory's day (Cairo), as the slicer and the closed-day buckets read it
  const period = resolvePeriod(sp, factoryToday());
  const basis = resolveBasis(sp);
  const data = await getOdooDashboard(period, basis, resolveBom(sp), resolveCompare(sp), resolveProduct(sp));
  const today = factoryDayISO(new Date());
  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboards:odoo" />
      <DashboardSections current="odoo" />
      <PageHead title="ODOO" sub="Dashboard · both lines">
        <OdooBasisPicker basis={basis} />
        <OdooBomPicker bom={data.bom} boms={data.boms} />
        <OdooComparePicker compare={data.compare} />
      </PageHead>
      <UrlDateSlicer
        encoding="odooDash" from={period.fromISO} to={period.fromISO ? period.toISO : null} min={addDaysISO(today, -120)} max={today} today={today}
        presets={["today", "yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]} allLabel="All time"
      />
      <OdooDashboard data={data} />
    </div>
  );
}
