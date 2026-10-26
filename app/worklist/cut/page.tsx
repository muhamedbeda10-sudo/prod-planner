import { PageHead } from "@/components/ui";
import { formatDate } from "@/lib/domain/format";
import { getSettings } from "@/lib/server/data";
import { getReturnsFor } from "@/lib/server/returns";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { getSoiLookup } from "@/lib/server/soi";
import { getWorklistExtras, pushedAsCascadeRows } from "@/lib/server/worklistExtras";
import { factoryDayISO } from "@/lib/domain/dates";
import { CutWorklistView } from "@/components/CutWorklistView";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept, hasPerm, guardTab } from "@/lib/server/auth";
import { getMachineBoard } from "@/lib/server/machineBoard";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";

export const dynamic = "force-dynamic";

// The fabrication page: the machines and the SHEET JOBS on them (sheets of
// one thickness carrying the parts of several projects, closed sheet by
// sheet), the planner's layers on top of the plan (⭐ priority orders and the
// lines the Plan Tracker sent here date-less), then the weekly plan measured
// at Fabrication — what the jobs are cut against, and where the cut pieces
// are recorded. The PrintHeader appears only on the printed/PDF sheet.
export default async function CutWorklistPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  await guardTab("/worklist/cut");
  const sp = await searchParams;
  // a panel is not cut on the lasers — its fabrication is punching, then
  // bending: this worklist is the transformers' alone (PINNED_LINE)
  const dayISO = factoryDayISO(new Date());
  // an unknown ?plan= falls back to the newest plan inside the loader
  const [returns, settings, user, week, extras, notes, soi] = await Promise.all([
    getReturnsFor("Cut"),
    getSettings(),
    getCurrentUser(),
    getWeeklyPlanTracker(Number(sp.plan) || null),
    getWorklistExtras("Cut"),
    getQueueNotes(),
    getSoiLookup(),
  ]);
  const canEdit = !!user && canEditDept(user, "Cut");
  const isAdmin = !!user?.isAdmin;
  // tracker-pushed lines render on the shared date-less table shape — the
  // same rows the welding and painting pages show for their pushes
  const pushedRows = pushedAsCascadeRows(extras.pushed);
  // the machine board only while the plant plans by machine (Settings); the
  // fabrication machines carry the jobs alone — no plan line of its own
  const board = settings.machinePlanning ? await getMachineBoard("Cut", [], dayISO, week.planNo ?? 0) : undefined;

  return (
    <>
      <PrintHeader title="Fabrication Worklist" subtitle={week.planNo === null ? undefined : `Weekly plan ${week.planNo}`} date={formatDate(dayISO)} />
      <PageHead title="Fabrication Worklist" sub={`Transformers · ${formatDate(dayISO)}`} />
      <CutWorklistView
        board={board}
        week={week}
        day={dayISO}
        returns={returns}
        held={extras.held}
        priority={extras.priority}
        pushed={pushedRows}
        hidden={extras.hidden}
        notes={notes}
        soi={soi}
        canEdit={canEdit}
        isAdmin={isAdmin}
        canManage={!!user && hasPerm(user, "machines.manage")}
      />
    </>
  );
}
