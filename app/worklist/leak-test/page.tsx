import { getLeakTestQueue } from "@/lib/server/tanks";
import { getWorkersFor } from "@/lib/server/workers";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { LeakTestTable } from "@/components/LeakTestTable";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";

export const metadata = { title: "Leak Test — ATC" };
export const dynamic = "force-dynamic";

// The stage between Welding and Painting, for tanks only. Unlike the other
// worklists this one is a list of PIECES, not a list of order lines: a leak
// test is something that happens to one tank, and its verdict is what opens
// (or blocks) painting for that tank.

function TrackingOff({ what }: { what: string }) {
  return (
    <div className="bg-surface border rounded-xl p-6 text-center">
      <p className="text-sm font-bold mb-1">Per-piece tank tracking is turned off</p>
      <p className="text-sm text-muted">
        {what} Tanks are being recorded as quantities on the worklists, like every other component.
        An admin can turn tracking on under Admin &rarr; Settings.
      </p>
    </div>
  );
}

export default async function LeakTestPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [tanks, testers, user, settings] = await Promise.all([
    getLeakTestQueue(),
    getWorkersFor("LeakTest"),
    getCurrentUser(),
    getSettings(),
  ]);
  if (!settings.tankTracking) {
    return <TrackingOff what="There is no leak-test stage while it is off." />;
  }
  const canEdit = !!user && canEditDept(user, "LeakTest");

  return (
    <>
      <PrintHeader title="Leak Test Worklist" date={toDisplayDate(today)} />
      <LeakTestTable tanks={tanks} testers={testers} day={dayISO} canEdit={canEdit} />
    </>
  );
}
