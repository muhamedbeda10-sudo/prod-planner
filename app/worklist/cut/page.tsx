import { getCutSheet } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getReturnsFor } from "@/lib/server/returns";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { CutWorklistView } from "@/components/CutWorklistView";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the work (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function CutWorklistPage() {
  const [{ planNo, today, dueNow, overdue, cascade }, returns, notes, settings, user] = await Promise.all([
    getCutSheet(),
    getReturnsFor("Cut"),
    getQueueNotes(),
    getSettings(),
    getCurrentUser(),
  ]);
  const dayISO = toISODate(today);
  const canEdit = !!user && canEditDept(user, "Cut");

  return (
    <>
      <PrintHeader title="Fabrication Worklist" date={toDisplayDate(today)} />
      <CutWorklistView dueNow={dueNow} overdue={overdue} cascade={cascade} day={dayISO} planNo={planNo} returns={returns} notes={notes} capacity={settings.capacityPerItem} leadDays={settings.leadCut} canEdit={canEdit} />
    </>
  );
}
