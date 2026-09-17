import Link from "next/link";
import { getTargetDashboard, type DeptDay } from "@/lib/server/dashboard";
import { getControlDashboard } from "@/lib/server/controlDashboard";
import { getSmartInsights } from "@/lib/server/insights";
import { getActiveLine } from "@/lib/server/line";
import { getLvDashboard } from "@/lib/server/lvDashboard";
import { LvDashboard } from "@/components/LvDashboard";
import { ControlDashboard } from "@/components/ControlDashboard";
import { SmartInsights } from "@/components/SmartInsights";
import { PeriodFilter, DashboardPeriodMemory } from "@/components/controls";
import { ViewTabs, DASHBOARD_VIEWS } from "@/components/ViewTabs";
import { WeekTrendChart, HistoryChart } from "@/components/LazyCharts";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";
import { parseISODate, toDisplayDate } from "@/lib/domain/dates";
import { FINISHING_LABEL } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

// The Dashboard is the production-control screen: the plan's standing, where
// the work sits, the bottleneck, the pace against the month and the orders
// that need a hand — read as of now, above; then the period's throughput
// against the daily target, scoped by the week / period controls, below.

const pct = (v: number, t: number) => (t > 0 ? v / t : 0);
const fmtPct = (v: number, t: number) => `${Math.round(pct(v, t) * 100)}%`;

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
  const paceDays = d.todayInPeriod && d.paceWorkingDays < d.workingDays ? d.paceWorkingDays : undefined;

  return (
    <div className="space-y-6">
      <DashboardPeriodMemory />
      <ControlDashboard c={c} />

      {/* ==== throughput against the target, for the week or a period ==== */}
      <section className="space-y-4">
        <div className="no-print flex flex-wrap items-center justify-between gap-3 bg-surface border rounded-xl px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2 w-full xl:w-auto">
            <ViewTabs views={DASHBOARD_VIEWS} current="/" label="Dashboard view" />
            {d.mode === "week" && <Link href={`/?w=${d.prevWeekISO}`} className="btn btn-secondary btn-sm whitespace-nowrap">← Prev</Link>}
            <span className="font-extrabold tabnum flex-1 text-center text-sm sm:text-base xl:flex-none xl:text-left">
              {periodTitle}
              {d.isCurrentWeek && <span className="pill pill-ok ml-2">current</span>}
              {d.mode === "range" && <span className="pill pill-warn ml-2">{d.workingDays} working day{d.workingDays === 1 ? "" : "s"}</span>}
            </span>
            {d.nextWeekISO && <Link href={`/?w=${d.nextWeekISO}`} className="btn btn-secondary btn-sm whitespace-nowrap">Next →</Link>}
            {d.mode === "week" && !d.isCurrentWeek && <Link href="/" className="text-sm font-bold text-accent hover:underline whitespace-nowrap">Jump to current ↻</Link>}
          </div>
          <div className="flex flex-wrap items-center gap-3 w-full xl:w-auto">
            <SmartInsights data={ai} />
            <PeriodFilter from={d.fromISO} to={d.toISO} active={d.mode === "range"} />
          </div>
        </div>
        {d.clamped && <p className="text-xs bg-warn-bg text-warn-fg rounded-md px-3 py-2 inline-block">The range was longer than 31 days — showing {d.fromISO} → {d.toISO}.</p>}

        <div className="grid md:grid-cols-3 gap-3">
          <DeptTile icon={<LaserCutterIcon size={16} />} name="Fabrication" data={d.period.cut} target={d.targetPerDeptPeriod} perDay={d.targetPerDeptDay} paceDays={paceDays} />
          <DeptTile icon={<WeldingIcon size={16} />} name="Welding" data={d.period.weld} target={d.targetPerDeptPeriod} perDay={d.targetPerDeptDay} paceDays={paceDays} />
          <DeptTile icon={<PowderCoatIcon size={16} />} name={FINISHING_LABEL} data={d.period.paint} target={d.paintTargetPeriod} perDay={d.paintTargetDay} paceDays={paceDays} />
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          <ChartCard title="Daily output vs target" sub={`pieces per department per day · dashed line = ${d.targetPerDeptDay} pcs a department a working day`}>
            <WeekTrendChart days={d.days} targetPerDeptDay={d.targetPerDeptDay} />
          </ChartCard>
          <ChartCard title="Last 6 weeks" sub={`pieces per department per work week · dashed line = ${d.targetPerDeptDay * 6} a week`}>
            <HistoryChart history={d.history} targetPerDeptWeek={d.targetPerDeptDay * 6} />
          </ChartCard>
        </div>
        <p className="text-xs text-muted">The component-by-component figures live on the <Link href="/tracker" className="text-accent font-semibold hover:underline">Plan Tracker</Link>; the printable day or period is the <Link href="/report" className="text-accent font-semibold hover:underline">Report</Link>.</p>
      </section>
    </div>
  );
}

/** One department's period throughput: the figure against its target, a
 *  meter, the complete sets, and how it stands against today's pace. */
function DeptTile({ icon, name, data, target, perDay, paceDays }: { icon: React.ReactNode; name: string; data: DeptDay; target: number; perDay: number; paceDays?: number }) {
  const f = pct(data.total, target);
  const paceT = paceDays !== undefined ? perDay * paceDays : undefined;
  const tone = f >= 1 ? "var(--ok-fg)" : f >= 0.5 ? "var(--brand)" : "var(--bad-fg)";
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-0">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-muted uppercase tracking-wide">{icon}{name}</span>
        <span className="text-xs tabnum text-muted">{data.total} / {target}</span>
      </div>
      <div className="text-3xl font-extrabold leading-tight mt-0.5" style={{ color: tone }}>{fmtPct(data.total, target)}</div>
      <div className="mt-2 h-2.5 rounded-sm bg-border/70 overflow-hidden"><div className="h-full rounded-sm" style={{ width: `${Math.min(100, f * 100)}%`, background: tone }} /></div>
      <div className="text-[11px] text-muted mt-1">
        {data.sets} complete sets
        {paceT !== undefined && paceT > 0 && <> · <span style={{ color: data.total >= paceT ? "var(--ok-fg)" : "var(--bad-fg)" }}>{data.total >= paceT ? "on pace" : `${paceT - data.total} behind pace`}</span></>}
      </div>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    // min-w-0: as a grid item the card must be allowed to shrink below its
    // content's min width, otherwise wide charts push it past the viewport
    <div className="bg-surface border rounded-xl p-4 min-w-0">
      <div className="mb-2">
        <h3 className="font-bold text-sm">{title}</h3>
        {sub && <p className="text-xs text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  );
}
