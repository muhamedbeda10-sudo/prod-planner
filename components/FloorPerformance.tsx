"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Bullet, ChartCard, StatTile, TONE_CELL, TONE_TEXT, fmt, pct, pctOrDash } from "@/components/charts/kit";
import { OutputChart, ProductivityTrendChart } from "@/components/LazyCharts";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { EmptyState, Tabs } from "@/components/primitives";
import { useSetParam } from "@/components/useSetParam";
import { TableFrame, Th } from "@/components/DataTable";
import { formatDate, formatDayShort } from "@/lib/domain/format";
import { addDaysISO, slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { stopDurationLabel } from "@/lib/domain/downtime";
import { WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import { OUTPUT_GROUPS, OUTPUT_GROUP_LABEL, efficiencyBand, paretoOf } from "@/lib/domain/kpis";
import { FLOOR_HISTORY_DAYS, FLOOR_MAX_DAYS, groupsOf, type FloorDept } from "@/lib/domain/floorKpis";
import { EFFICIENCY_OK, EFFICIENCY_WARN } from "@/lib/domain/productivity";
import type { FloorPeriod } from "@/lib/server/kpis";

// 🏭 How the floor worked over the period the planner picks — one department
// or all: each centre's efficiency day by day (a heatmap, green at the
// standard), what one person turns out, how the hours went (attendance,
// overtime, the machines' availability), the output day by day and what
// stopped the machines. Shown to the accounts that see Shifts; the figures
// come from getFloorPeriod (lib/server/kpis.ts). The period and the
// department live in the URL (?from=&to=&dept=), so a link opens as sent.

const DEPT_TABS: { id: FloorDept; label: string }[] = [{ id: "all", label: "All" }, ...OUTPUT_GROUPS.map((g) => ({ id: g, label: OUTPUT_GROUP_LABEL[g] }))];

const BAND_WORD = {
  ok: `at the standard (${pct(EFFICIENCY_OK)} and up)`,
  warn: `short (${pct(EFFICIENCY_WARN)}–${pct(EFFICIENCY_OK)})`,
  bad: `well short (under ${pct(EFFICIENCY_WARN)})`,
} as const;

const hOrDash = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${fmt(v, 1)} h`);
const oneDecimal = (v: number | null) => (v === null ? "" : Math.round(v * 10) / 10);
const whole = (v: number | null) => (v === null ? "" : Math.round(v * 100));

/** The department switch: keeps the period, drops the department when it is "All". */
function DeptTabs({ dept }: { dept: FloorDept }) {
  const setParam = useSetParam();
  return <Tabs label="Department" items={DEPT_TABS} value={dept} onChange={(id) => setParam("dept", id === "all" ? "" : id)} />;
}

export function FloorPerformance({ period, todayISO, defaultRange }: {
  period: FloorPeriod;
  todayISO: string;
  /** The section's own period — picking it clears the dates from the URL. */
  defaultRange: { label: string; from: string; to: string };
}) {
  const { summary: s, grid, dates, groups, trend, output, losses, window } = period;
  const pareto = useMemo(() => paretoOf(losses.causes), [losses.causes]);
  const plannedStops = losses.causes.filter((c) => c.planned);
  const single = period.dept === "all" ? null : groups.find((g) => g.group === period.dept) ?? null;
  const range = slicerRangeLabel(period.fromISO, period.toISO);
  const deptLabel = period.dept === "all" ? "every department" : OUTPUT_GROUP_LABEL[period.dept];
  const stamp = `${period.fromISO}_${period.toISO}${period.dept === "all" ? "" : `-${period.dept}`}`;
  const noDays = dates.length === 0;
  const empty = (
    <EmptyState compact icon={Info} title="No shift day recorded in this period"
      hint={<>Pick a longer period, or record the attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — the figures are set against the hours booked.</>} />
  );

  return (
    <section className="space-y-3" aria-labelledby="floor-head">
      {/* the section's head: what it is, and its two filters in one wrapping toolbar */}
      <div className="bg-surface border rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 no-print">
        <div className="min-w-0 me-auto">
          <h2 id="floor-head" className="font-bold leading-tight">Floor performance</h2>
          <p className="text-xs text-muted mt-0.5">
            {range} · {deptLabel} · {dates.length} recorded day{dates.length === 1 ? "" : "s"} · in standard hours
            {period.clamped && <span className="pill pill-warn ms-2" title={`A period is at most ${FLOOR_MAX_DAYS} days, within the last ${FLOOR_HISTORY_DAYS}, and never past today`}>period adjusted</span>}
          </p>
        </div>
        <DeptTabs dept={period.dept} />
        <UrlDateSlicer
          encoding="fromTo" from={period.fromISO} to={period.toISO} min={addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1))} max={todayISO} today={todayISO} marks={dates} label="Period"
          presets={["yesterday", "thisWeek", "last14", "thisMonth", "lastMonth", "last30", "last90"]} defaultRange={defaultRange}
        />
      </div>
      <p className="print-only text-sm font-bold">Floor performance · {range} · {deptLabel}</p>

      {/* the period's figures */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <StatTile hero label="Efficiency" value={pctOrDash(s.efficiency)} meter={s.efficiency === null ? undefined : Math.min(1, s.efficiency)}
          sub={noDays ? "no recorded day" : `${fmt(s.earnedH, 1)} std-h of ${fmt(s.workedH, 1)} h booked`} />
        <StatTile label="Std-h a person a day" value={hOrDash(s.stdPerPersonDay)} sub={`over ${s.personDays} person-day${s.personDays === 1 ? "" : "s"}`} />
        {single && (
          <StatTile label="Pieces a person a day" value={single.piecesPerPersonDay === null ? "—" : fmt(single.piecesPerPersonDay, 1)} sub={`${fmt(single.pieces)} pcs in the period`} />
        )}
        <StatTile label="People a day" value={noDays ? "—" : fmt(s.people, 1)} sub="present, on average" />
        <StatTile label="Attendance" value={pctOrDash(s.attendance)} sub="of the people rostered" />
        <StatTile label="Overtime" value={pctOrDash(s.overtimeShare)} sub={`${fmt(s.overtimeH, 1)} h of the hours`} />
        <StatTile label="Machines up" value={pctOrDash(s.availability)} sub={`${stopDurationLabel(losses.unplannedH)} unplanned stops`} />
      </div>

      {/* each centre's efficiency day by day, and what stopped the machines */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-8"
          title="Did each centre work at the standard?"
          sub="Efficiency each recorded day: the standard hours the output was worth ÷ the man-hours booked there. Green is at the standard, amber short of it, red well short; the last column is the whole period."
          table={noDays ? undefined : { filename: `centre-efficiency-${stamp}.xlsx`, rows: grid.flatMap((r) => r.cells.filter((c) => c.workedH > 0).map((c) => ({ Centre: WORK_CENTRE_LABEL[r.centre], Day: c.dateISO, "Earned h": c.earnedH, "Booked h": c.workedH, "Efficiency %": c.efficiency === null ? "" : Math.round(c.efficiency * 100) }))) }}
        >
          {noDays || grid.length === 0 ? empty : (
            <>
              <TableFrame className="!max-h-none">
                <table className="border-separate w-full" style={{ borderSpacing: 3 }}>
                  <thead>
                    <tr>
                      <th scope="col" className="px-2 text-left text-xs font-bold text-muted sticky left-0 bg-surface z-[1]">Centre</th>
                      {dates.map((d) => (
                        <th key={d} scope="col" className="px-1 text-[11px] font-bold text-muted text-center leading-tight whitespace-nowrap">
                          <span className="block font-normal">{formatDate(d).split(" ")[0]}</span>{formatDayShort(d)}
                        </th>
                      ))}
                      <th scope="col" className="px-2 text-xs font-bold text-muted text-center whitespace-nowrap">Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.map((r) => {
                      const tb = efficiencyBand(r.total);
                      return (
                        <tr key={r.centre}>
                          <th scope="row" className="px-2 text-left text-sm font-semibold whitespace-nowrap sticky left-0 bg-surface z-[1]">{WORK_CENTRE_LABEL[r.centre]}</th>
                          {r.cells.map((c) => {
                            const b = efficiencyBand(c.efficiency);
                            return (
                              <td key={c.dateISO}
                                className={`min-w-[3.25rem] px-1.5 py-1.5 rounded text-center text-[13px] tabnum font-semibold ${b ? TONE_CELL[b] : "bg-surface-2 text-muted font-normal"}`}
                                title={c.efficiency === null ? `${WORK_CENTRE_LABEL[r.centre]} · ${formatDate(c.dateISO)}: no hours booked` : `${WORK_CENTRE_LABEL[r.centre]} · ${formatDate(c.dateISO)}: ${pct(c.efficiency)} — ${fmt(c.earnedH, 1)} std-h of ${fmt(c.workedH, 1)} h booked`}>
                                {c.efficiency === null ? "·" : pct(c.efficiency)}
                              </td>
                            );
                          })}
                          <td className={`min-w-[4rem] px-2 py-1.5 rounded text-center text-[13px] tabnum font-extrabold ${tb ? TONE_CELL[tb] : "text-muted"}`}
                            title={`${WORK_CENTRE_LABEL[r.centre]}: ${pctOrDash(r.total)} over ${r.days} recorded day${r.days === 1 ? "" : "s"}`}>
                            {pctOrDash(r.total)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableFrame>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted" aria-label="Colour key">
                {(["ok", "warn", "bad"] as const).map((b) => (
                  <li key={b} className="inline-flex items-center gap-1.5"><span className={`inline-block w-3.5 h-3.5 rounded-sm ${TONE_CELL[b]}`} aria-hidden />{BAND_WORD[b]}</li>
                ))}
                <li className="inline-flex items-center gap-1.5"><span className="inline-block w-3.5 h-3.5 rounded-sm bg-surface-2" aria-hidden />no hours booked</li>
              </ul>
            </>
          )}
          {period.pricedShare !== null && period.pricedShare < 0.95 && (
            <p className="text-xs text-muted mt-2">
              {Math.round(period.pricedShare * 100)}% of the period&apos;s pieces carry standard hours — the rest earns nothing and reads as slow.{" "}
              <Link href="/admin/standard-times" className="text-brand-ink font-semibold hover:underline">Type its hours a piece →</Link>
            </p>
          )}
        </ChartCard>
        <ChartCard
          className="xl:col-span-4"
          title="What stopped us?"
          sub={`${stopDurationLabel(losses.unplannedH)} machine time lost in the period, biggest cause first; Σ is the share it and the causes above make up.`}
          table={{ filename: `losses-${stamp}.xlsx`, rows: losses.causes.map((c) => ({ Cause: c.label, Duration: stopDurationLabel(c.hours), Hours: c.hours, Stops: c.stops, "Share of lost %": c.share === null ? "" : Math.round(c.share * 100), Planned: c.planned ? "yes" : "" })) }}
        >
          {pareto.length === 0 ? (
            <EmptyState compact icon={Info} title="No unplanned stop in this period" hint={<>Record stops on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts → Machine stops</Link> to see what costs the most.</>} />
          ) : (
            // a Pareto as rows: biggest cause first, its share and (Σ) the share it and the causes above make up
            <div className="space-y-3">
              {pareto.map((c) => (
                <Bullet key={c.code} label={c.label} value={c.hours} target={null} max={pareto[0].hours}
                  text={`${stopDurationLabel(c.hours)} · ${c.stops} stop${c.stops === 1 ? "" : "s"} · ${Math.round(c.share * 100)}%${pareto.length > 1 ? ` (Σ ${Math.round(c.cumShare * 100)}%)` : ""}`} />
              ))}
            </div>
          )}
          {plannedStops.length > 0 && (
            <p className="text-sm text-muted mt-2">Planned maintenance, kept apart: {plannedStops.map((c) => `${stopDurationLabel(c.hours)} (${c.stops} stop${c.stops === 1 ? "" : "s"})`).join(", ")}.</p>
          )}
        </ChartCard>
      </div>

      {/* what a person turns out, department by department */}
      <ChartCard
        title="What does a person turn out?"
        sub="Each department over the period: its people, the hours they booked, what the output was worth and what one person turned out on a recorded day."
        table={noDays ? undefined : { filename: `productivity-${stamp}.xlsx`, rows: groups.map((g) => ({ Department: OUTPUT_GROUP_LABEL[g.group], "Recorded days": g.days, "People a day": g.people, "Booked h": g.workedH, "Earned h": g.earnedH, "Efficiency %": g.efficiency === null ? "" : Math.round(g.efficiency * 100), "Std-h a person a day": oneDecimal(g.stdPerPersonDay), Pieces: g.pieces, "Pieces a person a day": oneDecimal(g.piecesPerPersonDay), "Overtime %": whole(g.overtimeShare), "Attendance %": whole(g.attendance), "Machines up %": whole(g.availability), "Stopped h": g.downtimeH })) }}
      >
        {noDays || groups.length === 0 ? empty : (
          <TableFrame className="!max-h-none">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th label="Department" />
                  <Th label="People" full="People present on an average recorded day" num className="text-right" />
                  <Th label="Booked" unit="h" full="Man-hours the shift log booked" num className="text-right" />
                  <Th label="Earned" unit="std-h" full="Standard hours the output was worth" num className="text-right" />
                  <Th label="Efficiency" full="Earned ÷ booked" num className="text-right" />
                  <Th label="Std-h a person" full="Standard hours one person turned out on a recorded day" num className="text-right" />
                  <Th label="Pieces" full="Pieces the Daily log recorded on the department's recorded days — shot blast counts every painted piece, as on Shifts" num className="text-right" />
                  <Th label="Pcs a person" full="Pieces one person turned out on a recorded day" num className="text-right" />
                  <Th label="Overtime" full="Overtime ÷ the hours booked" num className="text-right" />
                  <Th label="Attendance" full="Present ÷ the people rostered" num className="text-right" />
                  <Th label="Machines up" full="Machines available: 1 − stopped ÷ machine hours" num className="text-right" />
                  <Th label="Stopped" unit="h" full="Machine hours lost to stops" num className="text-right" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const b = efficiencyBand(g.efficiency);
                  return (
                    <tr key={g.group}>
                      <td className="px-2 font-semibold whitespace-nowrap">{OUTPUT_GROUP_LABEL[g.group]}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.people, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.workedH, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.earnedH, 1)}</td>
                      <td className={`px-2 text-right tabnum font-bold ${b ? TONE_TEXT[b] : "text-muted"}`}>{pctOrDash(g.efficiency)}</td>
                      <td className="px-2 text-right tabnum font-bold">{g.stdPerPersonDay === null ? "—" : fmt(g.stdPerPersonDay, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.pieces)}</td>
                      <td className="px-2 text-right tabnum font-bold">{g.piecesPerPersonDay === null ? "—" : fmt(g.piecesPerPersonDay, 1)}</td>
                      <td className="px-2 text-right tabnum">{pctOrDash(g.overtimeShare)}</td>
                      <td className="px-2 text-right tabnum">{pctOrDash(g.attendance)}</td>
                      <td className="px-2 text-right tabnum">{pctOrDash(g.availability)}</td>
                      <td className="px-2 text-right tabnum">{fmt(g.downtimeH, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        )}
      </ChartCard>

      {/* the output day by day, and the floor's efficiency over the days */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-7"
          title="What did we turn out each day?"
          sub="Standard hours the output was worth, by department, against the man-hours the shift log booked — the gap between the bars and the line is the pace lost (or won)."
          table={noDays ? undefined : { filename: `output-${stamp}.xlsx`, rows: output.map((d) => ({ Day: d.dateISO, ...Object.fromEntries(groupsOf(period.dept).map((g) => [`${OUTPUT_GROUP_LABEL[g]} h`, d[g]])), "Earned h": d.earnedH, "Booked h": d.workedH, "Efficiency %": d.efficiency === null ? "" : Math.round(d.efficiency * 100) })) }}
        >
          {output.length === 0 ? empty : <OutputChart days={output} groups={groupsOf(period.dept)} />}
        </ChartCard>
        <ChartCard
          className="xl:col-span-5"
          title="Is the floor getting faster?"
          sub={`The floor's efficiency each recorded day (dots) and over the last ${window} recorded days together (the line); the dashed line is the standard.`}
          table={noDays ? undefined : { filename: `efficiency-trend-${stamp}.xlsx`, rows: trend.map((p) => ({ Day: p.dateISO, "Earned h": p.earnedH, "Booked h": p.workedH, "Efficiency %": p.efficiency === null ? "" : Math.round(p.efficiency * 100), [`Last ${window} recorded days %`]: whole(p.rolling), "Std-h a person a day": oneDecimal(p.stdPerPersonDay) })) }}
        >
          {trend.length === 0 ? empty : <ProductivityTrendChart points={trend} window={window} />}
        </ChartCard>
      </div>
    </section>
  );
}
