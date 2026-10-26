"use client";

import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";
import { ChartCard, StatTile, fmt, pctOrDash } from "@/components/charts/kit";
import { DecisionList, PrintDecisions } from "@/components/CockpitDecisions";
import { OutputChart } from "@/components/LazyCharts";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { EmptyState } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { dashHref } from "@/lib/domain/dashboardScope";
import { addDaysISO, slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { stopDurationLabel } from "@/lib/domain/downtime";
import { FLOOR_HISTORY_DAYS } from "@/lib/domain/floorKpis";
import { OUTPUT_GROUP_LABEL, type CockpitAction } from "@/lib/domain/kpis";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";
import { LV_STAGES, LV_STAGE_SHORT } from "@/lib/domain/lv";
import { linePart, plantDailyOutput, plantEfficiency } from "@/lib/domain/plantKpis";
import type { FloorPeriod } from "@/lib/server/kpis";
import type { LvFloorPeriod } from "@/lib/server/lvKpis";

/** What the plant's page needs of each line — the page sends no more to the browser. */
export type PlantProductionTr = Pick<FloorPeriod, "fromISO" | "toISO" | "clamped" | "dates" | "summary" | "groups" | "output" | "losses" | "pricedShare">;
export type PlantProductionLv = Pick<LvFloorPeriod, "clamped" | "dates" | "summary" | "groups" | "output" | "moved" | "pricedShare">;

// The whole plant's Production dashboard over one period: the plant's
// efficiency from the two lines' SUMS (never the mean of their rates), its
// standard hours and man-hours added, then the lines side by side. The
// machines' stops are recorded by department on shared machines, so they
// are the plant's, counted once; pieces are shown per line and never added.

export function PlantProduction({ tr, lv, todayISO, defaultRange, active, actions }: {
  tr: PlantProductionTr; lv: PlantProductionLv; todayISO: string; defaultRange: { label: string; from: string; to: string }; active: ProductLine; actions: readonly CockpitAction[];
}) {
  const plant = plantEfficiency([linePart("TR", tr), linePart("LV", lv)]);
  const range = slicerRangeLabel(tr.fromISO, tr.toISO);
  const dates = [...new Set([...tr.dates, ...lv.dates])].sort();
  const noDays = dates.length === 0;
  // each line's earned hours per day, side by side; the man-hours added (the domain's rule)
  const output = plantDailyOutput(tr.output, lv.output);
  const trPieces = tr.groups.map((g) => `${OUTPUT_GROUP_LABEL[g.group]} ${fmt(g.pieces)}`).join(" · ");
  const lvPanels = LV_STAGES.map((s) => `${LV_STAGE_SHORT[s]} ${fmt(lv.moved[s])}`).join(" · ");
  const rows: { label: string; TR: string; LV: string }[] = [
    { label: "Recorded days", TR: String(tr.summary.days), LV: String(lv.summary.days) },
    { label: "Efficiency", TR: pctOrDash(tr.summary.efficiency), LV: pctOrDash(lv.summary.efficiency) },
    { label: "Standard hours earned", TR: `${fmt(tr.summary.earnedH, 1)} h`, LV: `${fmt(lv.summary.earnedH, 1)} h` },
    { label: "Man-hours booked", TR: `${fmt(tr.summary.workedH, 1)} h`, LV: `${fmt(lv.summary.workedH, 1)} h` },
    { label: "People a day", TR: fmt(tr.summary.people, 1), LV: fmt(lv.summary.people, 1) },
    { label: "Std-h a person a day", TR: tr.summary.stdPerPersonDay === null ? "—" : fmt(tr.summary.stdPerPersonDay, 1), LV: lv.summary.stdPerPersonDay === null ? "—" : fmt(lv.summary.stdPerPersonDay, 1) },
    { label: "Attendance", TR: pctOrDash(tr.summary.attendance), LV: pctOrDash(lv.summary.attendance) },
    { label: "Overtime share", TR: pctOrDash(tr.summary.overtimeShare), LV: pctOrDash(lv.summary.overtimeShare) },
    { label: "Output in pieces (never added across lines)", TR: trPieces || "—", LV: lvPanels },
    { label: "Output priced with standard hours", TR: pctOrDash(tr.pricedShare), LV: pctOrDash(lv.pricedShare) },
    { label: "Machine stops", TR: `${stopDurationLabel(tr.losses.unplannedH)} unplanned · machines up ${pctOrDash(tr.summary.availability)}`, LV: "recorded by department on shared machines — not separable" },
  ];

  return (
    <section className="space-y-3" aria-labelledby="plant-head">
      <PrintDecisions actions={actions} kind="intervention" />
      <div className="bg-surface border rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 no-print">
        <div className="min-w-0 me-auto">
          <h2 id="plant-head" className="font-bold leading-tight">Floor performance — whole plant</h2>
          <p className="text-xs text-muted mt-0.5">{range} · {dates.length} recorded day{dates.length === 1 ? "" : "s"} · the plant&apos;s figures from the two lines&apos; sums{tr.clamped || lv.clamped ? <span className="pill pill-warn ms-2">period adjusted</span> : null}</p>
        </div>
        <UrlDateSlicer encoding="fromTo" from={tr.fromISO} to={tr.toISO} min={addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1))} max={todayISO} today={todayISO} marks={dates} label="Period"
          presets={["yesterday", "thisWeek", "last14", "thisMonth", "lastMonth", "last30", "last90"]} defaultRange={defaultRange} />
      </div>
      <p className="print-only text-sm font-bold">Floor performance · whole plant · {range}</p>

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <StatTile hero label="Plant efficiency" value={pctOrDash(plant.efficiency)} meter={plant.efficiency === null ? undefined : Math.min(1, plant.efficiency)} sub={noDays ? "no recorded day" : `${fmt(plant.earnedH, 1)} std-h of ${fmt(plant.workedH, 1)} h booked — Σ earned ÷ Σ worked, both lines`} />
        <StatTile label="Standard hours earned" value={`${fmt(plant.earnedH, 1)} h`} sub={`TR ${fmt(tr.summary.earnedH, 1)} · LV ${fmt(lv.summary.earnedH, 1)}`} />
        <StatTile label="Man-hours booked" value={`${fmt(plant.workedH, 1)} h`} sub={`TR ${fmt(tr.summary.workedH, 1)} · LV ${fmt(lv.summary.workedH, 1)}`} />
        <StatTile label="Std-h a person a day" value={plant.stdPerPersonDay === null ? "—" : `${fmt(plant.stdPerPersonDay, 1)} h`} sub={`over ${plant.personDays} person-days`} />
        <StatTile label="Machine time lost" value={stopDurationLabel(tr.losses.unplannedH)} sub="unplanned stops, plant-wide — recorded by department, counted once" />
        <StatTile label="Machines up" value={pctOrDash(tr.summary.availability)} sub="of the machines' hours a day" />
      </div>
      {plant.notes.length > 0 && (
        <ul className="text-xs text-muted space-y-0.5" aria-label="Coverage">
          {plant.notes.map((n) => <li key={n}>⚠ {n}</li>)}
        </ul>
      )}

      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className="xl:col-span-7" title="The two lines side by side" sub="Each line's own figures over the same period. Standard hours, man-hours and people add up to the plant's; efficiency is the plant's sums' ratio; pieces are shown per line and never added."
          table={{ filename: `plant-production-${tr.fromISO}_${tr.toISO}.xlsx`, rows: rows.map((r) => ({ Figure: r.label, Transformers: r.TR, "LV panels": r.LV })) }}>
          <TableFrame className="!max-h-none">
            <table className="w-full text-sm">
              <thead><tr><Th label="" /><Th label={LINE_LABEL.TR} /><Th label={LINE_LABEL.LV} /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row" className="px-2 py-1.5 text-left font-semibold whitespace-nowrap align-top">{r.label}</th>
                    <td className="px-2 py-1.5 tabnum align-top">{r.TR}</td>
                    <td className="px-2 py-1.5 tabnum align-top">{r.LV}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
          <div className="flex flex-wrap gap-3 mt-3 text-sm">
            <Link href={dashHref("/dashboards/production", "TR", active, { from: tr.fromISO, to: tr.toISO })} className="text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">Transformers&apos; floor <ArrowRight size={13} aria-hidden /></Link>
            <Link href={dashHref("/dashboards/production", "LV", active, { from: tr.fromISO, to: tr.toISO })} className="text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">LV panels&apos; floor <ArrowRight size={13} aria-hidden /></Link>
            <Link href={dashHref("/", "all", active)} className="text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">The plant&apos;s planning <ArrowRight size={13} aria-hidden /></Link>
          </div>
        </ChartCard>
        <ChartCard className="xl:col-span-5" title="Needs intervention in production" sub="Both lines' interventions in one list, worst first, each tagged with its line.">
          <DecisionList actions={actions} nothing="Nothing pressing on the floor." />
        </ChartCard>
      </div>

      <ChartCard title="What did the plant turn out each day?" sub="Standard hours earned by each line against the man-hours both booked — one unit, so the lines stack. The shot-blast crew's hours are on the transformers' side, the panels' blasting included."
        table={noDays ? undefined : { filename: `plant-output-${tr.fromISO}_${tr.toISO}.xlsx`, rows: output.map((d) => ({ Day: d.dateISO, "TR h": Math.round(d.values.TR * 10) / 10, "LV h": Math.round(d.values.LV * 10) / 10, "Earned h": Math.round(d.earnedH * 10) / 10, "Booked h": Math.round(d.workedH * 10) / 10, "Efficiency %": d.efficiency === null ? "" : Math.round(d.efficiency * 100) })) }}>
        {output.length === 0 ? <EmptyState compact icon={Info} title="No shift day recorded in this period" hint="Pick a longer period, or record the attendance on Shifts." /> : <OutputChart days={output} groups={["TR", "LV"]} labels={LINE_LABEL} groupWord="line" />}
      </ChartCard>
    </section>
  );
}
