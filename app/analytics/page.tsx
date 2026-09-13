import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/server/auth";
import { PageHeader } from "@/components/ui";
import { getFabAnalytics, resolveWindow, WINDOWS } from "@/lib/server/fabAnalytics";
import { FabAnalyticsView } from "@/components/FabAnalyticsView";
import { ViewTabs, DASHBOARD_VIEWS } from "@/components/ViewTabs";

export const metadata = { title: "Analytics — ATC" };
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

  const sp = await searchParams;
  const days = resolveWindow(sp.days);
  const a = await getFabAnalytics(days);

  return (
    <div>
      <PageHeader title="📊 Fabrication analytics">
        <ViewTabs views={DASHBOARD_VIEWS} current="/analytics" label="Dashboard view" />
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
