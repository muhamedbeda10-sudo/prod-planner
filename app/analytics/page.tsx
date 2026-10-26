import { redirect } from "next/navigation";

// The material dashboard lives in the Dashboards tab now: an old link lands
// there, its window kept.
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days } = await searchParams;
  redirect(`/dashboards/material${days ? `?days=${encodeURIComponent(days)}` : ""}`);
}
