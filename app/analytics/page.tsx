import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";
import { PageHeader } from "@/components/ui";
import { getMaterialDashboard, resolveWindow, WINDOWS } from "@/lib/server/fabAnalytics";
import { getActiveLine } from "@/lib/server/line";
import { FabAnalyticsView } from "@/components/FabAnalyticsView";
import { ViewTabs, MATERIAL_VIEWS } from "@/components/ViewTabs";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Material dashboard — ATC" };
export const dynamic = "force-dynamic";

const label = (d: number) => (d === 0 ? "All" : `${d}d`);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  // viewing is free for every account, like the rest of the app
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  // the sheet analytics read the fabrication ledger by component and the
  // nesting sheet by part — the transformers'. The panels' fabrication is
  // punching, with no nesting sheet yet, so their side says so.
  if ((await getActiveLine()) === "LV") {
    return (
      <div>
        <RememberLastVisit storageKey="analytics:last" />
        <PageHeader title="📊 Fabrication analytics — LV Panels">
          <ViewTabs views={MATERIAL_VIEWS} current="/analytics" label="Material view" />
        </PageHeader>
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
      <RememberLastVisit storageKey="analytics:last" />
      <PageHeader title="📊 Material dashboard">
        <ViewTabs views={MATERIAL_VIEWS} current="/analytics" label="Material view" />
        <nav className="seg" aria-label="Window">
          {WINDOWS.map((d) => (
            <Link key={d} href={`/analytics?days=${d}`} className={d === days ? "on" : ""}>
              {label(d)}
            </Link>
          ))}
        </nav>
      </PageHeader>
      <FabAnalyticsView a={a} />
    </div>
  );
}
