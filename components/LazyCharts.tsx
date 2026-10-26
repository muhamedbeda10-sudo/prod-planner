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

export const StageByDayChart = dynamic(() => import("./CockpitCharts").then((m) => m.StageByDayChart), { ssr: false, loading: () => <Placeholder h={330} /> });
export const LvMonthChart = dynamic(() => import("./CockpitCharts").then((m) => m.LvMonthChart), { ssr: false, loading: () => <Placeholder h={310} /> });
export const OutputChart = dynamic(() => import("./CockpitCharts").then((m) => m.OutputChart), { ssr: false, loading: () => <Placeholder h={290} /> });
export const ProductivityTrendChart = dynamic(() => import("./CockpitCharts").then((m) => m.ProductivityTrendChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const ConsumedPerDayChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.ConsumedPerDayChart), { ssr: false, loading: () => <Placeholder h={330} /> });
export const PartCompareChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.PartCompareChart), { ssr: false, loading: () => <Placeholder h={330} /> });
export const BreakdownChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.BreakdownChart), { ssr: false, loading: () => <Placeholder h={300} /> });
export const OverrunChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.OverrunChart), { ssr: false, loading: () => <Placeholder h={300} /> });
export const VolumeChart = dynamic(() => import("./ProductionCharts").then((m) => m.VolumeChart), { ssr: false, loading: () => <Placeholder h={290} /> });
export const OdooDashboard = dynamic(() => import("./OdooDashboard").then((m) => m.OdooDashboard), { ssr: false, loading: () => <Placeholder h={520} /> });
export const ConsumablesTrend = dynamic(() => import("./ConsumablesDashboard").then((m) => m.ConsumablesTrend), { ssr: false, loading: () => <Placeholder h={380} /> });
export const ConsumablesBreakdown = dynamic(() => import("./ConsumablesDashboard").then((m) => m.ConsumablesBreakdown), { ssr: false, loading: () => <Placeholder h={420} /> });
