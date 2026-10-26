"use client";

import { Info } from "lucide-react";
import { ChartCard, StatTile, fmt, pctOrDash } from "@/components/charts/kit";
import { DecisionList } from "@/components/CockpitDecisions";
import { OutputChart } from "@/components/LazyCharts";
import { OutputByType } from "@/components/OutputByType";
import { EmptyState } from "@/components/primitives";
import { slicerRangeLabel } from "@/lib/domain/dateSlicer";
import { stopDurationLabel } from "@/lib/domain/downtime";
import type { CockpitAction } from "@/lib/domain/kpis";
import { LINE_LABEL } from "@/lib/domain/lines";
import { linePart, plantDailyOutput, plantEfficiency } from "@/lib/domain/plantKpis";
import type { FloorPeriod } from "@/lib/server/kpis";
import type { LvFloorPeriod } from "@/lib/server/lvKpis";

/** What the plant's figures need of each line — the page sends no more to the browser for them. */
export type PlantProductionTr = Pick<FloorPeriod, "fromISO" | "toISO" | "summary" | "output" | "losses" | "pricedShare" | "byType">;
export type PlantProductionLv = Pick<LvFloorPeriod, "summary" | "output" | "pricedShare" | "byType">;

// The plant's figures at the top of the Production dashboard, over the
// page's period: the plant's efficiency from the two lines' SUMS (never the
// mean of their rates), its standard hours and man-hours added, what was
// made item by item against the month's plan, both lines' interventions in
// one list and the output day by day. The machines' stops are recorded by
// department on shared machines, so they are the plant's, counted once;
// pieces are shown per line and per item and never added across them. Each
// line's own figures follow in its section.

export function PlantProduction({ tr, lv, actions }: { tr: PlantProductionTr; lv: PlantProductionLv; actions: readonly CockpitAction[] }) {
  const plant = plantEfficiency([linePart("TR", tr), linePart("LV", lv)]);
  const range = slicerRangeLabel(tr.fromISO, tr.toISO);
  // each line's earned hours per day, side by side; the man-hours added (the domain's rule)
  const output = plantDailyOutput(tr.output, lv.output);
  const noDays = output.length === 0;

  return (
    <section className="space-y-3" aria-label="The whole plant">
      <p className="print-only text-sm font-bold">The whole plant · {range}</p>

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <StatTile hero label="Plant efficiency" value={pctOrDash(plant.efficiency)} meter={plant.efficiency === null ? undefined : Math.min(1, plant.efficiency)} sub={noDays ? "no recorded day" : `${fmt(plant.earnedH, 1)} std-h of ${fmt(plant.workedH, 1)} h`} about="Both lines' standard hours earned ÷ both lines' man-hours booked over the period — never the mean of the two rates." />
        <StatTile label="Transformers' efficiency" value={pctOrDash(tr.summary.efficiency)} sub={`${fmt(tr.summary.earnedH, 1)} std-h of ${fmt(tr.summary.workedH, 1)} h`} />
        <StatTile label="LV panels' efficiency" value={pctOrDash(lv.summary.efficiency)} sub={`${fmt(lv.summary.earnedH, 1)} std-h of ${fmt(lv.summary.workedH, 1)} h`} />
        <StatTile label="Std-h a person a day" value={plant.stdPerPersonDay === null ? "—" : `${fmt(plant.stdPerPersonDay, 1)} h`} sub={`over ${plant.personDays} person-days`} about="Standard hours one person turned out on a recorded day, both lines together." />
        <StatTile label="Machine time lost" value={stopDurationLabel(tr.losses.unplannedH)} about="Unplanned stops, plant-wide — recorded on the machine by department, counted once." />
        <StatTile label="Machines up" value={pctOrDash(tr.summary.availability)} about="The share of the machines' hours a day they were up." />
      </div>
      {plant.notes.length > 0 && (
        <ul className="text-xs text-muted space-y-0.5" aria-label="Coverage">
          {plant.notes.map((n) => <li key={n}>⚠ {n}</li>)}
        </ul>
      )}

      <OutputByType tr={tr.byType} lv={lv.byType} range={range} />

      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className="xl:col-span-5" title="Needs intervention in production" about="Both lines' interventions in one list, worst first, each tagged with its line.">
          <DecisionList actions={actions} nothing="Nothing pressing on the floor." />
        </ChartCard>
        <ChartCard className="xl:col-span-7" title="What did the plant turn out each day?" about="Standard hours earned by each line against the man-hours both booked — one unit, so the lines stack. The shot-blast crew's hours are on the transformers' side, the panels' blasting included."
          data={noDays ? undefined : output.map((d) => ({ Day: d.dateISO, "TR h": Math.round(d.values.TR * 10) / 10, "LV h": Math.round(d.values.LV * 10) / 10, "Earned h": Math.round(d.earnedH * 10) / 10, "Booked h": Math.round(d.workedH * 10) / 10, "Efficiency %": d.efficiency === null ? "" : Math.round(d.efficiency * 100) }))}>
          {noDays ? <EmptyState compact icon={Info} title="No shift day recorded in this period" hint="Pick a longer period, or record the attendance on Shifts." /> : <OutputChart days={output} groups={["TR", "LV"]} labels={LINE_LABEL} groupWord="line" />}
        </ChartCard>
      </div>
    </section>
  );
}
