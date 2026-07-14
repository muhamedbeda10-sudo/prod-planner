import { getWeldingQueue } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { getReturnsFor } from "@/lib/server/returns";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { WeldingQueueTable } from "@/components/WeldingQueueTable";
import { PrintHeader } from "@/components/PrintHeader";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the queue (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function WeldWorklistPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [queue, notes, returns, settings] = await Promise.all([
    getWeldingQueue(today),
    getQueueNotes(),
    getReturnsFor("Welding"),
    getSettings(),
  ]);

  return (
    <>
      <PrintHeader title="Welding Worklist" date={toDisplayDate(today)} />
      <WeldingQueueTable rows={queue} day={dayISO} notes={notes} returns={returns} capacity={settings.capacityPerItem} />
    </>
  );
}
