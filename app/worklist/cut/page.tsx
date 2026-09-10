import { getSoiLookup } from "@/lib/server/soi";
import { getRunOrderLines } from "@/lib/server/worklistExtras";
import { getCutSheet } from "@/lib/server/execution";
import { getSettings } from "@/lib/server/data";
import { getReturnsFor } from "@/lib/server/returns";
import { getQueueNotes } from "@/lib/server/queueNotes";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { CutWorklistView } from "@/components/CutWorklistView";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";
import { getMachineBoard, type BoardLineInput } from "@/lib/server/machineBoard";

export const dynamic = "force-dynamic";

// No page header on screen — every pixel goes to the work (title lives in the
// nav tab). The PrintHeader appears only on the printed/PDF sheet.
export default async function CutWorklistPage() {
  const [{ planNo, today, dueNow, overdue, postponed, remarked, unscheduled, pushed, priority, hidden, planIssues }, returns, notes, settings, user, runOrder, soi] = await Promise.all([
    getCutSheet(),
    getReturnsFor("Cut"),
    getQueueNotes(),
    getSettings(),
    getCurrentUser(),
    getRunOrderLines("Cut"),
    getSoiLookup(),
  ]);
  const dayISO = toISODate(today);
  const canEdit = !!user && canEditDept(user, "Cut");

  // every open line on the sheet, for the machine board: the dated tranches
  // by what is left on them, the date-less pools by what can be pulled
  const lines: BoardLineInput[] = [
    ...[...dueNow, ...overdue, ...postponed].map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.remaining, deliveryISO: r.deliveryISO, dueISO: r.cutDueISO })),
    ...[...pushed, ...remarked, ...unscheduled].map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.available, deliveryISO: r.deliveryISO })),
  ];
  const board = await getMachineBoard("Cut", lines, dayISO, planNo ?? 0);

  return (
    <>
      <PrintHeader title="Fabrication Worklist" date={toDisplayDate(today)} />
      <CutWorklistView soi={soi} runOrder={runOrder} dueNow={dueNow} overdue={overdue} postponed={postponed} remarked={remarked} unscheduled={unscheduled} pushed={pushed} priority={priority} hidden={hidden} planIssues={planIssues} day={dayISO} planNo={planNo} returns={returns} notes={notes} capacity={settings.capacityPerItem} leadDays={settings.leadCut} canEdit={canEdit} isAdmin={!!user?.isAdmin} board={board} />
    </>
  );
}
