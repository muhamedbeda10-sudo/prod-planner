"use client";

import dynamic from "next/dynamic";

// Recharts is the heaviest thing the browser downloads for this app, and it
// is only needed where a chart is drawn. Each chart module is split into its
// own chunk here and fetched when that page renders, with a quiet placeholder
// of the chart's height in the meantime — the numbers around it paint first.
// (Server pages cannot code-split a client component themselves, so the
// splitting has to happen in a client module like this one.)

function Placeholder({ h }: { h: number }) {
  return <div className="rounded-xl bg-surface-2/60 animate-pulse" style={{ height: h }} aria-hidden />;
}

export const BurnUpChart = dynamic(() => import("./CockpitCharts").then((m) => m.BurnUpChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const LoadChart = dynamic(() => import("./CockpitCharts").then((m) => m.LoadChart), { ssr: false, loading: () => <Placeholder h={270} /> });
export const OutputChart = dynamic(() => import("./CockpitCharts").then((m) => m.OutputChart), { ssr: false, loading: () => <Placeholder h={290} /> });
export const ProductivityTrendChart = dynamic(() => import("./CockpitCharts").then((m) => m.ProductivityTrendChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const ConsumedPerDayChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.ConsumedPerDayChart), { ssr: false, loading: () => <Placeholder h={330} /> });
export const PartCompareChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.PartCompareChart), { ssr: false, loading: () => <Placeholder h={330} /> });
export const BreakdownChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.BreakdownChart), { ssr: false, loading: () => <Placeholder h={300} /> });
export const OverrunChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.OverrunChart), { ssr: false, loading: () => <Placeholder h={300} /> });
export const OdooDashboard = dynamic(() => import("./OdooDashboard").then((m) => m.OdooDashboard), { ssr: false, loading: () => <Placeholder h={520} /> });
export const ConsumablesDashboard = dynamic(() => import("./ConsumablesDashboard").then((m) => m.ConsumablesDashboard), { ssr: false, loading: () => <Placeholder h={520} /> });
