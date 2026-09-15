import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { SHIFT_DEPTS, isShiftDept, type ShiftDept } from "@/lib/domain/shifts";
import { factoryDayISO } from "@/lib/domain/dates";
import { getShiftDay, getShiftHistory } from "@/lib/server/shifts";
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ShiftLog, ShiftDeptPicker, ShiftDayPicker } from "@/components/ShiftLog";

export const metadata = { title: "Shift log — ATC" };
export const dynamic = "force-dynamic";

// The supervisor's page: who worked today, how long, on what. One department
// at a time, one day at a time; viewing is free, recording needs the
// department's shifts.<dept> permission.
export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ day?: string; dept?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const today = factoryDayISO(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? "") ? sp.day! : today;
  // a supervisor lands on the department they may record; everyone else on the first
  const editable = SHIFT_DEPTS.filter((d) => hasPerm(me, shiftPermKey(d)));
  const dept: ShiftDept = isShiftDept(sp.dept ?? "") ? (sp.dept as ShiftDept) : (editable[0] ?? SHIFT_DEPTS[0]);
  const canEdit = hasPerm(me, shiftPermKey(dept));

  const [data, history] = await Promise.all([getShiftDay(day, dept), getShiftHistory(dept)]);

  return (
    <div>
      <RememberLastVisit storageKey="shifts:last" />
      <PageHeader title="🕘 Shift log">
        <ShiftDeptPicker dept={dept} />
        <ShiftDayPicker day={day} today={today} />
      </PageHeader>
      {/* keyed on the day and department so the draft starts fresh on every navigation */}
      {/* the hours a shift is worth are set right here, under the roster they
          are counted with — not on a settings page the supervisor never opens */}
      <ShiftLog key={`${day}|${dept}`} data={data} history={history} canEdit={canEdit} today={today} canSetHours={me.isAdmin} />
    </div>
  );
}
