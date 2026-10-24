import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { ROSTER_DEPTS } from "@/lib/domain/shifts";
import { factoryDayISO } from "@/lib/domain/dates";
import { getShiftHistory, getShiftRoster } from "@/lib/server/shifts";
import { getDowntimeDay } from "@/lib/server/downtime";
import { ShiftDowntime } from "@/components/ShiftDowntime";
import { getShiftProductivity } from "@/lib/server/productivity";
import { ShiftProductivity } from "@/components/ShiftProductivity";
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ShiftRoster } from "@/components/ShiftRoster";
import { ShiftHoursForm } from "@/components/ShiftHoursForm";
import { ShiftsWorkspace } from "@/components/ShiftsWorkspace";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { parseRosterFilter, rosterDepts, rosterFilterLabel } from "@/lib/domain/roster";

export const metadata = { title: "Shift log — ATC" };
export const dynamic = "force-dynamic";

// The supervisors' page: one day, one roster of everyone, filtered by line
// or section on top. Viewing is free; recording a department needs its
// shifts.<dept> permission (shifts.lv for the panels).
export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ day?: string; sec?: string }> }) {
  await guardTab("/shifts");
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const today = factoryDayISO(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? "") ? sp.day! : today;
  const filter = parseRosterFilter(sp.sec);

  const depts = rosterDepts(filter);
  const [data, history, productivity, downtime] = await Promise.all([getShiftRoster(day), getShiftHistory(depts), getShiftProductivity(day, depts), getDowntimeDay(day)]);
  const editableDepts = ROSTER_DEPTS.filter((d) => hasPerm(me, shiftPermKey(d)));

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="shifts:last" />
      <div className="shrink-0 space-y-2 no-print">
        <PageHeader title="🕘 Shift log" />
        <UrlDateSlicer
          encoding="day" mode="day" from={day} to={day} min={addDaysISO(today, -60)} max={today} today={today}
          presets={["today", "yesterday"]} marks={history.map((h) => h.dateISO)}
        />
      </div>
      <ShiftsWorkspace
        attendance={
          /* keyed on the day so the draft starts fresh on every navigation; the
             filter is a URL param and keeps the draft */
          <ShiftRoster key={day} data={data} editableDepts={editableDepts} filter={filter} />
        }
        downtime={<ShiftDowntime key={day} data={downtime} editableDepts={editableDepts} />}
        downtimeCount={downtime.rows.length}
        history={history}
        dayISO={day}
        filter={filter}
        hours={me.isAdmin ? <ShiftHoursForm short={data.shiftHours.short} long={data.shiftHours.long} overtime={data.shiftHours.overtime} /> : undefined}
        productivity={<ShiftProductivity data={productivity} dayISO={day} filterLabel={rosterFilterLabel(filter)} isAdmin={me.isAdmin} />}
      />
    </div>
  );
}
