import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { PageHead } from "@/components/ui";
import { getMaterialDashboard } from "@/lib/server/fabAnalytics";
import { getActiveLine } from "@/lib/server/line";
import { loadOrNull } from "@/lib/server/dashboards";
import { materialRequest } from "@/lib/domain/materialDashboard";
import { factoryDayISO } from "@/lib/domain/dates";
import { LINE_LABEL } from "@/lib/domain/lines";
import { FabAnalyticsView, MaterialDashboardBar } from "@/components/FabAnalyticsView";
import { LoadFailed } from "@/components/DataTable";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Material dashboard — ATC" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The material dashboard, in the Dashboards tab: what the BOM needs, what the
// nesting took, what the ODOO closings consumed by calculation (closed qty ×
// the sheet's rate — not a store issue, not the sheets cut) and how much of it
// the data covers — for the line on screen (?line=), over a consumption period
// (?from=&to=, ?all=1), in one of two views (?view=consumption|nesting) and
// narrowed by material, thickness, size, part, MO and SOI. Seen with the
// Material dashboard screen (its tab id "analytics"); read-only. The machines'
// sheets are on the Floor, the store's balance in Material → Physical.
export default async function MaterialDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  await guardTab("/dashboards/material");
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const todayISO = factoryDayISO(new Date());
  const req = materialRequest(sp, todayISO);
  const line = await getActiveLine();
  const a = await loadOrNull("material", "the material dashboard", getMaterialDashboard(req, line));

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboards:material" />
      <PageHead title="Material" sub={`Dashboard · ${LINE_LABEL[line]}: BOM need, nesting, calculated consumption of ODOO closings, and data coverage`} />
      <MaterialDashboardBar req={req} line={line} todayISO={todayISO} marks={a?.days.map((d) => d.dateISO) ?? []} a={a} />
      {a ? <FabAnalyticsView a={a} req={req} line={line} todayISO={todayISO} /> : <LoadFailed what="The material dashboard" />}
    </div>
  );
}
