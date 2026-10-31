import { redirect } from "next/navigation";
import { productionRedirectOf } from "@/lib/domain/dashboardLinks";

export const dynamic = "force-dynamic";

// The Production dashboard is now part of the one dashboard on the home page
// (app/page.tsx): an old link or bookmark lands there with its choices.
export default async function ProductionDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(productionRedirectOf(await searchParams));
}
