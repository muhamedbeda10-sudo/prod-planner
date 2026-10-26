import { PageHead } from "@/components/ui";
import { formatDate } from "@/lib/domain/format";
import { getSoiLookup } from "@/lib/server/soi";
import { getWeldingQueue } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { getReturnsFor } from "@/lib/server/returns";
import { getWorklistExtras, getRunOrderLines, pushedAsCascadeRows } from "@/lib/server/worklistExtras";
import { getRepairQueue } from "@/lib/server/tanks";
import { getWorkersFor } from "@/lib/server/workers";
import { TankRepairPanel } from "@/components/TankRepairPanel";
import { factoryToday, toISODate } from "@/lib/domain/dates";
import { WeldingQueueTable } from "@/components/WeldingQueueTable";
import { CascadeTable } from "@/components/CascadeTable";
import { PriorityOrdersTable } from "@/components/PriorityOrdersTable";
import { HeldOrdersStrip } from "@/components/HeldOrdersStrip";
import { RunOrderTable } from "@/components/RunOrderTable";
import { HiddenLinesPanel } from "@/components/HiddenLinesPanel";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept, hasPerm, guardTab } from "@/lib/server/auth";
import { getMachineBoard, queueBoardLines } from "@/lib/server/machineBoard";
import { MachineBoard } from "@/components/MachineBoard";

export const dynamic = "force-dynamic";
import { getActiveLine } from "@/lib/server/line";
import { LvWorklistPage } from "@/components/LvWorklistPage";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function WeldWorklistPage() {
  await guardTab("/worklist/welding");
  // the panels have their own welding worklist — same route, the line on screen decides
  if ((await getActiveLine()) === "LV") return <LvWorklistPage stage="Welding" />;
  // the factory's day (Cairo), not the server's UTC date: the night shift
  // records after midnight, and its rows belong to the day it works
  const today = factoryToday();
  const dayISO = toISODate(today);
  const [queue, notes, returns, settings, user, extras, runOrder, repairs, welders, soi] = await Promise.all([
    getWeldingQueue(today),
    getQueueNotes(),
    getReturnsFor("Welding"),
    getSettings(),
    getCurrentUser(),
    getWorklistExtras("Welding"),
    getRunOrderLines("Welding"),
    getRepairQueue(),
    getWorkersFor("Welding"),
    getSoiLookup(),
  ]);
  const canEdit = !!user && canEditDept(user, "Welding");
  const tankTracking = settings.tankTracking;
  const isAdmin = !!user?.isAdmin;
  const canManage = !!user && hasPerm(user, "machines.manage");
  // tracker-pushed lines render on the shared date-less table shape
  const pushedRows = pushedAsCascadeRows(extras.pushed);
  // the bay's partitions: which group of welders is on what
  // the machine board only while the plant plans by machine (Settings); a
  // line both in the queue and pushed from the tracker is one line on it
  const board = settings.machinePlanning ? await getMachineBoard("Welding", queueBoardLines(queue, extras.pushed), dayISO) : null;
  const machines = board?.machines ?? [];
  const assigned = board?.assigned ?? {};

  return (
    <>
      <PrintHeader title="Welding Worklist" date={formatDate(today)} />
      <PageHead title="Welding Worklist" sub={formatDate(today)} />
      <WeldingQueueTable
        soi={soi}
        rows={queue}
        day={dayISO}
        notes={notes}
        returns={returns}
        capacity={settings.capacityPerItem}
        canEdit={canEdit}
        isAdmin={isAdmin}
        workers={tankTracking ? welders : []}
        tankTracking={tankTracking}
        machines={machines}
        assigned={assigned}
        before={
          <>
            {tankTracking && canEdit && <TankRepairPanel tanks={repairs} welders={welders} />}
            {board && <MachineBoard board={board} canEdit={canEdit} canManage={canManage} />}
            <RunOrderTable rows={runOrder} deptWord="weld" />
            <HeldOrdersStrip rows={extras.held} />
            <PriorityOrdersTable rows={extras.priority} deptWord="welded" soi={soi} />
            {pushedRows.length > 0 && (
              <section className="mb-6">
                <h2>📥 Sent from the Plan Tracker ({pushedRows.reduce((s, r) => s + r.available, 0)} pcs)</h2>
                <CascadeTable rows={pushedRows} day={dayISO} planNo={0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} dept="Welding" allowDate={false} machines={machines} assigned={assigned} />
              </section>
            )}
          </>
        }
        after={isAdmin ? <HiddenLinesPanel key="hidden" rows={extras.hidden} /> : undefined}
      />
    </>
  );
}
