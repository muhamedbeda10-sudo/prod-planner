import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { SHIFT_DEPTS } from "@/lib/domain/shifts";
import { deptLabel } from "@/lib/domain/constants";
import { factoryDayISO } from "@/lib/domain/dates";
import { getShiftDay, getShiftHistory, getShiftWeek } from "@/lib/server/shifts";
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ShiftLog, ShiftDayPicker } from "@/components/ShiftLog";
import { ShiftWeek } from "@/components/ShiftWeek";

export const metadata = { title: "Shift log — ATC" };
export const dynamic = "force-dynamic";

// The supervisors' page: one day, every department's roster under it — who
// came in, how long, on what. The week strip on top only sums what the
// rosters say. Viewing is free; recording a department needs its
// shifts.<dept> permission.
export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ day?: string; dept?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const today = factoryDayISO(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? "") ? sp.day! : today;

  const [week, days, histories] = await Promise.all([
    getShiftWeek(day, today),
    Promise.all(SHIFT_DEPTS.map((d) => getShiftDay(day, d))),
    Promise.all(SHIFT_DEPTS.map((d) => getShiftHistory(d))),
  ]);

  return (
    <div className="space-y-5">
      <RememberLastVisit storageKey="shifts:last" />
      <PageHeader title="🕘 Shift log">
        <ShiftDayPicker day={day} today={today} />
      </PageHeader>
      <ShiftWeek key={week.startISO} data={week} today={today} day={day} />
      {SHIFT_DEPTS.map((dept, i) => {
        const data = days[i];
        const canEdit = hasPerm(me, shiftPermKey(dept));
        return (
          <section key={dept} id={`dept-${dept}`} className="scroll-mt-4">
            <h2 className="flex flex-wrap items-baseline gap-2">
              {deptLabel(dept)}
              <span className="text-sm font-normal text-muted tabnum">{data.totals.present} / {data.totals.workers} present · {data.totals.hours} mh</span>
              {!canEdit && <span className="pill pill-muted">view only</span>}
            </h2>
            {/* keyed on the day and department so the draft starts fresh on every navigation;
                the shift-hours settings show once, under the first department */}
            <ShiftLog key={`${day}|${dept}`} data={data} history={histories[i]} canEdit={canEdit} today={today} canSetHours={me.isAdmin && i === 0} />
          </section>
        );
      })}
    </div>
  );
}
