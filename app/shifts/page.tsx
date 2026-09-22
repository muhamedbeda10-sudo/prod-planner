import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { ROSTER_DEPTS } from "@/lib/domain/shifts";
import { factoryDayISO } from "@/lib/domain/dates";
import { getShiftHistory, getShiftRoster } from "@/lib/server/shifts";
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ShiftDayPicker, ShiftRoster } from "@/components/ShiftRoster";
import { parseRosterFilter, rosterDepts } from "@/lib/domain/roster";

export const metadata = { title: "Shift log — ATC" };
export const dynamic = "force-dynamic";

// The supervisors' page: one day, one roster of everyone, filtered by line
// or section on top. Viewing is free; recording a department needs its
// shifts.<dept> permission (shifts.lv for the panels).
export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ day?: string; sec?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const today = factoryDayISO(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? "") ? sp.day! : today;
  const filter = parseRosterFilter(sp.sec);

  const [data, history] = await Promise.all([getShiftRoster(day), getShiftHistory(rosterDepts(filter))]);
  const editableDepts = ROSTER_DEPTS.filter((d) => hasPerm(me, shiftPermKey(d)));

  return (
    <div className="space-y-4">
      <RememberLastVisit storageKey="shifts:last" />
      <PageHeader title="🕘 Shift log">
        <ShiftDayPicker day={day} today={today} />
      </PageHeader>
      {/* keyed on the day so the draft starts fresh on every navigation; the
          filter is a URL param and keeps the draft */}
      <ShiftRoster key={day} data={data} history={history} editableDepts={editableDepts} today={today} filter={filter} canSetHours={me.isAdmin} />
    </div>
  );
}
