import { getPaintingQueue } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { getWorklistExtras } from "@/lib/server/worklistExtras";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { WeldingQueueTable } from "@/components/WeldingQueueTable";
import { WorklistDeptTabs } from "@/components/WorklistDeptTabs";
import { CascadeTable } from "@/components/CascadeTable";
import { PriorityOrdersTable } from "@/components/PriorityOrdersTable";
import { HiddenLinesPanel } from "@/components/HiddenLinesPanel";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function PaintingWorklistPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [queue, notes, settings, user, extras] = await Promise.all([
    getPaintingQueue(today),
    getQueueNotes(),
    getSettings(),
    getCurrentUser(),
    getWorklistExtras("Painting"),
  ]);
  const canEdit = !!user && canEditDept(user, "Painting");
  const isAdmin = !!user?.isAdmin;
  // tracker-pushed lines render on the shared date-less table shape
  const pushedRows = extras.pushed.map((p) => ({
    bom: p.bom, mo: p.mo, description: p.description, item: p.item,
    target: p.orderQty, scheduled: 0, done: p.done, available: p.qty, deliveryISO: null,
  }));

  return (
    <>
      <PrintHeader title="Painting Worklist" date={toDisplayDate(today)} />
      <WorklistDeptTabs current="painting" />
      <PriorityOrdersTable rows={extras.priority} deptWord="painted" />
      {pushedRows.length > 0 && (
        <section className="mb-6">
          <h2>📥 Sent from the Plan Tracker ({pushedRows.reduce((s, r) => s + r.available, 0)} pcs)</h2>
          <CascadeTable rows={pushedRows} day={dayISO} planNo={0} hideFilter notes={notes} canEdit={canEdit} isAdmin={isAdmin} dept="Painting" allowDate={false} />
        </section>
      )}
      <WeldingQueueTable rows={queue} day={dayISO} dept="Painting" upstream="Welded" notes={notes} capacity={settings.capacityPerItem} canEdit={canEdit} isAdmin={isAdmin} />
      {isAdmin && <HiddenLinesPanel rows={extras.hidden} />}
    </>
  );
}
