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

export const WeekTrendChart = dynamic(() => import("./DashboardCharts").then((m) => m.WeekTrendChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const BacklogChart = dynamic(() => import("./DashboardCharts").then((m) => m.BacklogChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const PromisesChart = dynamic(() => import("./DashboardCharts").then((m) => m.PromisesChart), { ssr: false, loading: () => <Placeholder h={220} /> });
export const PipelineFunnel = dynamic(() => import("./DashboardCharts").then((m) => m.PipelineFunnel), { ssr: false, loading: () => <Placeholder h={210} /> });
export const LoadRings = dynamic(() => import("./DashboardCharts").then((m) => m.LoadRings), { ssr: false, loading: () => <Placeholder h={150} /> });
export const HistoryChart = dynamic(() => import("./DashboardCharts").then((m) => m.HistoryChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const OutputByComponentChart = dynamic(() => import("./ReportCharts").then((m) => m.OutputByComponentChart), { ssr: false, loading: () => <Placeholder h={300} /> });
export const PlannedVsWeldedChart = dynamic(() => import("./ReportCharts").then((m) => m.PlannedVsWeldedChart), { ssr: false, loading: () => <Placeholder h={300} /> });
export const SheetsPerDayChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.SheetsPerDayChart), { ssr: false, loading: () => <Placeholder h={260} /> });
export const ThicknessChart = dynamic(() => import("./FabAnalyticsCharts").then((m) => m.ThicknessChart), { ssr: false, loading: () => <Placeholder h={220} /> });
export const OdooDashboard = dynamic(() => import("./OdooDashboard").then((m) => m.OdooDashboard), { ssr: false, loading: () => <Placeholder h={520} /> });
export const ConsumablesDashboard = dynamic(() => import("./ConsumablesDashboard").then((m) => m.ConsumablesDashboard), { ssr: false, loading: () => <Placeholder h={520} /> });
