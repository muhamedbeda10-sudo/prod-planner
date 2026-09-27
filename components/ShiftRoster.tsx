"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";
import { DEFAULT_SHIFT_HOURS, SHIFT_CODES, dayTotals, lineHours, round1, shiftLabel, type RosterDept, type ShiftCode } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL, WORKER_GROUPS, WORKER_SECTIONS } from "@/lib/domain/tanks";
import { rosterDepts, rosterLineMatches, type RosterFilter, rosterFilterLabel } from "@/lib/domain/roster";
import type { ShiftLineDTO, ShiftRosterData } from "@/lib/server/shifts";
import { clearShiftDay, saveShiftRoster } from "@/app/shifts/actions";
import { ShiftHoursForm } from "@/components/ShiftHoursForm";

// The shift roster — one day, one table, every worker of every section. The
// filter row on top narrows it to a line or a section; the cards count what
// the filter shows. The supervisor edits the exceptions (an absence, an
// 11-hour shift, overtime) and saves the day once — no machines, no
// downtime: people and hours only.

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
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

function shiftISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ShiftDayPicker({ day, today }: { day: string; today: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (v: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("day", v);
    router.push(`${pathname}?${p}`);
  };
  return (
    <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
      <button type="button" className="btn btn-sm" onClick={() => go(shiftISO(day, -1))} title="Previous day">‹</button>
      <input type="date" aria-label="Day" value={day} max={today} onChange={(e) => e.target.value && go(e.target.value)} className="border rounded-md px-2 py-1.5 bg-surface font-bold ltr tabnum" />
      <button type="button" className="btn btn-sm" disabled={day >= today} onClick={() => go(shiftISO(day, 1))} title="Next day">›</button>
      {day !== today && <button type="button" className="btn btn-sm btn-ghost" onClick={() => go(today)}>Today</button>}
    </div>
  );
}

type Draft = Pick<ShiftLineDTO, "workerId" | "dept" | "present" | "shift" | "overtimeH" | "note">;
const toDraft = (l: ShiftLineDTO): Draft => ({ workerId: l.workerId, dept: l.dept, present: l.present, shift: l.shift, overtimeH: l.overtimeH, note: l.note });
const keyOf = (l: { workerId: number; dept: string }) => `${l.dept}|${l.workerId}`;

function Stat({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-[9rem]">
      <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-extrabold tabnum leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function ShiftRoster({ data, history, editableDepts, today, filter, canSetHours = false }: {
  data: ShiftRosterData;
  history: { dateISO: string; hours: number; people: number }[];
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
  const [hoursOpen, setHoursOpen] = useState(false);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Draft[]>(() => data.lines.map(toDraft));
  const byKey = useMemo(() => new Map(data.lines.map((l) => [keyOf(l), l])), [data.lines]);
  const hrs = data.shiftHours ?? DEFAULT_SHIFT_HOURS;
  const OT = hrs.overtime;

  const setFilter = (v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set("sec", v); else p.delete("sec");
    router.push(`${pathname}?${p}`);
  };

  // what the filter (and the search) shows — the cards count exactly this
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => draft.filter((d) => {
    const l = byKey.get(keyOf(d))!;
    if (!rosterLineMatches(l, filter)) return false;
    if (needle && !`${l.name} ${l.empId} ${l.jobTitle ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  }), [draft, byKey, filter, needle]);
  const totals = useMemo(() => dayTotals(shown, hrs), [shown, hrs]);
  const depts = rosterDepts(filter);
  const capacity = depts.reduce<number | null>((s, d) => (data.capacityMh[d] == null ? s : (s ?? 0) + data.capacityMh[d]!), null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data.lines.map(toDraft)), [draft, data.lines]);
  const canEdit = (d: RosterDept) => editableDepts.includes(d);
  const anyEditable = shown.some((d) => canEdit(d.dept));
  const recordedHere = depts.filter((d) => data.savedDepts.includes(d));
  const allRecorded = depts.length > 0 && recordedHere.length === depts.length;

  const set = (k: string, patch: Partial<Draft>) => setDraft((d) => d.map((l) => (keyOf(l) === k ? { ...l, ...patch } : l)));
  const setShown = (patch: (l: Draft) => Partial<Draft>) => {
    const keys = new Set(shown.filter((d) => canEdit(d.dept)).map(keyOf));
    setDraft((d) => d.map((l) => (keys.has(keyOf(l)) ? { ...l, ...patch(l) } : l)));
  };

  function submit() {
    const fd = new FormData();
    fd.set("date", data.dateISO);
    // every department this user may record goes whole — the filter only
    // decides what is on screen, not what is saved
    fd.set("lines", JSON.stringify(draft.filter((l) => canEdit(l.dept))));
    const all = dayTotals(draft.filter((l) => canEdit(l.dept)), hrs);
    save.run(saveShiftRoster, fd, `Saved — ${all.present} present, ${all.hours} man-hours.`);
  }

  const capacityTone = capacity === null ? "" : totals.hours >= capacity ? "text-ok-fg" : totals.hours >= capacity * 0.8 ? "text-warn-fg" : "text-bad-fg";
  const filterLabel = rosterFilterLabel(filter);

  return (
    <div className="space-y-4">
      {/* the filter row: a line, then its sections */}
      <div className="bg-surface border rounded-xl p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <nav className="seg" aria-label="Line">
            <button type="button" className={filter === "" ? "on" : ""} onClick={() => setFilter("")}>Everyone</button>
            {WORKER_GROUPS.map((g) => (
              <button key={g.key} type="button" className={filter === `line:${g.key}` ? "on" : ""} onClick={() => setFilter(`line:${g.key}`)}>{g.label}</button>
            ))}
          </nav>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or ID…" aria-label="Search" className="border rounded-md px-2 py-1.5 bg-surface text-sm min-w-[12rem]" />
          <span className="ms-auto text-xs text-muted tabnum">{shown.length} of {draft.length} on the list</span>
        </div>
        {WORKER_GROUPS.map((g) => (
          <div key={g.key} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold text-muted uppercase tracking-wide w-24">{g.label}</span>
            {WORKER_SECTIONS.filter((s) => s.group === g.key).map((s) => (
              <button key={s.code} type="button" onClick={() => setFilter(filter === s.code ? "" : s.code)} className={`pill ${filter === s.code ? "pill-ok" : "pill-muted"} cursor-pointer`}>
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* the day at a glance — over what the filter shows */}
      <div className="flex flex-wrap items-stretch gap-3">
        <Stat label={`Present · ${filterLabel}`} value={`${totals.present} / ${totals.workers}`} sub={totals.workers - totals.present > 0 ? `${totals.workers - totals.present} absent` : totals.workers ? "everyone in" : "nobody registered"} />
        <Stat label="Man-hours" value={String(totals.hours)} sub={capacity !== null ? `${depts.length === 1 && filter !== "" && !filter.startsWith("line:") ? `${WORKER_DEPT_LABEL[depts[0]]} ` : ""}capacity ${round1(capacity)} mh/day` : "no capacity figure set"} tone={capacityTone} />
        <Stat label="Overtime" value={`${totals.overtimeH} h`} sub={`${shown.filter((l) => l.present && l.overtimeH > 0).length} worker(s)`} />
        <div className="flex-1 min-w-[12rem] flex items-end justify-end gap-2 text-xs text-muted">
          {allRecorded ? (
            <span className="pill pill-ok">recorded{data.recordedBy ? ` · ${data.recordedBy}` : ""}</span>
          ) : recordedHere.length > 0 ? (
            <span className="pill pill-warn">{recordedHere.map((d) => WORKER_DEPT_LABEL[d]).join(", ")} recorded — the rest shows defaults</span>
          ) : (
            <span className="pill pill-warn">not recorded yet — defaults shown</span>
          )}
          {dirty && <span className="pill pill-warn">unsaved changes</span>}
        </div>
      </div>

      {/* the roster */}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {shown.length === 0 ? (
          <p className="text-sm text-muted p-4">
            {draft.length === 0
              ? "Nobody is registered yet — add people in Tools → Production Workers and tick their sections."
              : needle ? "Nobody matches the search." : `Nobody is registered in ${filterLabel} yet — add them in Tools → Production Workers.`}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-left">
                  <th className="p-2 w-10 text-center" title="Present">✓</th>
                  <th className="p-2">Worker</th>
                  <th className="p-2">Section</th>
                  <th className="p-2">Shift</th>
                  <th className="p-2" title="Hours on top of the shift">Overtime</th>
                  <th className="p-2 text-center" title="Shift + overtime, nothing when absent">Hours</th>
                  <th className="p-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const w = byKey.get(keyOf(l))!;
                  const k = keyOf(l);
                  const h = lineHours(l, hrs);
                  const ro = !canEdit(l.dept) || save.pending;
                  return (
                    <tr key={k} className={`border-t ${l.present ? "" : "opacity-60 bg-surface-2/50"}`}>
                      <td className="p-2 text-center">
                        <input type="checkbox" checked={l.present} disabled={ro} aria-label={`${w.name} present`} onChange={(e) => set(k, { present: e.target.checked })} className="accent-[var(--brand,#1b7a43)] scale-125" />
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <span className="inline-flex items-baseline gap-2">
                          <span className="font-bold">{w.name}</span>
                          <span className="text-xs text-muted ltr tabnum">{w.empId}</span>
                          {w.jobTitle && <span className="text-xs text-muted">{w.jobTitle}</span>}
                          {w.onVacation && <span className="pill pill-warn" title="On vacation — absent unless ticked">vacation</span>}
                        </span>
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {w.sectionLabels.length > 0 ? w.sectionLabels.map((s) => <span key={s} className="pill pill-muted me-1">{s}</span>) : <span className="text-xs text-muted">{WORKER_DEPT_LABEL[l.dept]}</span>}
                      </td>
                      <td className="p-2">
                        <select value={l.shift} disabled={ro || !l.present} aria-label="Shift" onChange={(e) => set(k, { shift: e.target.value as ShiftCode })} className="border rounded-md px-2 py-1 bg-surface font-semibold text-sm">
                          {SHIFT_CODES.map((c) => <option key={c} value={c}>{shiftLabel(c, hrs)}</option>)}
                        </select>
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <input type="number" min={0} max={12} step={0.5} value={l.overtimeH || ""} placeholder="0" disabled={ro || !l.present} aria-label="Overtime hours" onChange={(e) => set(k, { overtimeH: Number(e.target.value) || 0 })} className="w-16 border rounded-md px-2 py-1 bg-surface text-center tabnum text-sm" />
                        {!ro && l.present && (
                          <button type="button" className="btn btn-sm btn-ghost ms-1" title={`Set ${OT} hours of overtime`} onClick={() => set(k, { overtimeH: l.overtimeH === OT ? 0 : OT })}>
                            +{OT}
                          </button>
                        )}
                      </td>
                      <td className={`p-2 text-center tabnum font-extrabold ${l.present ? "" : "text-muted"}`}>{h}</td>
                      <td className="p-2">
                        <input value={l.note} disabled={ro} placeholder="…" aria-label="Note" onChange={(e) => set(k, { note: e.target.value })} className="w-full min-w-[8rem] px-2 py-1 text-xs" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {anyEditable && (
          <div className="flex flex-wrap items-center gap-2 p-3 border-t no-print">
            <button type="button" className="btn btn-primary" disabled={save.pending || (!dirty && allRecorded)} onClick={submit}>
              {allRecorded ? "Save changes" : "Save day"}
            </button>
            <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => setShown(() => ({ present: true }))}>Everyone present</button>
            <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => setShown(() => ({ shift: "S11" }))}>All on {shiftLabel("S11", hrs)}</button>
            <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => setShown((l) => ({ overtimeH: l.present ? OT : 0 }))}>Everyone +{OT} OT</button>
            {filter !== "" && <span className="text-[11px] text-muted">— the three buttons act on the {shown.length} shown</span>}
            {dirty && <button type="button" className="btn btn-sm btn-ghost" disabled={save.pending} onClick={() => setDraft(data.lines.map(toDraft))}>Reset</button>}
            {recordedHere.length > 0 && (
              <button
                type="button" className="btn btn-sm btn-danger ms-auto" disabled={clear.pending}
                onClick={() => {
                  const target = recordedHere.filter(canEdit);
                  if (target.length === 0) return;
                  if (!confirm(`Forget ${target.map((d) => WORKER_DEPT_LABEL[d]).join(", ")} for ${data.dateISO}? The man-hours leave the calibration.`)) return;
                  const fd = new FormData();
                  fd.set("date", data.dateISO);
                  fd.set("depts", target.join(","));
                  clear.run(clearShiftDay, fd, "Day cleared.", () => setDraft((d) => d.map((l) => (target.includes(l.dept) ? { ...l, present: !byKey.get(keyOf(l))!.onVacation, shift: "S9", overtimeH: 0, note: "" } : l))));
                }}
              >
                Clear {filter === "" ? "the day" : filterLabel}
              </button>
            )}
            <Msg msg={save.msg} />
            <Msg msg={clear.msg} />
          </div>
        )}
      </section>

      {/* What a shift is worth — the codes on every line are the short and
          the long shift; the hours behind them are the plant's to set. */}
      {canSetHours && (
        <section className="bg-surface border rounded-xl no-print">
          <button type="button" onClick={() => setHoursOpen((v) => !v)} className="w-full flex items-center gap-2 p-3 text-start" aria-expanded={hoursOpen}>
            <span className={`inline-block transition-transform duration-150 ${hoursOpen ? "rotate-90" : ""}`}>▶</span>
            <b className="text-sm">Shift hours</b>
            <span className="text-xs text-muted tabnum">short {round1(hrs.short)} h · long {round1(hrs.long)} h · “+OT” {round1(hrs.overtime)} h</span>
            <span className="ms-auto text-xs text-muted">{hoursOpen ? "Close" : "Change"}</span>
          </button>
          {hoursOpen && (
            <div className="px-3 pb-3 border-t pt-3">
              <p className="text-xs text-muted mb-3">
                The hours the two shift options are worth, and what “+{OT} OT” adds. Every man-hour the app counts uses them; days already recorded are re-counted with the new figures.
              </p>
              <ShiftHoursForm short={hrs.short} long={hrs.long} overtime={hrs.overtime} compact />
            </div>
          )}
        </section>
      )}

      {/* the days recorded, for what the filter shows */}
      <section>
        <h2>Last days recorded — {filterLabel}</h2>
        {history.length === 0 ? (
          <p className="text-xs text-muted">Nothing recorded yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {history.map((h) => (
              <Link key={h.dateISO} href={`/shifts?day=${h.dateISO}${filter ? `&sec=${filter}` : ""}`} className={`pill ${h.dateISO === data.dateISO ? "pill-ok" : "pill-muted"} tabnum`} title="Open this day">
                {toDisplayDate(parseISODate(h.dateISO)!)} · {h.people} × {h.hours} mh
              </Link>
            ))}
            {history[0].dateISO !== today && !allRecorded && data.dateISO === today && <span className="pill pill-warn">today not recorded</span>}
          </div>
        )}
      </section>
    </div>
  );
}
