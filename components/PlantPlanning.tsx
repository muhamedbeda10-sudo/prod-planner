"use client";

import { ChartCard, StatTile, TONE_TEXT, fmt, pct, pctOrDash, signed } from "@/components/charts/kit";
import { DecisionList } from "@/components/CockpitDecisions";
import { TableFrame, Th } from "@/components/DataTable";
import type { CockpitAction } from "@/lib/domain/kpis";
import { LV_FLOOR_DEPT_LABEL } from "@/lib/domain/lvKpis";
import { WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import type { PlantPlanningSummary } from "@/lib/domain/plantKpis";
import type { CockpitData } from "@/lib/server/kpis";
import type { LvPlanningData } from "@/lib/server/lvKpis";

/** What the plant's figures need of each line — the page sends no more to the browser for them. */
export type PlantPlanningTr = Pick<CockpitData, "todayISO" | "week" | "manpower">;
export type PlantPlanningLv = Pick<LvPlanningData, "month" | "open" | "urgentStuck" | "manpower">;

// The plant's figures at the top of the Planning dashboard: each line's
// headline side by side, both lines' decisions in one list and who is needed
// where across the plant. The lines are planned differently — the
// transformers on dated weekly promises, the panels on a month with no
// delivery date — so plan progress is shown per line and never as one
// percentage; people add up (each line has its own departments), pieces
// never do. Each line's own cards follow in its section.

export function PlantPlanning({ tr, lv, floor, actions, summary }: { tr: PlantPlanningTr; lv: PlantPlanningLv; floor: boolean; actions: readonly CockpitAction[]; summary: PlantPlanningSummary }) {
  const finish = tr.week.adherence.find((a) => a.stage === "finish");
  // the people, both lines in one table and one export
  const peopleRows = [
    ...tr.manpower.rows.map((r) => ({ key: `TR-${r.centre}`, line: "TR", label: WORK_CENTRE_LABEL[r.centre], ...r })),
    ...lv.manpower.rows.map((r) => ({ key: `LV-${r.centre}`, line: "LV", label: LV_FLOOR_DEPT_LABEL[r.centre], ...r })),
  ];
  return (
    <div className="space-y-3">
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label="TR — plan delivered on its day" value={pctOrDash(finish?.rate)} meter={finish?.rate ?? undefined} sub={finish && finish.due > 0 ? `${finish.done} of ${finish.due} pcs due so far` : "nothing due yet"} />
        <StatTile label="TR — plan lines behind" value={String(tr.week.lateCount)} sub="past their stage date" />
        <StatTile hero label={`LV — ${lv.month.monthLabel} painted`} value={pctOrDash(lv.month.pace.doneShare)} meter={lv.month.pace.doneShare ?? undefined} sub={lv.month.panels > 0 ? `${lv.month.complete} of ${lv.month.panels} panels · even pace ${pct(lv.month.pace.expectedShare)}` : "no panels on the month's plan"} />
        <StatTile label="LV — urgent orders short" value={String(lv.urgentStuck.length)} sub={`of ${lv.open.urgent} urgent open`} />
        {floor && (
          <>
            <StatTile label="People short — plant" value={String(summary.peopleShort.total)} sub={`TR ${summary.peopleShort.TR} · LV ${summary.peopleShort.LV} — distinct departments, so they add`} />
            <StatTile label="Plant efficiency, lately" value={pctOrDash(summary.recentEfficiency.plant)} sub={`TR ${pctOrDash(summary.recentEfficiency.TR)} · LV ${pctOrDash(summary.recentEfficiency.LV)} — both lines' sums, last recorded days`} />
          </>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className={floor ? "xl:col-span-5" : "xl:col-span-12"} title="Needs a decision today" sub="Both lines' decisions in one list, worst first, each tagged with its line.">
          <DecisionList actions={actions} />
        </ChartCard>
        {floor && (
          <ChartCard className="xl:col-span-7" title="Who is needed where, from today" sub={`${tr.manpower.monthLabel}: the people each department needs on each remaining working day for what is left of the month's plan, against who comes on an average recorded day. Each line prices its own plan; the shot-blast crew is the transformers' and blasts the panels too.`}
            table={{ rows: peopleRows.map((r) => ({ Line: r.line, Department: r.label, "Needed from today": r.neededNow ?? "", Present: r.present ?? "", Gap: r.gap ?? "" })) }}>
            <TableFrame className="!max-h-[24rem]">
              <table className="w-full text-sm">
                <thead><tr><Th label="Line" /><Th label="Department" /><Th label="Needed from today" num className="text-right" /><Th label="Present" num className="text-right" /><Th label="Gap" num className="text-right" /></tr></thead>
                <tbody>
                  {peopleRows.map((r) => (
                    <tr key={r.key}>
                      <td className="px-2"><span className="pill pill-muted">{r.line}</span></td>
                      <td className="px-2 font-semibold whitespace-nowrap">{r.label}</td>
                      <td className="px-2 text-right tabnum">{r.neededNow === null ? "—" : fmt(r.neededNow, 1)}</td>
                      <td className="px-2 text-right tabnum">{r.present === null ? "—" : fmt(r.present, 1)}</td>
                      <td className={`px-2 text-right tabnum font-bold ${r.tone ? TONE_TEXT[r.tone] : ""}`}>{r.gap === null ? "—" : signed(r.gap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </ChartCard>
        )}
      </div>
    </div>
  );
}
