import { getWeldingQueue } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { getReturnsFor } from "@/lib/server/returns";
import { getWorklistExtras, getRunOrderLines } from "@/lib/server/worklistExtras";
import { getRepairQueue } from "@/lib/server/tanks";
import { getWorkersFor } from "@/lib/server/workers";
import { TankRepairPanel } from "@/components/TankRepairPanel";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { WeldingQueueTable } from "@/components/WeldingQueueTable";
import { CascadeTable } from "@/components/CascadeTable";
import { PriorityOrdersTable } from "@/components/PriorityOrdersTable";
import { RunOrderTable } from "@/components/RunOrderTable";
import { HiddenLinesPanel } from "@/components/HiddenLinesPanel";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function WeldWorklistPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [queue, notes, returns, settings, user, extras, runOrder, repairs, welders] = await Promise.all([
    getWeldingQueue(today),
    getQueueNotes(),
    getReturnsFor("Welding"),
    getSettings(),
    getCurrentUser(),
    getWorklistExtras("Welding"),
    getRunOrderLines("Welding"),
    getRepairQueue(),
    getWorkersFor("Welding"),
  ]);
  const canEdit = !!user && canEditDept(user, "Welding");
  const tankTracking = settings.tankTracking;
  const isAdmin = !!user?.isAdmin;
  // tracker-pushed lines render on the shared date-less table shape
  const pushedRows = extras.pushed.map((p) => ({
    bom: p.bom, mo: p.mo, description: p.description, item: p.item,
    target: p.orderQty, scheduled: 0, done: p.done, available: p.qty, deliveryISO: null,
  }));

  return (
    <>
      <PrintHeader title="Welding Worklist" date={toDisplayDate(today)} />
      <WeldingQueueTable
        rows={queue}
        day={dayISO}
        notes={notes}
        returns={returns}
        capacity={settings.capacityPerItem}
        canEdit={canEdit}
        isAdmin={isAdmin}
        workers={tankTracking ? welders : []}
        tankTracking={tankTracking}
        before={
          <>
            {tankTracking && canEdit && <TankRepairPanel tanks={repairs} welders={welders} />}
            <RunOrderTable rows={runOrder} deptWord="weld" />
            <PriorityOrdersTable rows={extras.priority} deptWord="welded" />
            {pushedRows.length > 0 && (
              <section className="mb-6">
                <h2>📥 Sent from the Plan Tracker ({pushedRows.reduce((s, r) => s + r.available, 0)} pcs)</h2>
                <CascadeTable rows={pushedRows} day={dayISO} planNo={0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} dept="Welding" allowDate={false} />
              </section>
            )}
          </>
        }
        after={isAdmin ? <HiddenLinesPanel rows={extras.hidden} /> : undefined}
      />
    </>
  );
}
