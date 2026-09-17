import Link from "next/link";
import { getTargetDashboard } from "@/lib/server/dashboard";
import { getControlDashboard } from "@/lib/server/controlDashboard";
import { getSmartInsights } from "@/lib/server/insights";
import { getActiveLine } from "@/lib/server/line";
import { getLvDashboard } from "@/lib/server/lvDashboard";
import { LvDashboard } from "@/components/LvDashboard";
import { ControlDashboard } from "@/components/ControlDashboard";
import { SmartInsights } from "@/components/SmartInsights";
import { PeriodFilter, DashboardPeriodMemory } from "@/components/controls";
import { ViewTabs, DASHBOARD_VIEWS } from "@/components/ViewTabs";
import { parseISODate, toDisplayDate } from "@/lib/domain/dates";

export const dynamic = "force-dynamic";

// The Dashboard is the production-control screen (components/ControlDashboard):
// this page fetches, and hands it the week / period controls that scope the
// two throughput charts.

export default async function Home({ searchParams }: { searchParams: Promise<{ w?: string; from?: string; to?: string }> }) {
  // the panels have their own dashboard — one thing through four stages,
  // not six components against a target
  const sp = await searchParams;
  if ((await getActiveLine()) === "LV") {
    return <LvDashboard d={await getLvDashboard({ from: sp.from ? parseISODate(sp.from) : null, to: sp.to ? parseISODate(sp.to) : null })} />;
  }

  const [c, d, ai] = await Promise.all([
    getControlDashboard(),
    getTargetDashboard({ weekOf: sp.w ? parseISODate(sp.w) : null, from: sp.from ? parseISODate(sp.from) : null, to: sp.to ? parseISODate(sp.to) : null }),
    getSmartInsights(),
  ]);
  const periodTitle = `${d.mode === "week" ? "Week" : "Period"} ${toDisplayDate(parseISODate(d.fromISO)!)} → ${toDisplayDate(parseISODate(d.toISO)!)}`;

  const controls = (
    <div className="no-print flex flex-wrap items-center justify-between gap-3 bg-surface border rounded-xl px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ViewTabs views={DASHBOARD_VIEWS} current="/" label="Dashboard view" />
        {d.mode === "week" && <Link href={`/?w=${d.prevWeekISO}`} className="btn btn-secondary btn-sm whitespace-nowrap">← Prev</Link>}
        <span className="font-extrabold tabnum text-sm">
          {periodTitle}
          {d.isCurrentWeek && <span className="pill pill-ok ml-2">current</span>}
          {d.mode === "range" && <span className="pill pill-warn ml-2">{d.workingDays} working day{d.workingDays === 1 ? "" : "s"}</span>}
          {d.clamped && <span className="pill pill-warn ml-2">cut to 31 days</span>}
        </span>
        {d.nextWeekISO && <Link href={`/?w=${d.nextWeekISO}`} className="btn btn-secondary btn-sm whitespace-nowrap">Next →</Link>}
        {d.mode === "week" && !d.isCurrentWeek && <Link href="/" className="text-sm font-bold text-accent hover:underline whitespace-nowrap">Jump to current ↻</Link>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SmartInsights data={ai} />
        <PeriodFilter from={d.fromISO} to={d.toISO} active={d.mode === "range"} />
      </div>
    </div>
  );

  return (
    <>
      <DashboardPeriodMemory />
      <ControlDashboard c={c} d={d} controls={controls} />
    </>
  );
}
