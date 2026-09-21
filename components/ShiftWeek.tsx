"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { deptLabel } from "@/lib/domain/constants";
import { parseISODate, toDisplayDate } from "@/lib/domain/dates";
import { weekTotals } from "@/lib/domain/quickHours";
import { SHIFT_DEPTS } from "@/lib/domain/shifts";
import type { ShiftWeekData } from "@/lib/server/shifts";

// The week at a glance — a summary, not an entry. Every cell is what the
// department's roster summed for that day: heads present and man-hours.
// Nothing is typed here; the rosters below are where a day is recorded, and
// a cell is a link to that department's roster on that day.

const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shiftISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ShiftWeek({ data, today, day }: { data: ShiftWeekData; today: string; day: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const goWeek = (startISO: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("day", startISO);
    router.push(`${pathname}?${p}`);
  };
  const totals = useMemo(() => weekTotals(data.week), [data.week]);
  const weekLabel = `${toDisplayDate(parseISODate(data.days[0].dateISO)!)} – ${toDisplayDate(parseISODate(data.days[6].dateISO)!)}`;
  const thisWeek = data.days.some((d) => d.dateISO === today);

  return (
    <section className="bg-surface border rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b">
        <h2 className="!mb-0">Week of {weekLabel}</h2>
        <span className="text-xs text-muted">present · man-hours per department, summed from the rosters below</span>
        <div className="ms-auto inline-flex items-center gap-1.5">
          <button type="button" className="btn btn-sm" onClick={() => goWeek(shiftISO(data.startISO, -7))} title="Previous week">‹</button>
          <button type="button" className="btn btn-sm" disabled={data.days[0].dateISO > today} onClick={() => goWeek(shiftISO(data.startISO, 7))} title="Next week">›</button>
          {!thisWeek && <button type="button" className="btn btn-sm btn-ghost" onClick={() => goWeek(today)}>This week</button>}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2 whitespace-nowrap">Day</th>
              {SHIFT_DEPTS.map((x) => (
                <th key={x} className="p-2 whitespace-nowrap">
                  {deptLabel(x)}
                  <span className="block text-[10px] font-normal opacity-80">present · man-hours</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => {
              const dim = d.off || !!d.holiday;
              const selected = d.dateISO === day;
              return (
                <tr key={d.dateISO} className={`border-t ${dim ? "bg-surface-2/50" : ""} ${selected ? "ring-1 ring-inset ring-[var(--brand,#1b7a43)]/50" : ""}`}>
                  <td className="p-2 whitespace-nowrap">
                    <Link href={`/shifts?day=${d.dateISO}`} className="font-bold hover:underline">{DAY_NAME[new Date(d.dateISO + "T00:00:00Z").getUTCDay()]}</Link>
                    <span className="ms-2 text-xs text-muted tabnum">{toDisplayDate(parseISODate(d.dateISO)!)}</span>
                    {d.dateISO === today && <span className="ms-2 pill pill-ok">today</span>}
                    {d.off && <span className="ms-2 pill pill-muted">off</span>}
                    {d.holiday && <span className="ms-2 pill pill-muted" title={d.holiday}>holiday</span>}
                  </td>
                  {SHIFT_DEPTS.map((x) => {
                    const c = data.week[d.dateISO][x];
                    return (
                      <td key={x} className="p-1.5 whitespace-nowrap">
                        <Link href={`/shifts?day=${d.dateISO}#dept-${x}`} className="inline-flex items-baseline gap-2 rounded-md px-2 py-1 hover:bg-surface-2" title={c.recorded ? "Open this department's roster for the day" : d.future ? "Not yet" : "Not recorded — open the roster to record it"}>
                          {c.recorded ? (
                            <>
                              <span className="font-bold tabnum">{c.people ?? "—"}</span>
                              <span className="text-xs text-muted">·</span>
                              <span className="font-extrabold tabnum">{c.hours}</span>
                              <span className="text-[10px] text-muted">mh</span>
                            </>
                          ) : (
                            <span className={`text-xs ${d.future || dim ? "text-muted" : "text-warn-fg font-semibold"}`}>{d.future ? "—" : dim ? "—" : "not recorded"}</span>
                          )}
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t bg-surface-2/60 text-xs font-bold">
              <td className="p-2">Week</td>
              {SHIFT_DEPTS.map((x) => (
                <td key={x} className="p-2 tabnum">
                  {totals[x].days > 0 ? <>{totals[x].hours} mh <span className="font-normal text-muted">over {totals[x].days} day{totals[x].days === 1 ? "" : "s"}</span></> : <span className="font-normal text-muted">nothing yet</span>}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
