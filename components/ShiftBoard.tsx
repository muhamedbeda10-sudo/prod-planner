"use client";

import { Moon, Sun, UserX, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/primitives";
import { ATTENDANCE_TIME, OVERTIME_TIME, ROSTER_DEPTS, round1, type Attendance, type RosterDept } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";

// Who came on which shift, side by side: the day shift's people in one
// column and the night shift's in the other, each by department, with the
// absent and the ones not set yet under them. Read-only — the record view
// beside it is where a day is changed — and the page's printout: it is the
// sheet a supervisor hands on.

export interface BoardLine {
  key: string;
  dept: RosterDept;
  empId: string;
  name: string;
  jobTitle: string | null;
  sectionLabels: string[];
  onVacation: boolean;
  attendance: Attendance | "unset";
  overtimeH: number;
  hours: number;
  note: string;
  /** Fabrication: the work centre he was on. */
  centre?: string | null;
}

const byDept = (lines: readonly BoardLine[]) =>
  ROSTER_DEPTS.map((dept) => ({ dept, lines: lines.filter((l) => l.dept === dept) })).filter((g) => g.lines.length > 0);

function Person({ l, showOt }: { l: BoardLine; showOt: boolean }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2 py-1 border-b border-border last:border-b-0 break-inside-avoid text-[13px]">
      <span className="w-14 shrink-0 text-muted tabnum ltr">{l.empId}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={[l.name, l.jobTitle, ...l.sectionLabels].filter(Boolean).join(" · ")}>
          <span className="font-semibold">{l.name}</span>
          {l.centre ? <span className="text-muted"> · {l.centre}</span> : l.sectionLabels.length > 0 && <span className="text-muted"> · {l.sectionLabels.join(", ")}</span>}
        </span>
        {l.note && <span className="block truncate text-muted" title={l.note}>{l.note}</span>}
      </span>
      {showOt && l.overtimeH > 0 && <span className="pill pill-muted shrink-0 tabnum" title={`Overtime ${OVERTIME_TIME}`}>+{round1(l.overtimeH)} h OT</span>}
      {l.onVacation && l.attendance === "absent" && <span className="pill pill-warn shrink-0">vacation</span>}
    </li>
  );
}

function Groups({ lines, showOt }: { lines: readonly BoardLine[]; showOt: boolean }) {
  return (
    <div className="space-y-3">
      {byDept(lines).map((g) => (
        <section key={g.dept} aria-label={WORKER_DEPT_LABEL[g.dept]}>
          <h4 className="mb-1 flex items-baseline gap-2 text-xs font-bold uppercase tracking-wide text-muted">
            {WORKER_DEPT_LABEL[g.dept]}
            <span className="tabnum font-semibold">{g.lines.length}</span>
          </h4>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6">
            {g.lines.map((l) => <Person key={l.key} l={l} showOt={showOt} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

const TONE = {
  day: "bg-shift-day-bg text-shift-day-fg",
  night: "bg-shift-night-bg text-shift-night-fg",
  absent: "bg-bad-bg text-bad-fg",
  unset: "bg-warn-bg text-warn-fg",
} as const;

/** One of the board's lists: a toned header with its figures, then the
 *  people by department. */
function BoardPanel({ tone, icon: Icon, title, time, end, children }: {
  tone: keyof typeof TONE; icon: LucideIcon; title: string; time?: string; end: ReactNode; children: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-surface overflow-hidden break-inside-avoid" aria-label={title}>
      <header className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b ${TONE[tone]}`}>
        <h3 className="!m-0 inline-flex items-center gap-2 text-base font-bold"><Icon size={18} aria-hidden />{title}</h3>
        {time && <span className="text-sm font-semibold tabnum">{time}</span>}
        <span className="ms-auto text-sm font-bold tabnum">{end}</span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function ShiftColumn({ kind, lines }: { kind: "day" | "night"; lines: readonly BoardLine[] }) {
  const Icon = kind === "day" ? Sun : Moon;
  const hours = round1(lines.reduce((s, l) => s + l.hours, 0));
  const ot = lines.filter((l) => l.overtimeH > 0).length;
  return (
    <BoardPanel
      tone={kind} icon={Icon} title={kind === "day" ? "Day shift" : "Night shift"} time={ATTENDANCE_TIME[kind]}
      end={<>{lines.length} {lines.length === 1 ? "person" : "people"} · {hours} mh{kind === "day" && ot > 0 ? ` · ${ot} on OT` : ""}</>}
    >
      {lines.length === 0
        ? <EmptyState compact icon={Icon} title={`Nobody on the ${kind} shift`} hint="Pick Day or Night for a worker in the Record view." />
        : <Groups lines={lines} showOt={kind === "day"} />}
    </BoardPanel>
  );
}

export function ShiftBoard({ lines }: { lines: readonly BoardLine[] }) {
  if (lines.length === 0) {
    return <div className="rounded-xl border border-dashed"><EmptyState icon={Users} title="Nobody in this view" hint="Clear the search or pick another line or section." /></div>;
  }
  const of = (a: Attendance | "unset") => lines.filter((l) => l.attendance === a);
  const absent = of("absent");
  const unset = of("unset");
  return (
    <div className="space-y-3">
      <h2 className="sr-only">Who came on which shift</h2>
      <div className="grid gap-3 lg:grid-cols-2 print:grid-cols-2">
        <ShiftColumn kind="day" lines={of("day")} />
        <ShiftColumn kind="night" lines={of("night")} />
      </div>
      {(absent.length > 0 || unset.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2 print:grid-cols-2">
          {absent.length > 0 && <BoardPanel tone="absent" icon={UserX} title="Absent" end={absent.length}><Groups lines={absent} showOt={false} /></BoardPanel>}
          {unset.length > 0 && <BoardPanel tone="unset" icon={Users} title="Not set yet" end={unset.length}><Groups lines={unset} showOt={false} /></BoardPanel>}
        </div>
      )}
    </div>
  );
}
