"use client";

import { ChartCard, NO_BASE, StatTile, TONE_TEXT, fmt, pct, pctOrDash, signed } from "@/components/charts/kit";
import { TableFrame, Th } from "@/components/DataTable";
import { DetailModal, PeopleDetail, cols, useDetail } from "@/components/PlanningParts";
import type { ManpowerRow, StageAdherence } from "@/lib/domain/kpis";
import { LV_FLOOR_DEPT_LABEL, type LvFloorDept } from "@/lib/domain/lvKpis";
import { WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import { plantTotals, planningUrl, type PlanningFilters } from "@/lib/domain/planningDashboard";

/** What the plant's figures need of each line — the page sends no more to the browser for them. */
export interface PlantPlanningTr {
  monthLabel: string;
  planNo: number | null;
  finish: StageAdherence | null;
  lateCount: number;
  people: { rows: ManpowerRow[]; toAdd: number | null };
}
export interface PlantPlanningLv {
  monthLabel: string;
  panels: number;
  complete: number;
  doneShare: number | null;
  expectedShare: number;
  urgentShort: number;
  urgentOpen: number;
  people: { rows: ManpowerRow<LvFloorDept>[]; toAdd: number | null };
}

// The plant's figures at the top of the Planning dashboard under "All": each
// line's headline on its own — the transformers on dated weekly promises, the
// panels on a month with no delivery date, so plan progress is never one
// percentage — then what adds up (plantTotals): the standard hours left on
// the month's plans and the people each department needs (each line has its
// own departments). Pieces never add. Each line's own cards follow in its
// section; both lines' decisions are behind the bar's Decisions button.

export function PlantPlanning({ tr, lv, f, floor }: { tr: PlantPlanningTr; lv: PlantPlanningLv; f: PlanningFilters; floor: boolean }) {
  const { detail, open } = useDetail();
  const rows = [
    ...tr.people.rows.map((r) => ({ key: `TR-${r.centre}`, line: "TR", label: WORK_CENTRE_LABEL[r.centre], ...r })),
    ...lv.people.rows.map((r) => ({ key: `LV-${r.centre}`, line: "LV", label: LV_FLOOR_DEPT_LABEL[r.centre], ...r })),
  ];
  const plant = plantTotals(tr, lv);
  const scoped = f.centre || f.lvDept ? " (the departments the filters keep)" : "";
  const peopleCols = ["Line", "Department", "Left h", "Needed from today", ...(floor ? ["Present", "Gap"] : [])];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label="TR — plan on its date" value={pctOrDash(tr.finish?.rate)} meter={tr.finish?.rate ?? undefined} href={planningUrl(f, { scope: "tr", detail: "tr-ontime" })}
          sub={tr.finish && tr.finish.due > 0 ? `${tr.finish.done} of ${tr.finish.due} pcs · plan ${tr.planNo ?? "—"}` : "nothing due yet"}
          about="Of the transformers' weekly plan pieces due finished by today, the share finished. The transformers' own measure — never combined with the panels'." />
        <StatTile label="TR — lines behind" value={fmt(tr.lateCount)} href={planningUrl(f, { scope: "tr", detail: "tr-behind" })} sub="past a stage date" about="Weekly plan lines past their stage date (oven date less the lead days in Settings)." />
        <StatTile hero label={`LV — ${lv.monthLabel} painted`} value={pctOrDash(lv.doneShare)} meter={lv.doneShare ?? undefined} href={planningUrl(f, { scope: "lv", detail: "lv-pace" })}
          sub={lv.panels > 0 ? `${fmt(lv.complete)} of ${fmt(lv.panels)} · even pace ${pct(lv.expectedShare)}` : "no panel planned"}
          about="Panels of the month's plan painted, against an even pace through its working days. The panels' own measure — never combined with the transformers'." />
        <StatTile label="LV — urgent orders short" value={fmt(lv.urgentShort)} href={planningUrl(f, { scope: "lv", detail: "lv-urgent" })} sub={`of ${lv.urgentOpen} urgent open`} about="Urgent open panel orders with panels still to paint, not on hold." />
        <StatTile label="Std-h left this month" value={`${fmt(plant.hoursLeft.total, 1)} h`} {...open("all-hours")} sub={`TR ${fmt(plant.hoursLeft.TR, 1)} · LV ${fmt(plant.hoursLeft.LV, 1)}`} delta={NO_BASE}
          about={`Standard hours still to work on the two lines' plans for the month${scoped}, each line priced by its own sheet — hours add across the lines, pieces never do. Orders without hours a piece ask none.`} />
        {floor && (
          <StatTile label="People to add — plant" value={plant.toAdd.total === null ? "—" : fmt(plant.toAdd.total)} {...open("all-people")} sub={`TR ${plant.toAdd.TR ?? "—"} · LV ${plant.toAdd.LV ?? "—"}`} delta={NO_BASE}
            about={`People short to finish the month's plans from today${scoped}: each line's own departments, distinct, so they add. No overtime assumed.`} />
        )}
      </div>

      <ChartCard title="Who is needed where, from today"
        about={`${tr.monthLabel}: the std-hours left in each department of both lines and the people that needs on each remaining working day${floor ? ", against who comes on an average recorded day" : ""}. Each line prices its own plan; the shot-blast crew is the transformers' and blasts the panels too.`}
        data={rows.map((r) => ({ Line: r.line, Department: r.label, "Left h": r.leftH, "Needed from today": r.neededNow ?? "", ...(floor ? { Present: r.present ?? "", Gap: r.gap ?? "" } : {}) }))}>
        <TableFrame className="!max-h-[24rem]">
          <table className="w-full text-sm">
            <thead><tr>{peopleCols.map((c, i) => <Th key={c} label={c} num={i > 1} className={i > 1 ? "text-right" : ""} />)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-2"><span className="pill pill-muted">{r.line}</span></td>
                  <td className="px-2 font-semibold whitespace-nowrap">{r.label}</td>
                  <td className="px-2 text-right tabnum">{fmt(r.leftH, 1)}</td>
                  <td className="px-2 text-right tabnum">{r.neededNow === null ? "—" : fmt(r.neededNow, 1)}</td>
                  {floor && <td className="px-2 text-right tabnum">{r.present === null ? "—" : fmt(r.present, 1)}</td>}
                  {floor && <td className={`px-2 text-right tabnum font-bold ${r.tone ? TONE_TEXT[r.tone] : ""}`}>{r.gap === null ? "—" : signed(r.gap)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      </ChartCard>

      {detail === "all-hours" && (
        <DetailModal title="Std-h left this month — both lines" sub="Each department's hours left on its line's month plan; the total is the tile's"
          columns={cols("Line", "Department", ["Plan h", true], ["Done h", true], ["Left h", true])}
          rows={rows.map((r) => [r.line, r.label, fmt(r.requiredH, 1), fmt(r.doneH, 1), fmt(r.leftH, 1)])}
          total={["Total", "", "", "", fmt(plant.hoursLeft.total, 1)]} />
      )}
      {detail === "all-people" && floor && (
        <PeopleDetail title="People to add — plant" sub="Each line's departments short by half a person or more, from today" rows={rows} toAdd={plant.toAdd.total} />
      )}
    </div>
  );
}
