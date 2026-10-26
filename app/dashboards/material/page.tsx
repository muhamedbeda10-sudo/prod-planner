import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { PageHead } from "@/components/ui";
import { DashboardSections } from "@/components/DashboardSections";
import { getMaterialDashboard, resolveWindow, WINDOWS } from "@/lib/server/fabAnalytics";
import { getActiveLine } from "@/lib/server/line";
import { FabAnalyticsView } from "@/components/FabAnalyticsView";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Material dashboard — ATC" };
export const dynamic = "force-dynamic";

const label = (d: number) => (d === 0 ? "All" : `${d}d`);

// The material dashboard, in the Dashboards tab: the fabrication read through
// the nesting sheets in sheets, tonnes and thicknesses. Seen with the Material
// dashboard screen (its tab id); the nesting sheets stay in Material.
export default async function MaterialDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await guardTab("/dashboards/material");
  // viewing is free for every account, like the rest of the app
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  // the sheet analytics read the fabrication ledger by component and the
  // nesting sheet by part — the transformers'. The panels' fabrication is
  // punching, with no nesting sheet yet, so their side says so.
  if ((await getActiveLine()) === "LV") {
    return (
      <div>
        <RememberLastVisit storageKey="dashboards:material" />
        <DashboardSections current="material" />
        <PageHead title="Material" sub="Dashboard · LV Panels" />
        <p className="text-sm text-muted bg-surface border rounded-xl px-4 py-3">
          The sheet analytics are built on the nesting tracker and the cutting log, which the panels do not have yet — a panel is punched,
          not nested. When the panels get a nesting sheet, their sheets, tonnes and thicknesses read here the same way.
        </p>
      </div>
    );
  }

  const sp = await searchParams;
  const days = resolveWindow(sp.days);
  const a = await getMaterialDashboard(days);

  return (
    <div>
      <RememberLastVisit storageKey="dashboards:material" />
      <DashboardSections current="material" />
      <PageHead title="Material" sub="Dashboard · Transformers · consumption booked when the MO is closed on Odoo">
        <nav className="seg" aria-label="Window">
          {WINDOWS.map((d) => (
            <Link key={d} href={`/dashboards/material?days=${d}`} className={d === days ? "on" : ""}>
              {label(d)}
            </Link>
          ))}
        </nav>
      </PageHead>
      <FabAnalyticsView a={a} />
    </div>
  );
}
