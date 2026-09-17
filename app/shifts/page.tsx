import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { SHIFT_DEPTS, isShiftDept, type ShiftDept } from "@/lib/domain/shifts";
import { factoryDayISO } from "@/lib/domain/dates";
import { getQuickWeek, getShiftDay, getShiftHistory } from "@/lib/server/shifts";
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ShiftLog, ShiftDeptPicker, ShiftDayPicker } from "@/components/ShiftLog";
import { QuickHours } from "@/components/QuickHours";

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

  const [week, data, history] = await Promise.all([getQuickWeek(day, today), getShiftDay(day, dept), getShiftHistory(dept)]);
  // the roster opens when the URL names a department — a link from the grid
  // or a supervisor's bookmark; the planner lands on the quick grid alone
  const rosterOpen = isShiftDept(sp.dept ?? "");

  return (
    <div className="space-y-5">
      <RememberLastVisit storageKey="shifts:last" />
      <PageHeader title="🕘 Shift log" />
      {/* the quick grid: the week's man-hours per department, typed as heads × hours */}
      <QuickHours key={week.startISO} data={week} editable={editable} today={today} />
      {/* the per-worker roster, for the days a supervisor records names */}
      <details id="roster" open={rosterOpen} className="bg-surface border rounded-xl">
        <summary className="cursor-pointer p-3 font-bold text-sm">
          Roster by worker <span className="font-normal text-xs text-muted ms-1">— optional: who came in, shift, overtime, machine and downtime</span>
        </summary>
        <div className="p-3 border-t space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <ShiftDeptPicker dept={dept} />
            <ShiftDayPicker day={day} today={today} />
          </div>
          {/* keyed on the day and department so the draft starts fresh on every navigation */}
          <ShiftLog key={`${day}|${dept}`} data={data} history={history} canEdit={canEdit} today={today} canSetHours={me.isAdmin} />
        </div>
      </details>
    </div>
  );
}
