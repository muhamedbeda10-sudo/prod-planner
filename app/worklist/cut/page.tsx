import { getCutSheet } from "@/lib/server/execution";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { CutWorklistView } from "@/components/CutWorklistView";
import { PrintHeader } from "@/components/PrintHeader";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the work (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function CutWorklistPage() {
  const { planNo, today, dueNow, overdue, cascade } = await getCutSheet();
  const dayISO = toISODate(today);

  return (
    <>
      <PrintHeader title="Cut Worklist" date={toDisplayDate(today)} />
      <CutWorklistView dueNow={dueNow} overdue={overdue} cascade={cascade} day={dayISO} planNo={planNo} />
    </>
  );
}
