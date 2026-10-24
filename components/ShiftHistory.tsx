"use client";

import Link from "next/link";
import { ArrowRight, CalendarDays, Moon, Sun } from "lucide-react";
import { EmptyState } from "@/components/primitives";
import { formatDate } from "@/lib/domain/format";
import { rosterFilterLabel, type RosterFilter } from "@/lib/domain/roster";
import type { ShiftHistoryDay } from "@/lib/server/shifts";

export function ShiftHistory({ history, dayISO, filter, onOpenDay }: {
  history: readonly ShiftHistoryDay[];
  dayISO: string;
  filter: RosterFilter;
  onOpenDay: () => void;
}) {
  return (
    <section aria-label="Recorded shift days">
      <h2>Recorded days — {rosterFilterLabel(filter)}</h2>
      <p className="text-sm text-muted mb-4">Open a day to review its attendance. Counts and hours follow the selected line or section.</p>
      {!history.length ? <EmptyState compact icon={CalendarDays} title="Nothing recorded yet" hint="Save a day and it is listed here." /> : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {history.map((h) => (
            <li key={h.dateISO}>
              <Link href={`/shifts?${new URLSearchParams({ day: h.dateISO, ...(filter ? { sec: filter } : {}) })}`} onNavigate={onOpenDay} aria-current={h.dateISO === dayISO ? "date" : undefined} className={`block rounded-xl border p-4 hover:bg-surface-2 transition-colors ${h.dateISO === dayISO ? "border-brand bg-brand-light" : "bg-surface"}`}>
                <span className="flex items-center gap-2 font-semibold"><CalendarDays size={16} aria-hidden />{formatDate(h.dateISO)}<ArrowRight size={15} className="ms-auto text-muted" aria-hidden /></span>
                <span className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  {h.day + h.night > 0 ? <><span className="shift-tag shift-tag-day"><Sun size={12} aria-hidden />{h.day} day</span><span className="shift-tag shift-tag-night"><Moon size={12} aria-hidden />{h.night} night</span></> : <span className="text-muted">{h.people} present</span>}
                  <span className="ms-auto font-semibold tabnum">{h.hours} mh</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
