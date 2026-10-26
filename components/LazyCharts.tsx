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
export const SheetsPerDayChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.SheetsPerDayChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const ThicknessChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.ThicknessChart), { ssr: false, loading: () => <Placeholder h={220} /> });
export const OdooDashboard = dynamic(() => import("./OdooDashboard").then((m) => m.OdooDashboard), { ssr: false, loading: () => <Placeholder h={520} /> });
export const ConsumablesTrend = dynamic(() => import("./ConsumablesDashboard").then((m) => m.ConsumablesTrend), { ssr: false, loading: () => <Placeholder h={380} /> });
export const ConsumablesBreakdown = dynamic(() => import("./ConsumablesDashboard").then((m) => m.ConsumablesBreakdown), { ssr: false, loading: () => <Placeholder h={420} /> });
