"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { ChartCard, StatTile, TONE_TEXT, fmt, pctOrDash } from "@/components/charts/kit";
import { EfficiencyHeatmap } from "@/components/EfficiencyHeatmap";
import { OutputChart, ProductivityTrendChart } from "@/components/LazyCharts";
import { EmptyState, Tabs } from "@/components/primitives";
import { useSetParam } from "@/components/useSetParam";
import { TableFrame, Th } from "@/components/DataTable";
import { slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { efficiencyBand } from "@/lib/domain/kpis";
import { FLOOR_HISTORY_DAYS, FLOOR_MAX_DAYS } from "@/lib/domain/floorKpis";
import { LV_STAGES, LV_STAGE_LABEL, LV_STAGE_SHORT } from "@/lib/domain/lv";
import { LV_DEPT_STAGE_OF, LV_FLOOR_DEPTS, LV_FLOOR_DEPT_LABEL, lvDeptsOf, type LvFloorFilter } from "@/lib/domain/lvKpis";
import type { LvFloorPeriod } from "@/lib/server/lvKpis";

// How the panels' floor worked over the period picked — every department or
// one: each department's efficiency day by day, what one person turns out
// (in standard hours and in panels), attendance and overtime, the output
// day by day and the floor's efficiency over the days. The panels' own
// hours (the timings sheet's LV tab) against their own four departments on
// the shift log; nothing of the transformers' is mixed in, and no machine
// stop is here — stops are recorded by department on shared machines. The
// panels' section of the Production dashboard: the period is the page's (its
// date bar), the department this section's own (?lvDept=).

const DEPT_TABS: { id: LvFloorFilter; label: string }[] = [{ id: "all", label: "All" }, ...LV_FLOOR_DEPTS.map((d) => ({ id: d, label: LV_FLOOR_DEPT_LABEL[d] }))];
const hOrDash = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${fmt(v, 1)} h`);
const oneDecimal = (v: number | null) => (v === null ? "" : Math.round(v * 10) / 10);
const whole = (v: number | null) => (v === null ? "" : Math.round(v * 100));

function DeptTabs({ dept }: { dept: LvFloorFilter }) {
  const setParam = useSetParam();
  return <Tabs label="Panels' department" items={DEPT_TABS} value={dept} onChange={(id) => setParam("lvDept", id === "all" ? "" : id)} />;
}

export function LvFloorPerformance({ period }: { period: LvFloorPeriod }) {
  const { summary: s, grid, dates, groups, trend, output, window, moved } = period;
  const single = period.dept === "all" ? null : groups.find((g) => g.dept === period.dept) ?? null;
  const range = slicerRangeLabel(period.fromISO, period.toISO);
  const deptLabel = period.dept === "all" ? "every department" : LV_FLOOR_DEPT_LABEL[period.dept];
  const noDays = dates.length === 0;
  const empty = (
    <EmptyState compact icon={Info} title="No shift day recorded on the panels in this period"
      hint={<>Pick a longer period, or record the panels&apos; attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — the figures are set against the hours booked.</>} />
  );
  const movedTotal = LV_STAGES.reduce((t, st) => t + moved[st], 0);
  const depts = lvDeptsOf(period.dept);
  // the days as the output chart draws them: each department's std-hours against the hours booked
  const points = output.map((d) => ({ dateISO: d.dateISO, earnedH: d.earnedH, workedH: d.workedH, efficiency: d.efficiency, values: Object.fromEntries(depts.map((g) => [g, d.byDept[g]])) }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 no-print">
        <DeptTabs dept={period.dept} />
        <p className="text-xs text-muted">
          {deptLabel} · {dates.length} recorded day{dates.length === 1 ? "" : "s"} · in the panels&apos; standard hours
          {period.clamped && <span className="pill pill-warn ms-2" title={`A period is at most ${FLOOR_MAX_DAYS} days, within the last ${FLOOR_HISTORY_DAYS}, and never past today`}>period adjusted</span>}
        </p>
      </div>
      <p className="print-only text-sm font-bold">Floor performance · LV panels · {range} · {deptLabel}</p>

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <StatTile hero label="Efficiency" value={pctOrDash(s.efficiency)} meter={s.efficiency === null ? undefined : Math.min(1, s.efficiency)}
          sub={noDays ? "no recorded day" : `${fmt(s.earnedH, 1)} std-h of ${fmt(s.workedH, 1)} h booked`} />
        <StatTile label="Std-h a person a day" value={hOrDash(s.stdPerPersonDay)} sub={`over ${s.personDays} person-day${s.personDays === 1 ? "" : "s"}`} />
        <StatTile label={single ? `Panels — ${LV_STAGE_LABEL[LV_DEPT_STAGE_OF[single.dept]].toLowerCase()}` : "Panels moved"} value={fmt(single ? single.panels : movedTotal)}
          sub={single ? `${single.panelsPerPersonDay === null ? "—" : fmt(single.panelsPerPersonDay, 1)} a person a day` : LV_STAGES.map((st) => `${LV_STAGE_SHORT[st]} ${fmt(moved[st])}`).join(" · ")} />
        <StatTile label="People a day" value={noDays ? "—" : fmt(s.people, 1)} sub="present, on average" />
        <StatTile label="Attendance" value={pctOrDash(s.attendance)} sub="of the people rostered on the panels" />
        <StatTile label="Overtime" value={pctOrDash(s.overtimeShare)} sub={`${fmt(s.overtimeH, 1)} h of the hours`} />
      </div>

      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-8"
          title="Did each department work at the standard?"
          about={`Efficiency each recorded day: the panels moved × the timings sheet's hours for that stage ÷ the man-hours booked in the department. Green is at the standard, amber short of it, red well short; the last column is the whole period.${period.pricedShare !== null && period.pricedShare < 0.95 ? ` Only ${Math.round(period.pricedShare * 100)}% of the period's panels are on an order the timings sheet prices — the rest earns nothing and reads as slow (add the panel to the LV tab on Admin → Standard Times).` : ""}`}
          data={noDays ? undefined : grid.flatMap((r) => r.cells.filter((c) => c.workedH > 0).map((c) => ({ Department: LV_FLOOR_DEPT_LABEL[r.centre], Day: c.dateISO, "Earned h": c.earnedH, "Booked h": c.workedH, "Efficiency %": c.efficiency === null ? "" : Math.round(c.efficiency * 100) })))}
        >
          {noDays || grid.length === 0 ? empty : <EfficiencyHeatmap grid={grid} dates={dates} labels={LV_FLOOR_DEPT_LABEL} rowHead="Department" />}
        </ChartCard>
        <ChartCard
          className="xl:col-span-4"
          title="What stopped the machines?"
          about="Stops are recorded on the machine, by department — the punches are shared with the transformers — so no stop is the panels' alone."
        >
          <EmptyState compact icon={Info} title="Not separable by line" hint={<>The plant&apos;s stops, counted once, are in the <a href="#tr" className="text-brand-ink font-semibold hover:underline">transformers&apos; section</a> and the plant&apos;s figures above.</>} />
        </ChartCard>
      </div>

      <ChartCard
        title="What does a person turn out?"
        about="Each department over the period: its people, the hours they booked, what the panels moved were worth and what one person turned out on a recorded day."
        data={noDays ? undefined : groups.map((g) => ({ Department: LV_FLOOR_DEPT_LABEL[g.dept], "Recorded days": g.days, "People a day": g.people, "Booked h": g.workedH, "Earned h": g.earnedH, "Efficiency %": g.efficiency === null ? "" : Math.round(g.efficiency * 100), "Std-h a person a day": oneDecimal(g.stdPerPersonDay), Panels: g.panels, "Panels a person a day": oneDecimal(g.panelsPerPersonDay), "Overtime %": whole(g.overtimeShare), "Attendance %": whole(g.attendance) }))}
      >
        {noDays || groups.length === 0 ? empty : (
          <TableFrame className="!max-h-none">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th label="Department" />
                  <Th label="People" full="People present on an average recorded day" num className="text-right" />
                  <Th label="Booked" unit="h" full="Man-hours the shift log booked" num className="text-right" />
                  <Th label="Earned" unit="std-h" full="Standard hours the panels moved were worth (the timings sheet's LV tab)" num className="text-right" />
                  <Th label="Efficiency" full="Earned ÷ booked" num className="text-right" />
                  <Th label="Std-h a person" full="Standard hours one person turned out on a recorded day" num className="text-right" />
                  <Th label="Panels" full="Panels the department moved on its recorded days" num className="text-right" />
                  <Th label="Panels a person" full="Panels one person moved on a recorded day" num className="text-right" />
                  <Th label="Overtime" full="Overtime ÷ the hours booked" num className="text-right" />
                  <Th label="Attendance" full="Present ÷ the people rostered" num className="text-right" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const b = efficiencyBand(g.efficiency);
                  return (
                    <tr key={g.dept}>
                      <td className="px-2 font-semibold whitespace-nowrap">{LV_FLOOR_DEPT_LABEL[g.dept]}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.people, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.workedH, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.earnedH, 1)}</td>
                      <td className={`px-2 text-right tabnum font-bold ${b ? TONE_TEXT[b] : "text-muted"}`}>{pctOrDash(g.efficiency)}</td>
                      <td className="px-2 text-right tabnum font-bold">{g.stdPerPersonDay === null ? "—" : fmt(g.stdPerPersonDay, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.panels)}</td>
                      <td className="px-2 text-right tabnum font-bold">{g.panelsPerPersonDay === null ? "—" : fmt(g.panelsPerPersonDay, 1)}</td>
                      <td className="px-2 text-right tabnum">{pctOrDash(g.overtimeShare)}</td>
                      <td className="px-2 text-right tabnum">{pctOrDash(g.attendance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        )}
      </ChartCard>

      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-7"
          title="What did we turn out each day?"
          about="Standard hours the panels moved were worth, by department, against the man-hours the shift log booked on the panels."
          data={noDays ? undefined : output.map((d) => ({ Day: d.dateISO, ...Object.fromEntries(depts.map((g) => [`${LV_FLOOR_DEPT_LABEL[g]} h`, Math.round(d.byDept[g] * 10) / 10])), "Earned h": Math.round(d.earnedH * 10) / 10, "Booked h": Math.round(d.workedH * 10) / 10, "Efficiency %": d.efficiency === null ? "" : Math.round(d.efficiency * 100) }))}
        >
          {output.length === 0 ? empty : <OutputChart days={points} groups={depts} labels={LV_FLOOR_DEPT_LABEL} />}
        </ChartCard>
        <ChartCard
          className="xl:col-span-5"
          title="Is the panels' floor getting faster?"
          about={`The panels' efficiency each recorded day (dots) and over the last ${window} recorded days together (the line); the dashed line is the standard.`}
          data={noDays ? undefined : trend.map((p) => ({ Day: p.dateISO, "Earned h": p.earnedH, "Booked h": p.workedH, "Efficiency %": p.efficiency === null ? "" : Math.round(p.efficiency * 100), [`Last ${window} recorded days %`]: whole(p.rolling), "Std-h a person a day": oneDecimal(p.stdPerPersonDay) }))}
        >
          {trend.length === 0 ? empty : <ProductivityTrendChart points={trend} window={window} />}
        </ChartCard>
      </div>
    </div>
  );
}
