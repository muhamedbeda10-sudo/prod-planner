"use client";

import { ReturnsTable } from "@/components/ReturnsTable";
import { HeldOrdersStrip } from "@/components/HeldOrdersStrip";
import { MachineBoard } from "@/components/MachineBoard";
import { WeeklyPlanTrackerTable } from "@/components/WeeklyPlanTrackerTable";
import type { HeldOrderDTO } from "@/lib/domain/hold";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import type { ReturnRowDTO } from "@/lib/server/returns";
import type { WeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";

/** The fabrication page, top to bottom: the machines and the sheet jobs on
 *  them (typed with ✋ Add job — the sheets, and every project's part on
 *  them — and closed sheet by sheet), the orders on hold, the pieces Welding
 *  sent back, then the weekly plan measured at Fabrication: what each
 *  delivery day still needs cut, recorded straight on its cells. */
export function CutWorklistView({
  board,
  week,
  returns = [],
  held = [],
  canEdit = false,
  canManage = false,
}: {
  board?: MachineBoardData; // 🏭 the machines and their jobs — absent while machine planning is off
  week: WeeklyPlanTracker; // the weekly plan, day by day
  returns?: ReturnRowDTO[];
  held?: HeldOrderDTO[]; // ⏸ paused orders — not to be cut, named once
  canEdit?: boolean; // the Cut key: jobs, the machines' queues, recording cut pieces
  canManage?: boolean; // machines.manage — the board links to what it is priced with
}) {
  return (
    <>
      {/* 🏭 the machines: what each is cutting now, what waits, how loaded */}
      {board && <MachineBoard board={board} canEdit={canEdit} canManage={canManage} />}

      <HeldOrdersStrip rows={held} />

      {/* pieces sent back by Welding: fix first, they re-enter the flow */}
      <ReturnsTable rows={returns} dept="Cut" canEdit={canEdit} />

      {/* 📅 the week the jobs are cut against — Fabrication's column only */}
      <section className="mt-2">
        <h2>
          📅 Weekly plan — fabrication{week.planNo !== null ? ` · plan ${week.planNo}` : ""}
          <span className="ms-2 text-xs font-normal normal-case text-muted">
            What each delivery day still needs cut.{canEdit ? " Click a Fab cell to add the pieces cut." : ""}
          </span>
        </h2>
        <WeeklyPlanTrackerTable data={week} canRecord={canEdit} fabrication />
      </section>
    </>
  );
}
