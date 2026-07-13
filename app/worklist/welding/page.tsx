import { getWeldingQueue } from "@/lib/server/execution";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { WeldingQueueTable } from "@/components/WeldingQueueTable";
import { PrintHeader } from "@/components/PrintHeader";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function WeldWorklistPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [queue, notes] = await Promise.all([getWeldingQueue(today), getQueueNotes()]);

  return (
    <>
      <PrintHeader title="Welding Worklist" date={toDisplayDate(today)} />
      <WeldingQueueTable rows={queue} day={dayISO} notes={notes} />
    </>
  );
}
