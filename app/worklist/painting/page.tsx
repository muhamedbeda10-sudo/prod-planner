import { PageHead } from "@/components/ui";
import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { getSoiLookup } from "@/lib/server/soi";
import { getPaintingQueue } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { getWorklistExtras, getRunOrderLines, pushedAsCascadeRows } from "@/lib/server/worklistExtras";
import { getPaintableTanks } from "@/lib/server/tanks";
import { getWorkersFor } from "@/lib/server/workers";
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
import { LineSwitch } from "@/components/LineSwitch";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function PaintingWorklistPage() {
  await guardTab("/worklist/painting");
  // the panels have their own painting worklist — same route, the line on screen decides
  if ((await getActiveLine()) === "LV") return <LvWorklistPage stage="Painting" />;
  // the factory's day (Cairo), not the server's UTC date: the night shift
  // records after midnight, and its rows belong to the day it works
  const today = factoryToday();
  const dayISO = toISODate(today);
  const [queue, notes, settings, user, extras, runOrder, tanksByMo, painters, soi] = await Promise.all([
    getPaintingQueue(today),
    getQueueNotes(),
    getSettings(),
    getCurrentUser(),
    getWorklistExtras("Painting"),
    getRunOrderLines("Painting"),
    getPaintableTanks(),
    getWorkersFor("Painting"),
    getSoiLookup(),
  ]);
  const canEdit = !!user && canEditDept(user, "Painting");
  const tankTracking = settings.tankTracking;
  const isAdmin = !!user?.isAdmin;
  const canManage = !!user && hasPerm(user, "machines.manage");
  // tracker-pushed lines render on the shared date-less table shape
  const pushedRows = pushedAsCascadeRows(extras.pushed);
  // the paint lines' board: what is ready to paint on each line
  // the machine board only while the plant plans by machine (Settings); a
  // line both in the queue and pushed from the tracker is one line on it
  const board = settings.machinePlanning ? await getMachineBoard("Painting", queueBoardLines(queue, extras.pushed), dayISO) : null;
  const machines = board?.machines ?? [];
  const assigned = board?.assigned ?? {};

  return (
    <>
      <PrintHeader title="Painting Worklist" date={formatDate(today)} />
      <PageHead title="Painting Worklist" sub={formatDate(today)} />
      <WeldingQueueTable
        lineSwitch={<LineSwitch />}
        soi={soi}
        rows={queue}
        day={dayISO}
        dept="Painting"
        upstream="Welded"
        notes={notes}
        capacity={settings.capacityPerItem}
        canEdit={canEdit}
        isAdmin={isAdmin}
        workers={tankTracking ? painters : []}
        paintableTanks={tankTracking ? Object.fromEntries(tanksByMo) : {}}
        tankTracking={tankTracking}
        machines={machines}
        assigned={assigned}
        before={
          <>
            {/* The barcode sheet is a print job for tanks that finished here —
                a button where the work ends, not a tab of its own. */}
            {tankTracking && (
              <div className="no-print mb-3">
                <Link href="/barcode" className="btn btn-secondary btn-sm">🏷 Tank barcodes</Link>
              </div>
            )}
            {board && <MachineBoard board={board} canEdit={canEdit} canManage={canManage} />}
            <RunOrderTable rows={runOrder} deptWord="paint" />
            <HeldOrdersStrip rows={extras.held} />
            <PriorityOrdersTable rows={extras.priority} deptWord="painted" soi={soi} />
            {pushedRows.length > 0 && (
              <section className="mb-6">
                <h2>📥 Sent from the Plan Tracker ({pushedRows.reduce((s, r) => s + r.available, 0)} pcs)</h2>
                <CascadeTable rows={pushedRows} day={dayISO} planNo={0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} dept="Painting" allowDate={false} machines={machines} assigned={assigned} />
              </section>
            )}
          </>
        }
        after={isAdmin ? <HiddenLinesPanel key="hidden" rows={extras.hidden} /> : undefined}
      />
    </>
  );
}
