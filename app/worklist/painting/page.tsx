import { getPaintingQueue } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { WeldingQueueTable } from "@/components/WeldingQueueTable";
import { PrintHeader } from "@/components/PrintHeader";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function PaintingWorklistPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [queue, notes, settings] = await Promise.all([getPaintingQueue(today), getQueueNotes(), getSettings()]);

  return (
    <>
      <PrintHeader title="Painting Worklist" date={toDisplayDate(today)} />
      <WeldingQueueTable rows={queue} day={dayISO} dept="Painting" upstream="Welded" notes={notes} capacity={settings.capacityPerItem} />
    </>
  );
}
