"use client";

import { NO_BASE, StatTile, fmt } from "@/components/charts/kit";
import { DetailModal, PeopleDetail, cols, useDetail } from "@/components/PlanningParts";
import type { ManpowerRow } from "@/lib/domain/kpis";
import { LV_FLOOR_DEPT_LABEL, type LvFloorDept } from "@/lib/domain/lvKpis";
import { WORK_CENTRE_LABEL, type WorkCentre } from "@/lib/domain/shifts";
import { plantTotals } from "@/lib/domain/planningDashboard";

/** What the plant's totals need of each line — the page sends no more to the browser for them. */
export interface PlantPlanningLine<C extends string = string> {
  people: { rows: ManpowerRow<C>[]; toAdd: number | null };
}

// The plant's totals at the top of the dashboard under "All" — only what adds
// up across the lines (plantTotals): the standard hours left on the month's
// plans and the people the departments need (each line has its own
// departments). Each line's own headline follows in its section, so it is not
// said twice here; both lines' decisions are behind the bar's Decisions button.

export function PlantPlanning({ monthLabel, tr, lv, floor }: { monthLabel: string; tr: PlantPlanningLine<WorkCentre>; lv: PlantPlanningLine<LvFloorDept>; floor: boolean }) {
  const { detail, open } = useDetail();
  const rows = [
    ...tr.people.rows.map((r) => ({ key: `TR-${r.centre}`, line: "TR", label: WORK_CENTRE_LABEL[r.centre], ...r })),
    ...lv.people.rows.map((r) => ({ key: `LV-${r.centre}`, line: "LV", label: LV_FLOOR_DEPT_LABEL[r.centre], ...r })),
  ];
  const plant = plantTotals(tr, lv);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile label="Std-h left this month — plant" value={`${fmt(plant.hoursLeft.total, 1)} h`} {...open("all-hours")} sub={`TR ${fmt(plant.hoursLeft.TR, 1)} · LV ${fmt(plant.hoursLeft.LV, 1)}`} delta={NO_BASE}
          about={`Standard hours still to work on the two lines' plans for the month (${monthLabel}), each line priced by its own sheet — hours add across the lines, pieces never do. Orders without hours a piece ask none. Opens each department's hours.`} />
        {floor && (
          <StatTile label="People to add — plant" value={plant.toAdd.total === null ? "—" : fmt(plant.toAdd.total)} {...open("all-people")} sub={`TR ${plant.toAdd.TR ?? "—"} · LV ${plant.toAdd.LV ?? "—"}`} delta={NO_BASE}
            about={`People short to finish the month's plans from today: each line's own departments, distinct, so they add. No overtime assumed. Opens who is needed where.`} />
        )}
      </div>

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
