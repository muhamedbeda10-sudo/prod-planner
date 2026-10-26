"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Info, Loader2 } from "lucide-react";
import { ChartCard } from "@/components/charts/kit";
import { WaterfallFigure } from "@/components/AiChartForms";
import { FramelessChart } from "@/components/AiChartFrame";
import { EmptyState } from "@/components/primitives";
import { ErrorState } from "@/components/DataTable";
import { loadLossWaterfall, type LossWaterfallData } from "@/app/kpis/actions";
import { parseAiChart, type AiWaterfallSpec } from "@/lib/domain/aiChart";
import { LOSS_DAYS } from "@/lib/domain/losses";
import { formatDate } from "@/lib/domain/format";
import { WORK_CENTRES, WORK_CENTRE_LABEL } from "@/lib/domain/shifts";

// "Where did the hours go?" — the Production dashboard's answer to why: a centre's (or
// the floor's) rostered man-hours walked down to the standard hours earned,
// and which loss moved the efficiency against the days before.

const pctText = (e: number | null) => (e === null ? "—" : `${Math.round(e * 100)}%`);

export function LossWaterfallCard({ className = "" }: { className?: string }) {
  const [centre, setCentre] = useState<string>("all");
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<LossWaterfallData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  // what is shown came from these choices; anything else is still loading
  const key = `${centre}|${days}|${seq}`;
  const [shownKey, setShownKey] = useState<string | null>(null);
  const loading = shownKey !== key;

  useEffect(() => {
    let live = true;
    loadLossWaterfall(centre, days)
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setData(r);
          setError(null);
        } else setError(r.error);
      })
      .catch(() => live && setError("Could not load — check the connection and try again."))
      .finally(() => live && setShownKey(`${centre}|${days}|${seq}`));
    return () => {
      live = false;
    };
  }, [centre, days, seq]);

  const spec = useMemo(() => {
    if (!data) return null;
    const parsed = parseAiChart(JSON.stringify({ type: "waterfall", title: "Rostered man-hours to earned standard hours", unit: "h", data: data.now.steps.map((s) => ({ name: s.label, value: s.hours, total: s.total })) }));
    return "error" in parsed ? null : (parsed as AiWaterfallSpec);
  }, [data]);

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <select value={centre} onChange={(e) => setCentre(e.target.value)} aria-label="Work centre" className="py-1 text-sm">
        <option value="all">The whole floor</option>
        {WORK_CENTRES.map((c) => <option key={c} value={c}>{WORK_CENTRE_LABEL[c]}</option>)}
      </select>
      <nav className="seg" aria-label="Days">
        {LOSS_DAYS.map((d) => <button key={d} type="button" className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} d</button>)}
      </nav>
    </div>
  );

  const w = data?.now;
  return (
    <ChartCard
      className={className}
      title="Where did the hours go?"
      about={data ? `${formatDate(data.fromISO)} – ${formatDate(data.toISO)}, against the ${days} days before (whole days, up to yesterday). Rostered hours walked down to the standard hours earned: what absence took, what overtime added, what machine stops idled, and what is left — slower than the standard, or work not on the Daily log.` : "Rostered hours walked down to the standard hours earned."}
      right={controls}
      data={w ? [
        ...w.steps.map((s) => ({ Step: s.label, Hours: s.hours, Total: s.total ? "yes" : "" })),
        ...w.stops.map((s) => ({ Step: `Stop — ${s.label}`, Hours: -s.manH, Total: "", "Machine h": s.machineH })),
      ] : undefined}
    >
      {error ? (
        <ErrorState title="Could not read the hours" detail={error} onRetry={() => { setError(null); setSeq((n) => n + 1); }} />
      ) : !data || !w ? (
        <div className="h-40 grid place-items-center text-sm text-muted"><span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" aria-hidden /> Reading the shift log…</span></div>
      ) : w.days === 0 ? (
        <EmptyState compact icon={Info} title="No shift day recorded in these days" hint={<>Record the day&apos;s attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — the hours are measured from it.</>} />
      ) : (
        <div className={`grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)] ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <div className="min-w-0">{spec && <FramelessChart.Provider value={true}><WaterfallFigure spec={spec} /></FramelessChart.Provider>}</div>
          <div className="space-y-3 text-sm min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="kpi-value">{pctText(w.efficiency)}</span>
              <span className="text-muted">efficiency, earned ÷ worked</span>
              {data.change.change !== null && (
                <span className={`inline-flex items-center gap-0.5 font-semibold tabnum ${data.change.change < 0 ? "text-bad-fg" : data.change.change > 0 ? "text-ok-fg" : "text-muted"}`}>
                  {data.change.change < 0 ? <ArrowDownRight size={14} aria-hidden /> : data.change.change > 0 ? <ArrowUpRight size={14} aria-hidden /> : null}
                  {data.change.change > 0 ? "+" : ""}{data.change.change} pts
                </span>
              )}
            </div>
            <p>{data.change.text}</p>
            {data.biggest && <p className="font-semibold">{data.biggest}</p>}
            {w.stops.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-muted mb-1">Machine stops — the man-hours they idled</h3>
                <ul className="space-y-0.5">
                  {w.stops.slice(0, 5).map((s) => (
                    <li key={s.code} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{s.label}{s.planned ? " (planned)" : ""}</span>
                      <span className="tabnum text-muted shrink-0">{s.manH} man-h · {s.machineH} machine-h</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-sm text-muted">{w.days} recorded day{w.days === 1 ? "" : "s"} · {w.workedH} h worked · {w.earnedH} std-h earned. Ask the assistant “why” for more.</p>
          </div>
        </div>
      )}
    </ChartCard>
  );
}
