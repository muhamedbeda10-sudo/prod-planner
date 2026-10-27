"use client";

import { ChartCard, fmt } from "@/components/charts/kit";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { LV_CHAIN, LV_STAGE_HISTORY_DAYS, LV_STAGE_LABEL, LV_STAGE_SHORT } from "@/lib/domain/lv";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { formatDate } from "@/lib/domain/format";
import type { LvDashboardData } from "@/lib/server/lvDashboard";

// The panels moved per stage, day by day — the panels' own report on the
// Planning dashboard: pick a day (from = to) or a period and the table is
// that period, ready to print, with the month's totals under it.

export function LvStageTable({ d, today }: { d: LvDashboardData; today: string }) {
  const last14 = { label: "Last 14 days", from: addDaysISO(today, -13), to: today };
  return (
    <ChartCard
      title="What moved on each stage?"
      about={`Panels moved per stage on the Daily log, ${d.ranged ? `${formatDate(d.fromISO)} → ${formatDate(d.toISO)}` : `the last ${d.days.length} days`}${d.clamped ? ` (cut to ${d.days.length} days)` : ""}; ${d.monthLabel}'s totals under them. No daily target is set for the panels — when one is, it goes here as the line to beat.`}
      right={
        <UrlDateSlicer
          encoding="fromTo" from={d.fromISO} to={d.toISO} min={addDaysISO(today, -LV_STAGE_HISTORY_DAYS)} max={today} today={today}
          presets={["today", "yesterday", "last7", "thisMonth", "lastMonth", "last30"]} defaultRange={last14} label="Days shown"
        />
      }
      data={[
        ...d.days.map((day) => ({ Day: day.dateISO, ...Object.fromEntries(LV_CHAIN.map((s) => [LV_STAGE_LABEL[s], day.byStage[s]])) })),
        { Day: d.ranged ? "Period" : `Last ${d.days.length} days`, ...Object.fromEntries(LV_CHAIN.map((s) => [LV_STAGE_LABEL[s], d.period[s]])) },
        { Day: d.monthLabel, ...Object.fromEntries(LV_CHAIN.map((s) => [LV_STAGE_LABEL[s], d.month[s]])) },
      ]}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left">
              <th scope="col" className="px-2 py-1 text-xs font-bold text-muted">Day</th>
              {LV_CHAIN.map((s) => <th key={s} scope="col" className="px-2 py-1 text-xs font-bold text-muted text-center" title={LV_STAGE_LABEL[s]}><abbr title={LV_STAGE_LABEL[s]} className="no-underline">{LV_STAGE_SHORT[s]}</abbr></th>)}
            </tr>
          </thead>
          <tbody>
            {d.days.map((day) => {
              const any = LV_CHAIN.some((s) => day.byStage[s] !== 0);
              return (
                <tr key={day.dateISO} className={`border-t ${any ? "" : "text-muted"}`}>
                  <td className="px-2 py-1 tabnum ltr whitespace-nowrap">{formatDate(day.dateISO)}</td>
                  {LV_CHAIN.map((s) => <td key={s} className={`px-2 py-1 text-center tabnum ${day.byStage[s] > 0 ? "font-bold" : ""}`}>{day.byStage[s] || "·"}</td>)}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-1">{d.ranged ? "Period" : `Last ${d.days.length} days`}</td>
              {LV_CHAIN.map((s) => <td key={s} className="px-2 py-1 text-center tabnum">{fmt(d.period[s])}</td>)}
            </tr>
            <tr>
              <td className="px-2 py-1">{d.monthLabel}</td>
              {LV_CHAIN.map((s) => <td key={s} className="px-2 py-1 text-center tabnum">{fmt(d.month[s])}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
    </ChartCard>
  );
}
