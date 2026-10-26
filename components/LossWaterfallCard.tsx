"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { ChartCard } from "@/components/charts/kit";
import { WaterfallFigure } from "@/components/AiChartForms";
import { FramelessChart } from "@/components/AiChartFrame";
import { EmptyState } from "@/components/primitives";
import { parseAiChart, type AiWaterfallSpec } from "@/lib/domain/aiChart";
import type { HoursWalk } from "@/lib/domain/productionDashboard";

// "Where did the hours go?" — the Production dashboard's answer to why, over
// the page's own period, line, department and centre (both shifts: the Daily
// log has none): the booked man-hours walked from the rostered ones down to
// the standard hours earned — what absence took, what overtime added, what
// the machine stops idled (machine-hours turned into man-hours: an estimate,
// the shift log does not say who stood at a stopped machine) and what is left
// unexplained — against the equal stretch before. Its ends meet the tiles.

const pctText = (e: number | null) => (e === null ? "—" : `${Math.round(e * 100)}%`);

export function LossWaterfallCard({ walk, scope, range, beforeRange, notPriced = false, className = "" }: {
  walk: HoursWalk;
  /** None of the output carries standard hours: there is no earned end to walk down to. */
  notPriced?: boolean;
  /** What the page shows — "The whole plant", "Welding (TR)". */
  scope: string;
  range: string;
  /** The stretch the change is read against, or null with none. */
  beforeRange: string | null;
  className?: string;
}) {
  const w = walk.now;
  const spec = useMemo(() => {
    const parsed = parseAiChart(JSON.stringify({ type: "waterfall", title: "Rostered man-hours to earned standard hours", unit: "h", data: w.steps.map((s) => ({ name: s.label, value: s.hours, total: s.total })) }));
    return "error" in parsed ? null : (parsed as AiWaterfallSpec);
  }, [w]);
  const change = walk.change;

  return (
    <ChartCard
      className={className}
      title="Where did the hours go?"
      sub={`${scope} · ${range} · both shifts`}
      about={`${scope} over ${range} — the page's own period and filters, both shifts (the Daily log records no shift)${beforeRange ? `, against ${beforeRange}` : ""}. Rostered man-hours (booked − overtime + the shift hours of those absent) walked down to the standard hours earned: what absence took, what overtime added, what the machine stops idled — machine-hours turned into man-hours at the centre's people-to-machine hours that day, an estimate since the shift log does not say who stood at a stopped machine, and never more than the hours not earned — and the unexplained rest: slower than the standard, or work not on the Daily log. The panels have no machines of their own, so no stop counts on their side. Detail of the stops: Shifts → Machine stops.`}
      data={[
        ...w.steps.map((s) => ({ Step: s.label, Hours: s.hours, Total: s.total ? "yes" : "" })),
        ...w.stops.map((s) => ({ Step: `Stop — ${s.label}`, Hours: -s.manH, Total: "", "Machine h": s.machineH })),
      ]}
    >
      {notPriced ? (
        <EmptyState compact icon={Info} title="The output carries no standard hours" hint={<>Its earned hours are not known, so the hours cannot be walked down to them. Price it on <Link href="/admin/standard-times" className="text-brand-ink font-semibold hover:underline">Admin → Standard Times</Link>.</>} />
      ) : w.days === 0 ? (
        <EmptyState compact icon={Info} title="No shift day recorded in this period" hint={<>Record the day&apos;s attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — the hours are measured from it.</>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(14rem,2fr)]">
          <div className="min-w-0">{spec && <FramelessChart.Provider value={true}><WaterfallFigure spec={spec} /></FramelessChart.Provider>}</div>
          <div className="space-y-3 text-sm min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="kpi-value">{pctText(w.efficiency)}</span>
              <span className="text-muted">efficiency, earned ÷ worked</span>
              {change && change.change !== null && (
                <span className={`inline-flex items-center gap-0.5 font-semibold tabnum ${change.change < 0 ? "text-bad-fg" : change.change > 0 ? "text-ok-fg" : "text-muted"}`} title={beforeRange ? `Against ${beforeRange}` : undefined}>
                  {change.change < 0 ? <ArrowDownRight size={14} aria-hidden /> : change.change > 0 ? <ArrowUpRight size={14} aria-hidden /> : null}
                  {change.change > 0 ? "+" : ""}{change.change} pts
                </span>
              )}
            </div>
            {w.stops.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-muted mb-1">Machine stops — the man-hours they idled (est.)</h3>
                <ul className="space-y-0.5">
                  {w.stops.slice(0, 5).map((s) => (
                    <li key={s.code} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{s.label}{s.planned ? " (planned)" : ""}</span>
                      <span className="tabnum text-muted shrink-0">{s.manH} man-h · {s.machineH} machine-h</span>
                    </li>
                  ))}
                </ul>
                <Link href="/shifts?view=downtime" className="text-xs text-brand-ink font-semibold hover:underline">Every stop on Shifts → Machine stops</Link>
              </div>
            )}
          </div>
        </div>
      )}
    </ChartCard>
  );
}
