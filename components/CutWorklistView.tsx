"use client";

import { ReturnsTable } from "@/components/ReturnsTable";
import { HeldOrdersStrip } from "@/components/HeldOrdersStrip";
import { MachineBoard } from "@/components/MachineBoard";
import { PriorityOrdersTable } from "@/components/PriorityOrdersTable";
import { CascadeTable } from "@/components/CascadeTable";
import { HiddenLinesPanel } from "@/components/HiddenLinesPanel";
import { WeeklyPlanTrackerTable } from "@/components/WeeklyPlanTrackerTable";
import type { CascadeRow } from "@/lib/domain/execution";
import type { HeldOrderDTO } from "@/lib/domain/hold";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import type { ReturnRowDTO } from "@/lib/server/returns";
import type { SoiLookup } from "@/lib/server/soi";
import type { WeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import type { HiddenLineDTO, PriorityLineDTO } from "@/lib/server/worklistExtras";

/** The fabrication page, top to bottom: the machines and the sheet jobs on
 *  them (typed with ✋ Add job — the sheets, and every project's part on
 *  them — and closed sheet by sheet), the orders on hold, the planner's
 *  layers on the plan (⭐ priority orders to cut first, and the lines the
 *  Plan Tracker sent here date-less — recorded straight on their rows), the
 *  pieces Welding sent back, then the weekly plan measured at Fabrication:
 *  what each delivery day still needs cut, recorded straight on its cells.
 *  An admin's removed lines wait, restorable, at the very bottom. */
export function CutWorklistView({
  board,
  week,
  day,
  returns = [],
  held = [],
  priority = [],
  pushed = [],
  hidden = [],
  notes = {},
  soi,
  canEdit = false,
  isAdmin = false,
  canManage = false,
}: {
  board?: MachineBoardData; // 🏭 the machines and their jobs — absent while machine planning is off
  week: WeeklyPlanTracker; // the weekly plan, day by day
  day: string; // the factory's day (ISO) the pushed rows record on
  returns?: ReturnRowDTO[];
  held?: HeldOrderDTO[]; // ⏸ paused orders — not to be cut, named once
  priority?: PriorityLineDTO[]; // ⭐ what Fabrication still owes on the priority orders
  pushed?: CascadeRow[]; // 📥 the date-less lines the Plan Tracker sent to Cut
  hidden?: HiddenLineDTO[]; // 🗑 lines an admin removed from this worklist (restorable)
  notes?: Record<string, QueueNoteDTO[]>; // keyed by bom|mo|item — the pushed rows' notes
  soi?: SoiLookup;
  canEdit?: boolean; // the Cut key: jobs, the machines' queues, recording cut pieces
  isAdmin?: boolean; // admins may remove a pushed line, and see the removed ones
  canManage?: boolean; // machines.manage — the board links to what it is priced with
}) {
  const pushedTotal = pushed.reduce((s, r) => s + r.available, 0);
  return (
    <>
      {/* 🏭 the machines: what each is cutting now, what waits, how loaded */}
      {board && <MachineBoard board={board} canEdit={canEdit} canManage={canManage} />}

      <HeldOrdersStrip rows={held} />

      {/* ⭐ the admin's priority orders — the same table on top of every dept worklist */}
      <PriorityOrdersTable rows={priority} deptWord="cut" soi={soi} />

      {/* 📥 what the Plan Tracker sent here date-less: recorded on the row
          itself (against Cut), and the pushed quantity shrinks with every
          piece recorded since the push. The Cut machines carry sheet jobs,
          not plan lines, so these rows take no machine picker. */}
      {pushed.length > 0 && (
        <section className="mb-6">
          <h2>📥 Sent from the Plan Tracker ({pushedTotal} pcs)</h2>
          <CascadeTable rows={pushed} day={day} planNo={0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} dept="Cut" allowDate={false} />
        </section>
      )}

      {/* pieces sent back by Welding: fix first, they re-enter the flow */}
      <ReturnsTable rows={returns} dept="Cut" canEdit={canEdit} />

      {/* 📅 the week the jobs are cut against — Fabrication's column only */}
      <section className="mt-2">
        <h2>
          📅 Weekly plan — fabrication{week.planNo !== null ? ` · plan ${week.planNo}` : ""}
          <span className="explain ms-2 text-xs font-normal normal-case text-muted">
            What each delivery day still needs cut.{canEdit ? " Click a Fab cell to add the pieces cut." : ""}
          </span>
        </h2>
        <WeeklyPlanTrackerTable data={week} canRecord={canEdit} fabrication />
      </section>

      {/* 🗑 admin only — the lines removed from this worklist, one click to restore */}
      {isAdmin && <HiddenLinesPanel rows={hidden} />}
    </>
  );
}
