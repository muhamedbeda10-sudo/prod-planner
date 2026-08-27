import { getLeakTestQueue } from "@/lib/server/tanks";
import { getWorkersFor } from "@/lib/server/workers";
import { toISODate, toDisplayDate } from "@/lib/domain/dates";
import { LeakTestTable } from "@/components/LeakTestTable";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept } from "@/lib/server/auth";

export const metadata = { title: "Leak Test — ATC" };
export const dynamic = "force-dynamic";

// The stage between Welding and Painting, for tanks only. Unlike the other
// worklists this one is a list of PIECES, not a list of order lines: a leak
// test is something that happens to one tank, and its verdict is what opens
// (or blocks) painting for that tank.
export default async function LeakTestPage() {
  const today = new Date();
  const dayISO = toISODate(today);
  const [tanks, testers, user] = await Promise.all([
    getLeakTestQueue(),
    getWorkersFor("LeakTest"),
    getCurrentUser(),
  ]);
  const canEdit = !!user && canEditDept(user, "LeakTest");

  return (
    <>
      <PrintHeader title="Leak Test Worklist" date={toDisplayDate(today)} />
      <LeakTestTable tanks={tanks} testers={testers} day={dayISO} canEdit={canEdit} />
    </>
  );
}
