"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Columns3, Flag, List, ListChecks, Repeat, Search, Users, X } from "lucide-react";
import { TableFrame, Th } from "@/components/DataTable";
import { EmptyState } from "@/components/primitives";
import { formatDate } from "@/lib/domain/format";
import {
  BOARD_COLUMNS, CHECKLIST_LIMITS, NO_FILTER, isFiltered, TASK_STATUS_LABEL, TASK_STATUS_TONE, monthWeeks, shiftMonth,
  type DueFilter, type PersonLoad, type TaskFilter,
} from "@/lib/domain/tasks";
import type { TaskSummary } from "@/lib/server/tasks";

// The Tasks tab's other ways of looking at the same tasks — a board by
// state, a month by due day, the team's load — and the pieces they share:
// the filter bar, a checklist's progress, a checklist being written.

export type TaskViewId = "list" | "board" | "calendar" | "team";

export const TASK_VIEWS: readonly { id: TaskViewId; label: string; icon: typeof List }[] = [
  { id: "list", label: "List", icon: List },
  { id: "board", label: "Board", icon: Columns3 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "team", label: "Team", icon: Users },
];

const DUE_LABEL: Record<DueFilter, string> = { any: "Any due day", late: "Late", today: "Due today", week: "Due this week", none: "No due day" };

/** Search, priority, person and due day — one toolbar that wraps, with
 *  whatever else narrows the list (open or done) after them. */
export function TaskFilterBar({ f, onChange, people, count, children }: { f: TaskFilter; onChange: (f: TaskFilter) => void; people: { id: number; name: string }[]; count: number; children?: ReactNode }) {
  const set = <K extends keyof TaskFilter>(k: K, v: TaskFilter[K]) => onChange({ ...f, [k]: v });
  const active = isFiltered(f);
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="search">
      <label className="relative flex-1 min-w-[10rem]">
        <Search size={14} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input type="search" value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="Search tasks, orders, people…" aria-label="Search tasks" className="w-full ps-8 pe-2 py-1 text-sm" dir="auto" />
      </label>
      <select value={f.due} onChange={(e) => set("due", e.target.value as DueFilter)} aria-label="Due day" className="py-1 text-sm">
        {(Object.keys(DUE_LABEL) as DueFilter[]).map((d) => <option key={d} value={d}>{DUE_LABEL[d]}</option>)}
      </select>
      {people.length > 1 && (
        <select value={f.person ?? ""} onChange={(e) => set("person", e.target.value ? Number(e.target.value) : null)} aria-label="Person" className="py-1 text-sm max-w-[11rem]">
          <option value="">Anyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <button type="button" className={`chip ${f.priority === "urgent" ? "chip-on" : ""}`} aria-pressed={f.priority === "urgent"} onClick={() => set("priority", f.priority === "urgent" ? "any" : "urgent")}>
        <Flag size={12} aria-hidden /> Urgent
      </button>
      {children}
      {active && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(NO_FILTER)}>
          <X size={13} aria-hidden /> Clear <span className="text-muted tabnum">({count})</span>
        </button>
      )}
    </div>
  );
}

/** Everyone on these tasks — the person filter's choices. */
export function peopleOf(list: readonly TaskSummary[]): { id: number; name: string }[] {
  const by = new Map<number, string>();
  for (const t of list) {
    if (t.createdById) by.set(t.createdById, t.createdByName);
    for (const a of t.assignees) by.set(a.id, a.name);
  }
  return [...by].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A checklist's progress: a thin bar and "2/5". */
export function StepsBar({ steps, wide = false }: { steps: { done: number; total: number }; wide?: boolean }) {
  if (steps.total === 0) return null;
  const pct = Math.round((steps.done / steps.total) * 100);
  return (
    <span className={`inline-flex items-center gap-1.5 ${wide ? "w-full" : ""}`} title={`${steps.done} of ${steps.total} steps ticked`}>
      {!wide && <ListChecks size={12} className="text-muted shrink-0" aria-hidden />}
      <span className={`task-progress ${wide ? "flex-1" : "w-14"}`} role="progressbar" aria-valuenow={steps.done} aria-valuemin={0} aria-valuemax={steps.total} aria-label="Steps ticked">
        <span className={steps.done === steps.total ? "task-progress-full" : ""} style={{ width: `${pct}%` }} />
      </span>
      <span className="tabnum text-[11px] text-muted">{steps.done}/{steps.total}</span>
    </span>
  );
}

/** Writing a checklist: one step per line — the steps already there keep their place. */
export function ChecklistEditor({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const lines = draft.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).map((l) => l.slice(0, CHECKLIST_LIMITS.text));
    if (lines.length === 0) return;
    onChange([...value, ...lines].slice(0, CHECKLIST_LIMITS.items));
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ol className="space-y-1">
          {value.map((s, i) => (
            <li key={`${i}-${s}`} className="flex items-center gap-2 rounded-md border bg-surface-2 ps-2.5 pe-1 py-1 text-sm">
              <span className="tabnum text-[11px] text-muted w-4 text-end shrink-0">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate" dir="auto">{s}</span>
              <button type="button" className="icon-btn" onClick={() => onChange(value.filter((_, n) => n !== i))} disabled={disabled} aria-label={`Remove step ${i + 1}`} title="Remove"><X size={12} /></button>
            </li>
          ))}
        </ol>
      )}
      {value.length < CHECKLIST_LIMITS.items && (
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (text.includes("\n")) {
                e.preventDefault();
                setDraft(text);
              }
            }}
            maxLength={CHECKLIST_LIMITS.text * 4}
            placeholder={value.length ? "Another step — Enter to add" : "A step — Enter to add (paste several lines at once)"}
            aria-label="Add a checklist step"
            className="flex-1 min-w-0 px-2.5 py-1 text-sm"
            dir="auto"
            disabled={disabled}
          />
          <button type="button" className="btn btn-sm btn-secondary" onClick={add} disabled={disabled || !draft.trim()}>Add</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ board

function Card({ t, on, onPick, mine }: { t: TaskSummary; on: boolean; onPick: () => void; mine: boolean }) {
  return (
    <button type="button" onClick={onPick} className={`task-card ${on ? "task-card-on" : ""}`} aria-current={on || undefined}>
      <span className="flex items-start gap-1.5">
        {t.priority === "urgent" && <Flag size={12} className="text-bad-fg shrink-0 mt-0.5" aria-label="Urgent" />}
        <span className={`text-[13px] leading-snug flex-1 min-w-0 ${t.unread > 0 ? "font-bold" : "font-semibold"}`} dir="auto">{t.title}</span>
        {t.repeatId && <Repeat size={12} className="text-muted shrink-0 mt-0.5" aria-label="Repeats" />}
      </span>
      <span className="block mt-1 text-[11px] text-muted truncate" dir="auto">{mine ? `From ${t.createdByName}` : `To ${t.assignees.map((a) => a.name).join(", ")}`}</span>
      {(t.dueDate || t.steps.total > 0) && (
        <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mt-1.5 text-[11px]">
          {t.dueDate ? (
            <span className={`inline-flex items-center gap-1 tabnum ${t.overdue ? "text-bad-fg font-semibold" : "text-muted"}`}>
              <CalendarClock size={11} aria-hidden /> {t.overdue ? "Late · " : ""}{formatDate(t.dueDate)}
            </span>
          ) : <span />}
          <StepsBar steps={t.steps} />
        </span>
      )}
    </button>
  );
}

/** The tasks by where they stand — to do, in progress, waiting for review, done. */
export function TaskBoard({ list, openId, onOpen, mineOf }: { list: TaskSummary[]; openId: number | null; onOpen: (id: number) => void; mineOf: (t: TaskSummary) => boolean }) {
  return (
    <div className="task-board">
      {BOARD_COLUMNS.map((c) => {
        const items = list.filter((t) => c.statuses.includes(t.status));
        return (
          <section key={c.id} className={`task-col task-col-${c.id}`} aria-label={`${c.label}: ${items.length}`}>
            <h3 className="task-col-head">
              <span>{c.label}</span>
              <span className="tabnum text-muted font-semibold">{items.length}</span>
            </h3>
            <div className="task-col-body">
              {items.length === 0 ? <p className="text-xs text-muted px-1 py-2">Nothing here.</p> : items.map((t) => <Card key={t.id} t={t} on={t.id === openId} onPick={() => onOpen(t.id)} mine={mineOf(t)} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ calendar

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The month by due day — today ringed, a day off shaded, the tasks without a due day counted under it. */
export function TaskCalendar({ list, todayISO, openId, onOpen }: { list: TaskSummary[]; todayISO: string; openId: number | null; onOpen: (id: number) => void }) {
  const [month, setMonth] = useState(todayISO.slice(0, 7));
  const byDay = useMemo(() => {
    const m = new Map<string, TaskSummary[]>();
    for (const t of list) if (t.dueDate) m.set(t.dueDate, [...(m.get(t.dueDate) ?? []), t]);
    return m;
  }, [list]);
  const undated = list.filter((t) => !t.dueDate).length;
  const weeks = monthWeeks(month);
  const title = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn icon-btn-md" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month" title="Previous month"><ChevronLeft size={16} /></button>
        <h3 className="text-sm font-bold min-w-[9rem] text-center" aria-live="polite">{title}</h3>
        <button type="button" className="icon-btn icon-btn-md" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month" title="Next month"><ChevronRight size={16} /></button>
        {month !== todayISO.slice(0, 7) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMonth(todayISO.slice(0, 7))}>Today</button>}
        {undated > 0 && <span className="ms-auto text-xs text-muted">{undated} without a due day — in List and Board</span>}
      </div>
      <div className="task-cal-scroll">
        <div className="task-cal" role="group" aria-label={`Tasks due in ${title}`}>
          {WEEKDAYS.map((d) => <div key={d} className="task-cal-wd" aria-hidden>{d}</div>)}
          {weeks.flat().map((iso, i) => {
            if (!iso) return <div key={`x${i}`} className="task-cal-day task-cal-out" aria-hidden />;
            const items = byDay.get(iso) ?? [];
            const day = Number(iso.slice(8));
            const friday = new Date(`${iso}T00:00:00Z`).getUTCDay() === 5;
            return (
              <div key={iso} role="group" className={`task-cal-day ${iso === todayISO ? "task-cal-today" : ""} ${friday ? "task-cal-off" : ""}`} aria-label={`${formatDate(iso)}: ${items.length} due`}>
                <span className="task-cal-num tabnum">{day}</span>
                <div className="space-y-0.5">
                  {items.slice(0, 4).map((t) => (
                    <button key={t.id} type="button" onClick={() => onOpen(t.id)} className={`task-cal-item ${t.overdue ? "task-cal-late" : ""} ${t.id === openId ? "task-card-on" : ""}`} title={`${t.title} — ${TASK_STATUS_LABEL[t.status]}`}>
                      <span className={`task-dot ${TASK_STATUS_TONE[t.status]}`} aria-hidden />
                      <span className="truncate" dir="auto">{t.title}</span>
                      <span className="sr-only">— {TASK_STATUS_LABEL[t.status]}{t.overdue ? ", late" : ""}</span>
                    </button>
                  ))}
                  {items.length > 4 && <span className="block text-[11px] text-muted ps-1">+{items.length - 4} more</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ team

/** Who has how much — now, and over the last 30 days. */
export function TaskTeam({ team, onPick, owner }: { team: PersonLoad[]; onPick: (id: number) => void; owner: boolean }) {
  if (team.length === 0) {
    return <EmptyState icon={ListChecks} title="No one has tasks yet" hint="Once you give tasks, each person's load and record shows here." />;
  }
  const most = Math.max(1, ...team.map((p) => p.open));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{owner ? "Everyone's tasks" : "The tasks you gave"} — open and late now; approved, on time and days taken over the last 30 days.{owner ? "" : " Choose a name to see their tasks."}</p>
      <TableFrame>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th label="Person" />
              <Th label="Open" num full="In their hands now: to do, in progress, returned" />
              <Th label="Load" className="w-[22%] hidden sm:table-cell" />
              <Th label="Late" num full="Past the due day and not marked done" />
              <Th label="Due this week" num />
              <Th label="To review" num full="Marked done, waiting for the giver to approve" />
              <Th label="Approved (30 d)" num />
              <Th label="On time" num full="Of those approved in 30 days with a due day: marked done by it" />
              <Th label="Avg days" num full="From given to approved, over the last 30 days" />
            </tr>
          </thead>
          <tbody>
            {team.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-1.5">
                  {owner ? <span className="font-semibold" dir="auto">{p.name}</span> : <button type="button" className="font-semibold hover:underline text-start" onClick={() => onPick(p.id)} dir="auto">{p.name}</button>}
                </td>
                <td className="px-3 py-1.5 text-end tabnum font-semibold">{p.open}</td>
                <td className="px-3 py-1.5 hidden sm:table-cell">
                  <span className="task-progress w-full block" aria-hidden><span className={p.late > 0 ? "task-progress-late" : ""} style={{ width: `${Math.round((p.open / most) * 100)}%` }} /></span>
                </td>
                <td className={`px-3 py-1.5 text-end tabnum ${p.late > 0 ? "text-bad-fg font-bold" : "text-muted"}`}>{p.late}</td>
                <td className="px-3 py-1.5 text-end tabnum">{p.dueThisWeek}</td>
                <td className={`px-3 py-1.5 text-end tabnum ${p.waiting > 0 ? "text-warn-fg font-semibold" : "text-muted"}`}>{p.waiting}</td>
                <td className="px-3 py-1.5 text-end tabnum">{p.done30}</td>
                <td className={`px-3 py-1.5 text-end tabnum ${p.onTimePct !== null && p.onTimePct < 70 ? "text-bad-fg" : ""}`}>{p.onTimePct === null ? "—" : `${p.onTimePct}%`}</td>
                <td className="px-3 py-1.5 text-end tabnum">{p.avgDays === null ? "—" : p.avgDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}
