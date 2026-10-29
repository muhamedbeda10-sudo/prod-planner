"use client";

import { EmptyState } from "@/components/primitives";
import { Clock3, ClipboardList, Gauge, LayoutGrid, Moon, Sun, UserX, Users, CircleHelp } from "lucide-react";
import { formatDate } from "@/lib/domain/format";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  ATTENDANCES, ATTENDANCE_LABEL, ATTENDANCE_TIME, DEFAULT_SHIFT_HOURS, DEPT_CENTRES, OVERTIME_TIME, NIGHT_OVERTIME_TIME, overtimeHoursFor, overtimeTime, UNSET_LINE, WORK_CENTRE_LABEL, attendanceLine, attendanceOf, centreOf, lineHours, rosterLineReading, round1, shiftSplit,
  type Attendance, type RosterDept, type WorkCentre,
} from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL, WORKER_GROUPS } from "@/lib/domain/tanks";
import { ROSTER_SECTIONS, rosterDepts, rosterLineMatches, type RosterFilter, rosterFilterLabel } from "@/lib/domain/roster";
import type { ShiftLineDTO, ShiftRosterData } from "@/lib/server/shifts";
import { clearShiftDay, saveShiftRoster } from "@/app/shifts/actions";
import { ShiftBoard, type BoardLine } from "@/components/ShiftBoard";
import { FilterSelect, SearchBox } from "@/components/FilterControls";
import { TableFrame, Th, useConfirm } from "@/components/DataTable";
import { SAVE_UNCONFIRMED } from "@/components/ui";
import { PrintHeader, PrintScope } from "@/components/PrintHeader";
import { reconcileShiftDrafts, replaceShiftDepartment, shiftDepartmentDirty, type ShiftDraft } from "@/lib/domain/shiftDraft";

// The shift roster — one day, every worker of every section. Each worker gets
// ONE choice that says both whether he came and on which shift: ☀ Day
// (07:00–16:00), 🌙 Night (19:00–04:00) or ✕ Absent; none picked is "not set",
// and a department is saved only when nobody in that department is. The figures on top are the filters:
// who came on the day shift, who on the night shift, overtime, absent, not set.
// The board view puts the two shifts' people side by side — the printout.

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) => {
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await fn(fd);
        setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
        if (res.ok) { after?.(); router.refresh(); }
      } catch { setMsg({ ok: false, text: SAVE_UNCONFIRMED }); }
    });
  };
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p role="status" className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

type Draft = ShiftDraft;
const toDraft = (l: ShiftLineDTO): Draft => ({ workerId: l.workerId, dept: l.dept, present: l.present, shift: l.shift, overtimeH: l.overtimeH, center: l.center, note: l.note, recorded: l.recorded });
const UNSET = { ...UNSET_LINE, recorded: false } as const;
/** What the list is narrowed to by the figures on top. */
type RosterPick = "all" | Attendance | "overtime" | "unset";
type View = "record" | "board";
const keyOf = (l: { workerId: number; dept: string }) => `${l.dept}|${l.workerId}`;

const ATT_ICON = { day: Sun, night: Moon, absent: UserX } as const;
/** The clock times as the cards on top fit them. */
const SHORT_TIME = { day: "07–16", night: "19–04", overtime: "16–19" } as const;

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

export function ShiftRoster({ data, editableDepts, filter }: {
  data: ShiftRosterData;
  /** The departments this user may record — the rest are read-only rows. */
  editableDepts: RosterDept[];
  filter: RosterFilter;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const save = useAction();
  const clear = useAction();
  const [confirm, confirmDialog] = useConfirm();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<RosterPick>("all");
  const [view, setView] = useState<View>("record");
  const [editorState, setEditorState] = useState(() => {
    const rows = data.lines.map(toDraft);
    return { draft: rows, baseline: rows, source: data.lines };
  });
  const { draft, baseline } = editorState;
  if (editorState.source !== data.lines) {
    const fresh = data.lines.map(toDraft);
    setEditorState({ draft: reconcileShiftDrafts(draft, baseline, fresh), baseline: fresh, source: data.lines });
  }
  const setDraft = (value: Draft[] | ((rows: Draft[]) => Draft[])) => setEditorState((old) => ({ ...old, draft: typeof value === "function" ? value(old.draft) : value }));
  const busy = save.pending || clear.pending;
  const canEdit = (d: RosterDept) => editableDepts.includes(d);
  const availableDepts = rosterDepts(filter).filter((d) => data.lines.some((l) => l.dept === d));
  const [chosenDept, setChosenDept] = useState<RosterDept | null>(() => availableDepts.find(canEdit) ?? availableDepts[0] ?? null);
  const department = chosenDept && availableDepts.includes(chosenDept) ? chosenDept : availableDepts.find(canEdit) ?? availableDepts[0] ?? null;
  const departmentName = department ? WORKER_DEPT_LABEL[department] : "department";
  const selectDepartment = (dept: RosterDept) => { if (busy) return; setChosenDept(dept); setQ(""); setPick("all"); setView("record"); };
  const nextDepartment = department ? availableDepts.slice(availableDepts.indexOf(department) + 1).find(canEdit) : undefined;
  const byKey = useMemo(() => new Map(data.lines.map((l) => [keyOf(l), l])), [data.lines]);
  const hrs = data.shiftHours ?? DEFAULT_SHIFT_HOURS;

  const setFilter = (v: string) => {
    if (busy) return;
    setQ(""); setPick("all");
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
  const inFilter = useMemo(() => draft.filter((d) => { const w = byKey.get(keyOf(d)); return !!w && rosterLineMatches(w, filter) && (view === "board" || d.dept === department); }), [draft, byKey, filter, view, department]);
  const searched = useMemo(() => inFilter.filter((d) => {
    if (!needle) return true;
    const l = byKey.get(keyOf(d))!;
    return `${l.name} ${l.empId} ${l.jobTitle ?? ""} ${l.sectionLabels.join(" ")}`.toLowerCase().includes(needle);
  }), [inFilter, byKey, needle]);
  const matchesPick = (d: Draft) => {
    if (pick === "all") return true;
    const a = attendanceOf(d);
    if (pick === "overtime") return (a === "day" || a === "night") && d.overtimeH > 0;
    return a === pick;
  };
  const shown = searched.filter(matchesPick);
  const split = useMemo(() => shiftSplit(inFilter, hrs), [inFilter, hrs]);
  const onVacationAbsent = inFilter.filter((d) => attendanceOf(d) === "absent" && byKey.get(keyOf(d))?.onVacation).length;

  const depts = view === "record" ? department ? [department] : [] : rosterDepts(filter);
  const capacity = depts.reduce<number | null>((s, d) => (data.capacityMh[d] == null ? s : (s ?? 0) + data.capacityMh[d]!), null);
  const dirty = shiftDepartmentDirty(draft, baseline);
  const departmentDirty = department ? shiftDepartmentDirty(draft, baseline, department) : false;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const anyEditable = !!department && canEdit(department);
  // a department nobody is registered in has nothing to record
  const staffed = view === "record" && department ? [department] : depts.filter((d) => inFilter.some((l) => l.dept === d));
  const recordedHere = staffed.filter((d) => baseline.some((l) => l.dept === d && l.recorded));
  const isRecorded = (dept: RosterDept) => { const rows = baseline.filter((r) => r.dept === dept); return rows.length > 0 && rows.every((r) => r.recorded); };
  const allRecorded = staffed.length > 0 && staffed.every(isRecorded);
  // what this person saves: the departments they may record
  const editableStaffed = staffed.filter(canEdit);
  const allMineRecorded = editableStaffed.length > 0 && editableStaffed.every(isRecorded);

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
  const presentInView = editableIn(shown).filter((d) => d.recorded && d.present);
  const allShownOnOt = presentInView.length > 0 && presentInView.every((d) => d.overtimeH === overtimeHoursFor(d.shift, hrs));
  // Save the whole selected department, including workers hidden by search/section/KPI filters.
  // Other departments never enter the payload or block this department's save.
  const mine = draft.filter((d) => d.dept === department && canEdit(d.dept) && byKey.has(keyOf(d)));
  const unsetEditable = mine.filter((d) => !d.recorded).length;

  function submit(advance = false) {
    if (busy || !department || !mine.length || unsetEditable > 0) return;
    if (!departmentDirty && allMineRecorded) { if (advance && nextDepartment) selectDepartment(nextDepartment); return; }
    const fd = new FormData();
    fd.set("date", data.dateISO);
    const submitted = mine.map((r) => ({ ...r, note: r.note.trim() }));
    fd.set("lines", JSON.stringify(submitted));
    const s = shiftSplit(submitted, hrs);
    save.run(saveShiftRoster, fd, `${departmentName} saved — ${s.day.people} day shift, ${s.night.people} night shift, ${s.absent} absent · ${s.hours} man-hours.`, () => {
      setEditorState((old) => ({ ...old, draft: replaceShiftDepartment(old.draft, department, submitted), baseline: replaceShiftDepartment(old.baseline, department, submitted) }));
      if (advance && nextDepartment) selectDepartment(nextDepartment);
    });
  }

  async function clearDay() {
    const target = department && canEdit(department) && recordedHere.includes(department) ? [department] : [];
    if (target.length === 0) return;
    const ok = await confirm({
      title: `Clear ${departmentName} on ${formatDate(data.dateISO)}?`,
      body: `Return every worker in ${departmentName} to not set and remove this department's daily man-hours from calibration and capacity calculations.`,
      items: target.map((d) => WORKER_DEPT_LABEL[d]),
      confirmLabel: "Clear department",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("date", data.dateISO);
    fd.set("depts", target.join(","));
    clear.run(clearShiftDay, fd, `${departmentName} attendance cleared.`, () => setEditorState((old) => {
      const cleared = old.draft.filter((l) => target.includes(l.dept)).map((l) => ({ ...l, ...UNSET, center: centreOf(l.dept, byKey.get(keyOf(l))?.sections ?? []), note: "" }));
      return { ...old, draft: replaceShiftDepartment(old.draft, department!, cleared), baseline: replaceShiftDepartment(old.baseline, department!, cleared) };
    }));
  }

  const capacityTone = capacity === null ? "" : split.hours >= capacity ? "text-ok-fg" : split.hours >= capacity * 0.8 ? "text-warn-fg" : "text-bad-fg";
  const filterLabel = view === "record" && department ? `${departmentName}${sectionValue ? ` · ${rosterFilterLabel(filter)}` : ""}` : rosterFilterLabel(filter);
  const togglePick = (p: RosterPick) => { setPick((cur) => (cur === p ? "all" : p)); setView("record"); };

  // the rows the board, the printout and the export carry: the view's line,
  // section and search, every attendance
  const boardLines: BoardLine[] = searched.map((d) => {
    const w = byKey.get(keyOf(d))!;
    return {
      key: keyOf(d), dept: d.dept, empId: w.empId, name: w.name, jobTitle: w.jobTitle, sectionLabels: w.sectionLabels, onVacation: w.onVacation,
      ...rosterLineReading(d, hrs), note: d.note,
    };
  });

  const printed = needle ? shiftSplit(searched, hrs) : split;
  const statusPill = allRecorded
    ? <span className="pill pill-ok">recorded</span>
    : view === "record" && recordedHere.length > 0
      ? <span className="pill pill-warn">partially recorded</span>
    : recordedHere.length > 0
      ? <span className="pill pill-warn pill-wrap" title={`Recorded: ${staffed.filter(isRecorded).map((d) => WORKER_DEPT_LABEL[d]).join(", ")}`}>{staffed.filter(isRecorded).length} of {staffed.length} departments recorded</span>
      : <span className="pill pill-warn">not recorded yet</span>;

  // the record view's rows, by department
  const groups = staffed.map((dept) => ({ dept, rows: shown.filter((d) => d.dept === dept) })).filter((g) => g.rows.length > 0);
  // Fabrication books each worker to a centre — the column shows while it is on screen
  const showCentre = groups.some((g) => g.dept === "Cut");
  const cols = showCentre ? 7 : 6;

  return (
    <div className="space-y-3">
      {confirmDialog}
      <PrintHeader title="Shift attendance" />
      <PrintScope parts={[needle && `Search: “${q.trim()}”`, `☀ Day ${printed.day.people} · 🌙 Night ${printed.night.people} · ✕ Absent ${printed.absent}${printed.unset ? ` · not set ${printed.unset}` : ""} · ${printed.hours} man-hours`, (view === "record" ? departmentDirty : dirty) && "UNSAVED — not recorded yet"]} />

      <section className="rounded-xl border bg-surface p-3 no-print" aria-label="Record attendance by department">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <h2 className="!mb-0">Choose a department</h2>
          <p className="explain text-xs text-muted">{availableDepts.filter(isRecorded).length} of {availableDepts.length} recorded · each department saves separately</p>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="Attendance departments">
          {availableDepts.map((dept) => {
            const rows = draft.filter((r) => r.dept === dept);
            const unset = rows.filter((r) => !r.recorded).length;
            const changed = shiftDepartmentDirty(draft, baseline, dept);
            const status = unset ? `${unset} not set` : changed || !isRecorded(dept) ? "Ready to save" : "Recorded";
            return <button key={dept} type="button" disabled={busy} aria-pressed={view === "record" && department === dept} aria-label={`Record ${WORKER_DEPT_LABEL[dept]}`} onClick={() => selectDepartment(dept)} className={`rounded-lg border px-3 py-2 text-left ${view === "record" && department === dept ? "border-brand bg-brand-light/40 ring-1 ring-brand" : "bg-surface"}`}>
              <span className="block text-sm font-semibold">{WORKER_DEPT_LABEL[dept]} <span className="text-muted font-normal tabnum">· {rows.length}</span></span>
              <span className={`block text-xs ${unset || changed ? "text-warn-fg" : "text-ok-fg"}`}>{status}{!canEdit(dept) ? " · view only" : ""}</span>
            </button>;
          })}
        </nav>
        {view === "record" && department && <p className="explain text-xs text-muted mt-2">Showing {departmentName}. Other departments can stay not set.{(needle || sectionValue || pick !== "all") && " Save includes every worker in this department, including those hidden by filters."}</p>}
      </section>

      {/* the day at a glance — every figure is also the list's filter */}
      <div className="kpi-grid no-print" role="group" aria-label="Show only">
        <PickCard on={pick === "all"} onClick={() => togglePick("all")} label="All workers" icon={Users} value={split.workers} sub={split.unset ? `${split.workers - split.unset} set · ${split.unset} not set` : split.workers ? "everyone set" : "nobody in this view"} />
        <PickCard on={pick === "day"} onClick={() => togglePick("day")} label="Day" time={SHORT_TIME.day} icon={Sun} accent="kpi-accent-day" value={split.day.people} sub={`${split.day.hours} mh${split.day.overtimePeople ? ` · ${split.day.overtimePeople} on OT` : ""}`} />
        <PickCard on={pick === "night"} onClick={() => togglePick("night")} label="Night" time={SHORT_TIME.night} icon={Moon} accent="kpi-accent-night" value={split.night.people} sub={`${split.night.hours} mh${split.night.overtimePeople ? ` · ${split.night.overtimePeople} on OT` : ""}`} />
        <PickCard on={pick === "overtime"} onClick={() => togglePick("overtime")} label="Overtime" icon={Clock3} accent="kpi-accent-day" value={split.day.overtimePeople + split.night.overtimePeople} sub={`${split.day.overtimeH + split.night.overtimeH} h · ${split.day.overtimePeople} day / ${split.night.overtimePeople} night`} />
        <PickCard on={pick === "absent"} onClick={() => togglePick("absent")} label="Absent" icon={UserX} accent="kpi-accent-bad" value={split.absent} sub={onVacationAbsent ? `${onVacationAbsent} on vacation` : "did not come"} />
        <PickCard on={pick === "unset"} onClick={() => togglePick("unset")} label="Not set" icon={CircleHelp} accent={split.unset ? "kpi-accent-warn" : undefined} tone={split.unset ? "text-warn-fg" : ""} value={split.unset} sub={split.unset ? "set them to save this department" : "nothing left"} />
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
            <button type="button" disabled={busy} aria-pressed={view === "record"} onClick={() => setView("record")}><ClipboardList size={14} aria-hidden className="inline -mt-0.5 me-1" />Record</button>
            <button type="button" disabled={busy} aria-pressed={view === "board"} onClick={() => setView("board")}><LayoutGrid size={14} aria-hidden className="inline -mt-0.5 me-1" />Day / Night board</button>
          </div>
          <span className="toolbar-sep max-sm:hidden" aria-hidden />
          <nav className="seg" aria-label="Line">
            <button type="button" disabled={busy} className={filter === "" ? "on" : ""} aria-pressed={filter === ""} onClick={() => setFilter("")}>Everyone</button>
            {WORKER_GROUPS.map((g) => (
              <button key={g.key} type="button" disabled={busy} className={lineOfFilter === g.key ? "on" : ""} aria-pressed={lineOfFilter === g.key} onClick={() => setFilter(`line:${g.key}`)}>{g.label}</button>
            ))}
          </nav>
          <FilterSelect label="Section" value={sectionValue} options={sectionOptions} allLabel="All" onChange={(v) => setFilter(v || (lineOfFilter ? `line:${lineOfFilter}` : ""))} />
          <SearchBox value={q} onChange={setQ} placeholder="Search name or badge…" />
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {statusPill}
            {(view === "record" ? departmentDirty : dirty) && <span className="pill pill-warn">unsaved changes</span>}
            {view === "record" && recordedHere.some(canEdit) && (
              <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={busy} onClick={clearDay}>
                Clear {departmentName}
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
              <table className="table-cards w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <Th label="Worker" />
                    <Th label="Section" className="max-md:hidden" />
                    <Th label="Attendance" full="Attendance — the shift he came on" hint={`Day ${ATTENDANCE_TIME.day} · Night ${ATTENDANCE_TIME.night}. Click the picked one again to clear it.`} />
                    {showCentre && <Th label="Work centre" hint="Fabrication: laser / punch, bending or fin folding — his section's unless he moved that day. Each centre's hours are measured against what it produced." />}
                    <Th label="Overtime" full="Optional overtime" hint={`Day ${OVERTIME_TIME} · Night ${NIGHT_OVERTIME_TIME} (next day).`} />
                    <Th label="Hours" num className="text-right" hint="Shift plus overtime; nothing when absent." />
                    <Th label="Note" />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const gs = shiftSplit(g.rows, hrs);
                    return [
                      <tr key={`h-${g.dept}`} className="bg-surface-2">
                        <th colSpan={cols} scope="colgroup" className="px-2 py-1.5 text-start text-xs font-bold">
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
                        const ro = !canEdit(l.dept) || busy;
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
                            {showCentre && (
                              <td className="px-2">
                                {l.dept === "Cut" ? (
                                  <select
                                    value={l.center ?? ""} disabled={ro || a === "absent" || a === "unset"}
                                    aria-label={`${w.name}: work centre`}
                                    onChange={(e) => patch(new Set([k]), () => ({ center: e.target.value as WorkCentre }))}
                                    className="ctl"
                                  >
                                    {DEPT_CENTRES.Cut.map((c) => <option key={c} value={c}>{WORK_CENTRE_LABEL[c]}</option>)}
                                  </select>
                                ) : <span className="text-xs text-muted">—</span>}
                              </td>
                            )}
                            <td className="px-2 whitespace-nowrap">
                              {a === "day" || a === "night" ? (
                                <button
                                  type="button" disabled={ro} aria-pressed={l.overtimeH > 0 && l.overtimeH === overtimeHoursFor(l.shift, hrs)}
                                  aria-label={`${w.name}: overtime ${overtimeTime(l.shift)}`}
                                  className={`btn btn-sm ${l.overtimeH > 0 && l.overtimeH === overtimeHoursFor(l.shift, hrs) ? "btn-primary" : "btn-ghost"}`}
                                  onClick={() => patch(new Set([k]), () => ({ overtimeH: l.overtimeH > 0 ? 0 : overtimeHoursFor(l.shift, hrs) }))}
                                >
                                  <Clock3 size={14} aria-hidden />{l.overtimeH > 0 ? `+${l.overtimeH} h` : "No OT"}
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
      {view === "record" && anyEditable && (
        <div className="sticky bottom-0 z-10 -mx-3 md:-mx-4 border-t bg-surface/95 backdrop-blur ps-3 md:ps-4 pe-20 py-2 no-print">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={busy || !mine.length || unsetEditable > 0 || (!departmentDirty && allMineRecorded)} onClick={() => submit()} title={unsetEditable > 0 ? `Set every worker in ${departmentName} first` : undefined}>
              {save.pending ? "Saving…" : !departmentDirty && allMineRecorded ? `${departmentName} saved` : `Save ${departmentName}`}
            </button>
            {nextDepartment && <button type="button" className="btn btn-secondary" aria-label={!departmentDirty && allMineRecorded ? "Next department" : "Save & next department"} disabled={busy || unsetEditable > 0} onClick={() => submit(true)}>{!departmentDirty && allMineRecorded ? "Next department" : "Save & next"}</button>}
            {bulkTarget.length > 0 && (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className={`text-sm font-semibold ${unsetInView.length > 0 ? "text-warn-fg" : "text-muted"}`}>
                  <span className="sm:hidden">Set {bulkTarget.length}:</span><span className="hidden sm:inline">{unsetInView.length > 0 ? `Set ${unsetInView.length} not set to` : `Set ${bulkTarget.length} shown to`}</span>
                </span>
                <span className="att" role="group" aria-label="Set them all">
                  {ATTENDANCES.map((a) => {
                    const Icon = ATT_ICON[a];
                    return <button key={a} type="button" data-att={a} disabled={busy} onClick={() => setBulk(a)}><Icon size={14} aria-hidden />{ATTENDANCE_LABEL[a]}</button>;
                  })}
                </span>
              </span>
            )}
            {presentInView.length > 0 && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => patch(new Set(presentInView.map(keyOf)), (l) => ({ overtimeH: allShownOnOt ? 0 : overtimeHoursFor(l.shift, hrs) }))}>
                <Clock3 size={14} aria-hidden />{allShownOnOt ? "Remove OT from the shown" : `Add OT for the ${presentInView.length} shown`}
              </button>
            )}
            {unsetEditable > unsetInView.length && <span className="pill pill-warn pill-wrap">{unsetEditable - unsetInView.length} more not set in {departmentName} outside this view</span>}
            {departmentDirty && <button type="button" className="btn btn-sm btn-ghost" aria-label={`Undo ${departmentName} changes`} disabled={busy} onClick={() => setDraft((rows) => replaceShiftDepartment(rows, department!, baseline.filter((r) => r.dept === department)))}>Undo changes</button>}
          </div>
        </div>
      )}

    </div>
  );
}
