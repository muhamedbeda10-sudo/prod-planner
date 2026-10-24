"use client";

import { EmptyState } from "@/components/primitives";
import { CalendarDays, Clock3, ClipboardList, Gauge, LayoutGrid, Moon, Sun, UserX, Users, CircleHelp } from "lucide-react";
import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  ATTENDANCES, ATTENDANCE_LABEL, ATTENDANCE_TIME, DEFAULT_SHIFT_HOURS, OVERTIME_TIME, UNSET_LINE, attendanceLine, attendanceOf, lineHours, round1, shiftSplit,
  type Attendance, type RosterDept,
} from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL, WORKER_GROUPS } from "@/lib/domain/tanks";
import { ROSTER_SECTIONS, rosterDepts, rosterLineMatches, type RosterFilter, rosterFilterLabel } from "@/lib/domain/roster";
import type { ShiftHistoryDay, ShiftLineDTO, ShiftRosterData } from "@/lib/server/shifts";
import { clearShiftDay, saveShiftRoster } from "@/app/shifts/actions";
import { ShiftHoursForm } from "@/components/ShiftHoursForm";
import { ShiftBoard, type BoardLine } from "@/components/ShiftBoard";
import { FilterSelect, SearchBox } from "@/components/FilterControls";
import { TableFrame, Th, useConfirm } from "@/components/DataTable";
import { ExportButton } from "@/components/ExportButton";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader, PrintScope } from "@/components/PrintHeader";

// The shift roster — one day, every worker of every section. Each worker gets
// ONE choice that says both whether he came and on which shift: ☀ Day
// (07:00–16:00), 🌙 Night (19:00–07:00) or ✕ Absent; none picked is "not set",
// and a day is saved only when nobody is. The figures on top are the filters:
// who came on the day shift, who on the night shift, overtime, absent, not set.
// The board view puts the two shifts' people side by side — the printout.

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) => {
    startTransition(async () => {
      const res = await fn(fd);
      setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
      if (res.ok) {
        after?.();
        router.refresh();
      }
    });
  };
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p role="status" className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

type Draft = Pick<ShiftLineDTO, "workerId" | "dept" | "present" | "shift" | "overtimeH" | "note" | "recorded">;
const toDraft = (l: ShiftLineDTO): Draft => ({ workerId: l.workerId, dept: l.dept, present: l.present, shift: l.shift, overtimeH: l.overtimeH, note: l.note, recorded: l.recorded });
const UNSET = { ...UNSET_LINE, recorded: false } as const;
/** What the list is narrowed to by the figures on top. */
type RosterPick = "all" | Attendance | "overtime" | "unset";
type View = "record" | "board";
const keyOf = (l: { workerId: number; dept: string }) => `${l.dept}|${l.workerId}`;

const ATT_ICON = { day: Sun, night: Moon, absent: UserX } as const;
/** The clock times as the cards on top fit them. */
const SHORT_TIME = { day: "07–16", night: "19–07", overtime: "16–19" } as const;

/** Day · Night · Absent for one worker. Clicking the one already picked
 *  clears it back to not set. */
function AttendancePicker({ value, onPick, disabled, name }: { value: Attendance | "unset"; onPick: (a: Attendance | "unset") => void; disabled: boolean; name: string }) {
  return (
    <div className={`att ${value === "unset" ? "att-unset" : ""}`} role="group" aria-label={`${name}: attendance`}>
      {ATTENDANCES.map((a) => {
        const Icon = ATT_ICON[a];
        const on = value === a;
        return (
          <button
            key={a} type="button" data-att={a} aria-pressed={on} disabled={disabled}
            title={on ? "Click again to clear" : a === "absent" ? "Did not come" : `${ATTENDANCE_LABEL[a]} shift ${ATTENDANCE_TIME[a]}`}
            onClick={() => onPick(on ? "unset" : a)}
          >
            <Icon size={14} aria-hidden />{ATTENDANCE_LABEL[a]}
          </button>
        );
      })}
    </div>
  );
}

/** A figure that is also its filter. */
function PickCard({ on, onClick, label, time, timeOnPhone = true, icon: Icon, value, sub, accent, tone = "" }: {
  on: boolean; onClick: () => void; label: string; time?: string; timeOnPhone?: boolean; icon: typeof Sun; value: number | string; sub: string; accent?: string; tone?: string;
}) {
  const full = time ? `${label} ${time}` : label;
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={on ? "Click again to show everyone" : `Show only: ${full}`} className={`kpi kpi-pick ${accent ?? ""}`}>
      <span className="kpi-label"><Icon size={13} aria-hidden /><span className="truncate">{label}{time && <span className={timeOnPhone ? "" : "max-sm:hidden"}> · {time}</span>}</span></span>
      <span className={`kpi-value block tabnum ${tone}`}>{value}</span>
      <span className="kpi-sub block">{sub}</span>
    </button>
  );
}

export function ShiftRoster({ data, history, editableDepts, today, filter, canSetHours = false }: {
  data: ShiftRosterData;
  history: ShiftHistoryDay[];
  /** The departments this user may record — the rest are read-only rows. */
  editableDepts: RosterDept[];
  today: string;
  filter: RosterFilter;
  /** The planner may set what a shift is worth without leaving this page. */
  canSetHours?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const save = useAction();
  const clear = useAction();
  const [confirm, confirmDialog] = useConfirm();
  const [hoursOpen, setHoursOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<RosterPick>("all");
  const [view, setView] = useState<View>("record");
  const [draft, setDraft] = useState<Draft[]>(() => data.lines.map(toDraft));
  const byKey = useMemo(() => new Map(data.lines.map((l) => [keyOf(l), l])), [data.lines]);
  const hrs = data.shiftHours ?? DEFAULT_SHIFT_HOURS;
  const OT = hrs.overtime;

  const setFilter = (v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set("sec", v); else p.delete("sec");
    router.push(`${pathname}?${p}`);
  };
  const lineOfFilter = filter.startsWith("line:") ? filter.slice(5) : ROSTER_SECTIONS.find((s) => s.code === filter)?.group ?? "";
  const sectionValue = filter === "" || filter.startsWith("line:") ? "" : filter;
  const sectionOptions = ROSTER_SECTIONS.filter((s) => !lineOfFilter || s.group === lineOfFilter).map((s) => ({ value: s.code, label: s.label }));

  // the line or section on top, then the search: the figures count the
  // first (so they hold still while typing), the list shows both
  const needle = q.trim().toLowerCase();
  // a line whose worker is no longer on the day (cleared, then off the list) is left out
  const inFilter = useMemo(() => draft.filter((d) => { const w = byKey.get(keyOf(d)); return !!w && rosterLineMatches(w, filter); }), [draft, byKey, filter]);
  const searched = useMemo(() => inFilter.filter((d) => {
    if (!needle) return true;
    const l = byKey.get(keyOf(d))!;
    return `${l.name} ${l.empId} ${l.jobTitle ?? ""} ${l.sectionLabels.join(" ")}`.toLowerCase().includes(needle);
  }), [inFilter, byKey, needle]);
  const matchesPick = (d: Draft) => {
    if (pick === "all") return true;
    const a = attendanceOf(d);
    if (pick === "overtime") return a === "day" && d.overtimeH > 0;
    return a === pick;
  };
  const shown = searched.filter(matchesPick);
  const split = useMemo(() => shiftSplit(inFilter, hrs), [inFilter, hrs]);
  const onVacationAbsent = inFilter.filter((d) => attendanceOf(d) === "absent" && byKey.get(keyOf(d))?.onVacation).length;

  const depts = rosterDepts(filter);
  const capacity = depts.reduce<number | null>((s, d) => (data.capacityMh[d] == null ? s : (s ?? 0) + data.capacityMh[d]!), null);
  const initial = useMemo(() => JSON.stringify(data.lines.map(toDraft)), [data.lines]);
  const dirty = useMemo(() => JSON.stringify(draft) !== initial, [draft, initial]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const canEdit = (d: RosterDept) => editableDepts.includes(d);
  const anyEditable = inFilter.some((d) => canEdit(d.dept));
  // a department nobody is registered in has nothing to record
  const staffed = depts.filter((d) => inFilter.some((l) => l.dept === d));
  const recordedHere = staffed.filter((d) => data.savedDepts.includes(d));
  const allRecorded = staffed.length > 0 && recordedHere.length === staffed.length;
  // what this person saves: the departments they may record
  const editableStaffed = staffed.filter(canEdit);
  const allMineRecorded = editableStaffed.length > 0 && editableStaffed.every((d) => data.savedDepts.includes(d));

  const patch = (keys: Set<string>, fn: (l: Draft) => Partial<Draft>) => setDraft((all) => all.map((l) => (keys.has(keyOf(l)) ? { ...l, ...fn(l) } : l)));
  const setAttendance = (k: string, a: Attendance | "unset") =>
    patch(new Set([k]), (l) => (a === "unset" ? UNSET : { ...attendanceLine(a, l), recorded: true }));
  // the ones the bulk buttons reach: the not set in view, or else everyone in view
  const editableIn = (rows: Draft[]) => rows.filter((d) => canEdit(d.dept));
  const unsetInView = editableIn(searched).filter((d) => !d.recorded);
  const bulkTarget = unsetInView.length > 0 ? unsetInView : editableIn(shown);
  const setBulk = (a: Attendance) => {
    // a worker on vacation stays absent when the rest are put on a shift
    patch(new Set(bulkTarget.map(keyOf)), (l) => ({ ...attendanceLine(a, l, !l.recorded && !!byKey.get(keyOf(l))?.onVacation), recorded: true }));
  };
  const dayInView = editableIn(shown).filter((d) => attendanceOf(d) === "day");
  const allDayOnOt = dayInView.length > 0 && dayInView.every((d) => d.overtimeH === OT);
  // what Save sends: every line of the departments this person records, on the day
  const mine = draft.filter((d) => canEdit(d.dept) && byKey.has(keyOf(d)));
  const unsetEditable = mine.filter((d) => !d.recorded).length;

  function submit() {
    const fd = new FormData();
    fd.set("date", data.dateISO);
    // every department this user may record goes whole — the filter only
    // decides what is on screen, not what is saved
    fd.set("lines", JSON.stringify(mine));
    const s = shiftSplit(mine, hrs);
    save.run(saveShiftRoster, fd, `Saved — ${s.day.people} day shift, ${s.night.people} night shift, ${s.absent} absent · ${s.hours} man-hours.`);
  }

  async function clearDay() {
    const target = recordedHere.filter(canEdit);
    if (target.length === 0) return;
    const ok = await confirm({
      title: `Clear ${formatDate(data.dateISO)}?`,
      body: "Every worker of these departments goes back to not set, and the day's man-hours leave the calibration and the capacity check.",
      items: target.map((d) => WORKER_DEPT_LABEL[d]),
      confirmLabel: "Clear the day",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("date", data.dateISO);
    fd.set("depts", target.join(","));
    clear.run(clearShiftDay, fd, "Day cleared.", () => setDraft((d) => d.map((l) => (target.includes(l.dept) ? { ...l, ...UNSET, note: "" } : l))));
  }

  const capacityTone = capacity === null ? "" : split.hours >= capacity ? "text-ok-fg" : split.hours >= capacity * 0.8 ? "text-warn-fg" : "text-bad-fg";
  const filterLabel = rosterFilterLabel(filter);
  const togglePick = (p: RosterPick) => { setPick((cur) => (cur === p ? "all" : p)); setView("record"); };

  // the rows the board, the printout and the export carry: the view's line,
  // section and search, every attendance
  const boardLines: BoardLine[] = searched.map((d) => {
    const w = byKey.get(keyOf(d))!;
    const a = attendanceOf(d);
    return {
      key: keyOf(d), dept: d.dept, empId: w.empId, name: w.name, jobTitle: w.jobTitle, sectionLabels: w.sectionLabels, onVacation: w.onVacation,
      attendance: a, overtimeH: a === "day" ? d.overtimeH : 0, hours: a === "unset" ? 0 : lineHours(d, hrs), note: d.note,
    };
  });
  const exportRows = boardLines.map((l) => ({
    Date: data.dateISO,
    Badge: l.empId,
    Name: l.name,
    "Job title": l.jobTitle ?? "",
    Department: WORKER_DEPT_LABEL[l.dept],
    Section: l.sectionLabels.join(", "),
    Attendance: l.attendance === "unset" ? "Not set" : ATTENDANCE_LABEL[l.attendance],
    Time: l.attendance === "day" || l.attendance === "night" ? ATTENDANCE_TIME[l.attendance] : "",
    "Overtime h": l.overtimeH || "",
    Hours: l.attendance === "unset" ? "" : l.hours,
    Note: l.note,
  }));

  const printed = needle ? shiftSplit(searched, hrs) : split;
  const statusPill = allRecorded
    ? <span className="pill pill-ok">recorded{data.recordedBy ? ` · ${data.recordedBy}` : ""}</span>
    : recordedHere.length > 0
      ? <span className="pill pill-warn pill-wrap" title={`Recorded: ${recordedHere.map((d) => WORKER_DEPT_LABEL[d]).join(", ")}`}>{recordedHere.length} of {staffed.length} departments recorded</span>
      : <span className="pill pill-warn">not recorded yet</span>;

  // the record view's rows, by department
  const groups = staffed.map((dept) => ({ dept, rows: shown.filter((d) => d.dept === dept) })).filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-3">
      {confirmDialog}
      <PrintHeader title="Shift attendance" subtitle={filterLabel} date={formatDate(data.dateISO)} />
      <PrintScope parts={[needle && `Search: “${q.trim()}”`, `☀ Day ${printed.day.people} · 🌙 Night ${printed.night.people} · ✕ Absent ${printed.absent}${printed.unset ? ` · not set ${printed.unset}` : ""} · ${printed.hours} man-hours`, dirty && "UNSAVED — not recorded yet"]} />

      {/* the day at a glance — every figure is also the list's filter */}
      <div className="kpi-grid no-print" role="group" aria-label="Show only">
        <PickCard on={pick === "all"} onClick={() => togglePick("all")} label="All workers" icon={Users} value={split.workers} sub={split.unset ? `${split.workers - split.unset} set · ${split.unset} not set` : split.workers ? "everyone set" : "nobody in this view"} />
        <PickCard on={pick === "day"} onClick={() => togglePick("day")} label="Day" time={SHORT_TIME.day} icon={Sun} accent="kpi-accent-day" value={split.day.people} sub={`${split.day.hours} mh${split.day.overtimePeople ? ` · ${split.day.overtimePeople} on OT` : ""}`} />
        <PickCard on={pick === "night"} onClick={() => togglePick("night")} label="Night" time={SHORT_TIME.night} icon={Moon} accent="kpi-accent-night" value={split.night.people} sub={`${split.night.hours} mh`} />
        <PickCard on={pick === "overtime"} onClick={() => togglePick("overtime")} label="Overtime" time={SHORT_TIME.overtime} timeOnPhone={false} icon={Clock3} accent="kpi-accent-day" value={split.day.overtimePeople} sub={`${split.day.overtimeH} h · day shift only`} />
        <PickCard on={pick === "absent"} onClick={() => togglePick("absent")} label="Absent" icon={UserX} accent="kpi-accent-bad" value={split.absent} sub={onVacationAbsent ? `${onVacationAbsent} on vacation` : "did not come"} />
        <PickCard on={pick === "unset"} onClick={() => togglePick("unset")} label="Not set" icon={CircleHelp} accent={split.unset ? "kpi-accent-warn" : undefined} tone={split.unset ? "text-warn-fg" : ""} value={split.unset} sub={split.unset ? "set them to save the day" : "nothing left"} />
        <div className="kpi">
          <span className="kpi-label"><Gauge size={13} aria-hidden />Man-hours</span>
          <span className={`kpi-value block tabnum ${capacityTone}`}>{split.hours}</span>
          <span className="kpi-sub block">{capacity !== null ? `of ${round1(capacity)} mh/day capacity` : "no capacity figure set"}</span>
        </div>
      </div>

      {/* one bar: the view, the line and section, the search, the sheet's own buttons */}
      <div className="toolbar !mb-0 no-print">
        <div className="toolbar-row">
          <div className="segmented" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "record"} onClick={() => setView("record")}><ClipboardList size={14} aria-hidden className="inline -mt-0.5 me-1" />Record</button>
            <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}><LayoutGrid size={14} aria-hidden className="inline -mt-0.5 me-1" />Day / Night board</button>
          </div>
          <span className="toolbar-sep max-sm:hidden" aria-hidden />
          <nav className="seg" aria-label="Line">
            <button type="button" className={filter === "" ? "on" : ""} aria-pressed={filter === ""} onClick={() => setFilter("")}>Everyone</button>
            {WORKER_GROUPS.map((g) => (
              <button key={g.key} type="button" className={lineOfFilter === g.key ? "on" : ""} aria-pressed={lineOfFilter === g.key} onClick={() => setFilter(`line:${g.key}`)}>{g.label}</button>
            ))}
          </nav>
          <FilterSelect label="Section" value={sectionValue} options={sectionOptions} allLabel="All" onChange={(v) => setFilter(v || (lineOfFilter ? `line:${lineOfFilter}` : ""))} />
          <SearchBox value={q} onChange={setQ} placeholder="Search name or badge…" />
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {statusPill}
            {dirty && <span className="pill pill-warn">unsaved changes</span>}
            <PrintButton />
            <ExportButton rows={exportRows} filename={`shift-attendance-${data.dateISO}.xlsx`} sheetName="Attendance" />
            {recordedHere.some(canEdit) && (
              <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={clear.pending} onClick={clearDay}>
                Clear {filter === "" ? "the day" : filterLabel}
              </button>
            )}
          </div>
        </div>
      </div>

      {(save.msg || clear.msg) && (
        <div className="flex flex-wrap gap-x-4 no-print">
          <Msg msg={save.msg} />
          <Msg msg={clear.msg} />
        </div>
      )}

      {/* the record view on screen; the board is the printout of either */}
      <div className={view === "board" ? "" : "hidden print:block"}>
        <ShiftBoard lines={boardLines} />
      </div>

      {view === "record" && (
        <section className="bg-surface border rounded-xl overflow-hidden print:hidden">
          {shown.length === 0 ? (
            <EmptyState
              icon={Users}
              title={draft.length === 0 ? "Nobody is registered yet" : needle ? "Nobody matches the search" : pick !== "all" ? "Nobody in this group" : `Nobody is registered in ${filterLabel} yet`}
              hint={draft.length === 0 ? "Add people in Tools → Production Workers and tick their sections." : needle || pick !== "all" ? "Clear the search, or click the highlighted figure again to show everyone." : undefined}
            />
          ) : (
            <TableFrame>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <Th label="Worker" />
                    <Th label="Section" className="max-md:hidden" />
                    <Th label="Attendance" full="Attendance — the shift he came on" hint={`Day ${ATTENDANCE_TIME.day} · Night ${ATTENDANCE_TIME.night}. Click the picked one again to clear it.`} />
                    <Th label="Overtime" full={`Overtime ${OVERTIME_TIME}`} hint="Day shift only." />
                    <Th label="Hours" num className="text-right" hint="Shift plus overtime; nothing when absent." />
                    <Th label="Note" />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const gs = shiftSplit(g.rows, hrs);
                    return [
                      <tr key={`h-${g.dept}`} className="bg-surface-2">
                        <th colSpan={6} scope="colgroup" className="px-2 py-1.5 text-start text-xs font-bold">
                          <span className="uppercase tracking-wide">{WORKER_DEPT_LABEL[g.dept]}</span>
                          <span className="ms-2 inline-flex flex-wrap items-center gap-1.5 align-middle font-semibold normal-case">
                            <span className="shift-tag shift-tag-day"><Sun size={12} aria-hidden />{gs.day.people}</span>
                            <span className="shift-tag shift-tag-night"><Moon size={12} aria-hidden />{gs.night.people}</span>
                            {gs.absent > 0 && <span className="pill pill-bad tabnum">{gs.absent} absent</span>}
                            {gs.unset > 0 && <span className="pill pill-warn tabnum">{gs.unset} not set</span>}
                            {!canEdit(g.dept) && <span className="text-muted">· view only</span>}
                          </span>
                        </th>
                      </tr>,
                      ...g.rows.map((l) => {
                        const w = byKey.get(keyOf(l))!;
                        const k = keyOf(l);
                        const a = attendanceOf(l);
                        const ro = !canEdit(l.dept) || save.pending;
                        return (
                          <tr key={k} className={a === "unset" ? "bg-warn-bg/25" : a === "absent" ? "bg-surface-2/50" : ""}>
                            <td className="px-2 whitespace-nowrap">
                              <span className="inline-flex items-baseline gap-2">
                                <span className={`font-bold ${a === "absent" ? "text-muted" : ""}`}>{w.name}</span>
                                <span className="text-[13px] text-muted ltr tabnum">{w.empId}</span>
                                {w.jobTitle && <span className="text-xs text-muted max-lg:hidden">{w.jobTitle}</span>}
                                {w.onVacation && <span className="pill pill-warn" title="On vacation — set Absent unless he came">vacation</span>}
                              </span>
                            </td>
                            <td className="px-2 whitespace-nowrap max-md:hidden">
                              {w.sectionLabels.length > 0 ? w.sectionLabels.map((s) => <span key={s} className="pill pill-muted me-1">{s}</span>) : <span className="text-xs text-muted">{WORKER_DEPT_LABEL[l.dept]}</span>}
                            </td>
                            <td className="px-2">
                              <AttendancePicker value={a} disabled={ro} name={w.name} onPick={(v) => setAttendance(k, v)} />
                            </td>
                            <td className="px-2 whitespace-nowrap">
                              {a === "day" ? (
                                <button
                                  type="button" disabled={ro} aria-pressed={l.overtimeH === OT}
                                  aria-label={`${w.name}: overtime ${OVERTIME_TIME}`}
                                  className={`btn btn-sm ${l.overtimeH === OT ? "btn-primary" : "btn-ghost"}`}
                                  onClick={() => patch(new Set([k]), () => ({ overtimeH: l.overtimeH === OT ? 0 : OT }))}
                                >
                                  <Clock3 size={14} aria-hidden />{l.overtimeH === OT ? `+${OT} h` : "No OT"}
                                </button>
                              ) : (
                                <span className="text-xs text-muted">—</span>
                              )}
                            </td>
                            <td className={`px-2 text-right tabnum font-bold ${a === "unset" || a === "absent" ? "text-muted" : ""}`}>{a === "unset" ? "—" : lineHours(l, hrs)}</td>
                            <td className="px-2">
                              {/* a note never sets the worker: a not-set row stays not set */}
                              <input value={l.note} disabled={ro} placeholder="Note…" aria-label={`${w.name}: note`} onChange={(e) => patch(new Set([k]), () => ({ note: e.target.value }))} className="ctl w-full min-w-[8rem]" />
                            </td>
                          </tr>
                        );
                      }),
                    ];
                  })}
                </tbody>
              </table>
            </TableFrame>
          )}
        </section>
      )}

      {/* saving stays in reach however long the list is — while there is
          something to save: a day not recorded yet, or changes */}
      {anyEditable && (dirty || unsetEditable > 0 || !allMineRecorded) && (
        <div className="sticky bottom-0 z-10 -mx-3 md:-mx-4 border-t bg-surface/95 backdrop-blur ps-3 md:ps-4 pe-20 py-2 no-print">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={save.pending || unsetEditable > 0 || (!dirty && allMineRecorded)} onClick={submit} title={unsetEditable > 0 ? "Set every worker first" : undefined}>
              {save.pending ? "Saving…" : allMineRecorded ? "Save changes" : "Save day"}
            </button>
            {bulkTarget.length > 0 && (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className={`text-sm font-semibold ${unsetInView.length > 0 ? "text-warn-fg" : "text-muted"}`}>
                  {unsetInView.length > 0 ? `Set ${unsetInView.length} not set to` : `Set ${bulkTarget.length} shown to`}
                </span>
                <span className="att" role="group" aria-label="Set them all">
                  {ATTENDANCES.map((a) => {
                    const Icon = ATT_ICON[a];
                    return <button key={a} type="button" data-att={a} disabled={save.pending} onClick={() => setBulk(a)}><Icon size={14} aria-hidden />{ATTENDANCE_LABEL[a]}</button>;
                  })}
                </span>
              </span>
            )}
            {pick === "day" && dayInView.length > 0 && (
              <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => patch(new Set(dayInView.map(keyOf)), () => ({ overtimeH: allDayOnOt ? 0 : OT }))}>
                <Clock3 size={14} aria-hidden />{allDayOnOt ? "Remove OT from the shown" : `+${OT} h OT for the ${dayInView.length} shown`}
              </button>
            )}
            {unsetEditable > unsetInView.length && <span className="pill pill-warn pill-wrap">{unsetEditable - unsetInView.length} more not set outside this view</span>}
            {dirty && <button type="button" className="btn btn-sm btn-ghost" disabled={save.pending} onClick={() => setDraft(data.lines.map(toDraft))}>Undo changes</button>}
          </div>
        </div>
      )}

      {/* the days recorded, for what the filter shows */}
      <section className="no-print">
        <h2>Last days recorded — {filterLabel}</h2>
        {history.length === 0 ? (
          <div className="rounded-xl border border-dashed"><EmptyState compact icon={CalendarDays} title="Nothing recorded yet" hint="Save a day and it is listed here." /></div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {history.map((h) => (
              <Link
                key={h.dateISO} href={`/shifts?day=${h.dateISO}${filter ? `&sec=${filter}` : ""}`}
                className={`chip tabnum ${h.dateISO === data.dateISO ? "chip-on" : ""}`}
                title={h.day + h.night > 0 ? `Open ${formatDate(h.dateISO)}: ${h.day} on the day shift, ${h.night} on the night shift, ${h.hours} man-hours` : `Open ${formatDate(h.dateISO)}: ${h.people} present, ${h.hours} man-hours`}
              >
                {formatDate(h.dateISO)}
                {h.day + h.night > 0 ? (
                  <>
                    <span className="shift-tag shift-tag-day"><Sun size={11} aria-hidden />{h.day}</span>
                    <span className="shift-tag shift-tag-night"><Moon size={11} aria-hidden />{h.night}</span>
                  </>
                ) : h.people > 0 && <span>{h.people} present</span>}
                <span className="text-muted">{h.hours} mh</span>
              </Link>
            ))}
            {history[0].dateISO !== today && !allRecorded && data.dateISO === today && <span className="pill pill-warn">today not recorded</span>}
          </div>
        )}
      </section>

      {/* What a shift is worth — the codes on every line are the day and the
          night shift; the hours behind them are the plant's to set. */}
      {canSetHours && (
        <section className="bg-surface border rounded-xl no-print">
          <button type="button" onClick={() => setHoursOpen((v) => !v)} className="w-full flex items-center gap-2 p-3 text-start" aria-expanded={hoursOpen}>
            <span className={`inline-block transition-transform duration-150 ${hoursOpen ? "rotate-90" : ""}`} aria-hidden>▶</span>
            <b className="text-sm">Shift hours</b>
            <span className="text-xs text-muted tabnum">day {round1(hrs.short)} h · night {round1(hrs.long)} h · overtime {round1(hrs.overtime)} h</span>
            <span className="ms-auto text-xs text-muted">{hoursOpen ? "Close" : "Change"}</span>
          </button>
          {hoursOpen && (
            <div className="px-3 pb-3 border-t pt-3">
              <p className="text-xs text-muted mb-3">
                The net hours the day and the night shift are worth, and what the {OVERTIME_TIME} overtime adds. Every man-hour the app counts uses them; days already recorded are re-counted with the new figures.
              </p>
              <ShiftHoursForm short={hrs.short} long={hrs.long} overtime={hrs.overtime} compact />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
