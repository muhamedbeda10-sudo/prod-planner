"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { deptLabel } from "@/lib/domain/constants";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";
import {
  DEFAULT_OVERTIME, MACHINE_DEPTS, SHIFT_CODES, SHIFT_DEPTS, SHIFT_LABEL, dayTotals, lineHours, machineAvailable, machineWord, round1,
  type ShiftCode, type ShiftDept,
} from "@/lib/domain/shifts";
import type { ShiftDayData, ShiftLineDTO } from "@/lib/server/shifts";
import { addDowntime, clearShiftDay, deleteDowntime, saveShiftDay } from "@/app/shifts/actions";

// The shift log — the supervisor's page. One department, one day: every
// worker on the list with present / shift / overtime / machine, the day's
// totals against the stage's capacity, the machines' downtime, and the last
// days recorded so a missing one stands out. The supervisor edits the
// exceptions (an absence, an 11-hour shift, overtime) and saves the day once.

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

// ---- pickers in the page header: department and day, both in the URL ----

export function ShiftDeptPicker({ dept }: { dept: ShiftDept }) {
  const params = useSearchParams();
  const day = params.get("day");
  return (
    <nav className="seg" aria-label="Department">
      {SHIFT_DEPTS.map((d) => (
        <Link key={d} href={`/shifts?dept=${d}${day ? `&day=${day}` : ""}`} className={d === dept ? "on" : ""}>
          {deptLabel(d)}
        </Link>
      ))}
    </nav>
  );
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

// ---- the day ----

type Draft = Pick<ShiftLineDTO, "workerId" | "present" | "shift" | "overtimeH" | "machineId" | "note">;

const toDraft = (l: ShiftLineDTO): Draft => ({ workerId: l.workerId, present: l.present, shift: l.shift, overtimeH: l.overtimeH, machineId: l.machineId, note: l.note });

function Stat({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3 min-w-[9rem]">
      <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-extrabold tabnum leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function ShiftLog({ data, history, canEdit, today }: { data: ShiftDayData; history: { dateISO: string; hours: number }[]; canEdit: boolean; today: string }) {
  const save = useAction();
  const clear = useAction();
  const [draft, setDraft] = useState<Draft[]>(() => data.lines.map(toDraft));
  const byId = useMemo(() => new Map(data.lines.map((l) => [l.workerId, l])), [data.lines]);
  const totals = useMemo(() => dayTotals(draft), [draft]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data.lines.map(toDraft)), [draft, data.lines]);
  const hasMachines = MACHINE_DEPTS.includes(data.dept) && data.machines.length > 0;
  const downtimeH = round1(data.downtime.reduce((s, d) => s + d.hours, 0));
  const machineName = (id: number | null) => {
    const m = data.machines.find((x) => x.id === id);
    return m ? `${m.code} · ${m.name}` : "";
  };

  const set = (workerId: number, patch: Partial<Draft>) => setDraft((d) => d.map((l) => (l.workerId === workerId ? { ...l, ...patch } : l)));

  function submit() {
    const fd = new FormData();
    fd.set("date", data.dateISO);
    fd.set("dept", data.dept);
    fd.set("lines", JSON.stringify(draft));
    save.run(saveShiftDay, fd, `Saved — ${totals.present} present, ${totals.hours} man-hours.`);
  }

  const capacityTone = data.capacityMh === null ? "" : totals.hours >= data.capacityMh ? "text-ok-fg" : totals.hours >= data.capacityMh * 0.8 ? "text-warn-fg" : "text-bad-fg";

  return (
    <div className="space-y-5">
      {/* the day at a glance */}
      <div className="flex flex-wrap items-stretch gap-3">
        <Stat label="Present" value={`${totals.present} / ${totals.workers}`} sub={totals.workers - totals.present > 0 ? `${totals.workers - totals.present} absent` : "everyone in"} />
        <Stat label="Man-hours" value={String(totals.hours)} sub={data.capacityMh !== null ? `capacity ${data.capacityMh} mh/day` : "no capacity figure set"} tone={capacityTone} />
        <Stat label="Overtime" value={`${totals.overtimeH} h`} sub={`${draft.filter((l) => l.present && l.overtimeH > 0).length} worker(s)`} />
        {hasMachines && <Stat label="Downtime" value={`${downtimeH} h`} sub={`${data.downtime.length} stop(s)`} tone={downtimeH > 0 ? "text-warn-fg" : ""} />}
        <div className="flex-1 min-w-[12rem] flex items-end justify-end gap-2 text-xs text-muted">
          {data.saved ? (
            <span className="pill pill-ok">recorded{data.recordedBy ? ` · ${data.recordedBy}` : ""}</span>
          ) : (
            <span className="pill pill-warn">not recorded yet — defaults shown</span>
          )}
          {dirty && <span className="pill pill-warn">unsaved changes</span>}
        </div>
      </div>

      {/* the roster */}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {data.lines.length === 0 ? (
          <p className="text-sm text-muted p-4">
            Nobody is registered for {deptLabel(data.dept)} on the workers list yet — add them in Tools → Production Workers and tick {deptLabel(data.dept)}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-left">
                  <th className="p-2 w-10 text-center" title="Present">✓</th>
                  <th className="p-2">Worker</th>
                  <th className="p-2">Shift</th>
                  <th className="p-2" title="Hours on top of the shift">Overtime</th>
                  {hasMachines && <th className="p-2">{machineWord(data.dept)[0].toUpperCase() + machineWord(data.dept).slice(1)}</th>}
                  <th className="p-2 text-center" title="Shift + overtime, nothing when absent">Hours</th>
                  <th className="p-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {draft.map((l) => {
                  const w = byId.get(l.workerId)!;
                  const h = lineHours(l);
                  return (
                    <tr key={l.workerId} className={`border-t ${l.present ? "" : "opacity-60 bg-surface-2/50"}`}>
                      <td className="p-2 text-center">
                        <input type="checkbox" checked={l.present} disabled={!canEdit || save.pending} aria-label={`${w.name} present`} onChange={(e) => set(l.workerId, { present: e.target.checked })} className="accent-[var(--brand,#1b7a43)] scale-125" />
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <span className="inline-flex items-baseline gap-2">
                          <span className="font-bold">{w.name}</span>
                          <span className="text-xs text-muted ltr tabnum">{w.empId}</span>
                          {w.jobTitle && <span className="text-xs text-muted">{w.jobTitle}</span>}
                        </span>
                      </td>
                      <td className="p-2">
                        <select value={l.shift} disabled={!canEdit || !l.present || save.pending} aria-label="Shift" onChange={(e) => set(l.workerId, { shift: e.target.value as ShiftCode })} className="border rounded-md px-2 py-1 bg-surface font-semibold text-sm">
                          {SHIFT_CODES.map((c) => <option key={c} value={c}>{SHIFT_LABEL[c]}</option>)}
                        </select>
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <input type="number" min={0} max={12} step={0.5} value={l.overtimeH || ""} placeholder="0" disabled={!canEdit || !l.present || save.pending} aria-label="Overtime hours" onChange={(e) => set(l.workerId, { overtimeH: Number(e.target.value) || 0 })} className="w-16 border rounded-md px-2 py-1 bg-surface text-center tabnum text-sm" />
                        {canEdit && l.present && (
                          <button type="button" className="btn btn-sm btn-ghost ms-1" title={`Set ${DEFAULT_OVERTIME} hours of overtime`} disabled={save.pending} onClick={() => set(l.workerId, { overtimeH: l.overtimeH === DEFAULT_OVERTIME ? 0 : DEFAULT_OVERTIME })}>
                            +{DEFAULT_OVERTIME}
                          </button>
                        )}
                      </td>
                      {hasMachines && (
                        <td className="p-2">
                          <select value={l.machineId ?? ""} disabled={!canEdit || !l.present || save.pending} aria-label="Machine" onChange={(e) => set(l.workerId, { machineId: e.target.value ? Number(e.target.value) : null })} className="border rounded-md px-2 py-1 bg-surface text-sm max-w-[14rem]">
                            <option value="">—</option>
                            {data.machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
                          </select>
                        </td>
                      )}
                      <td className={`p-2 text-center tabnum font-extrabold ${l.present ? "" : "text-muted"}`}>{h}</td>
                      <td className="p-2">
                        <input value={l.note} disabled={!canEdit || save.pending} placeholder="…" aria-label="Note" onChange={(e) => set(l.workerId, { note: e.target.value })} className="w-full min-w-[8rem] px-2 py-1 text-xs" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {hasMachines && Object.keys(totals.byMachine).length > 0 && (
                <tfoot>
                  <tr className="border-t bg-surface-2/60 text-xs">
                    <td colSpan={7} className="p-2">
                      <span className="font-bold text-muted me-2">On the {machineWord(data.dept, true)}:</span>
                      {Object.entries(totals.byMachine).map(([id, h]) => (
                        <span key={id} className="pill pill-muted me-1 tabnum">{machineName(Number(id))} · {h} h</span>
                      ))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {canEdit && data.lines.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 p-3 border-t no-print">
            <button type="button" className="btn btn-primary" disabled={save.pending || !dirty && data.saved} onClick={submit}>
              {data.saved ? "Save changes" : "Save day"}
            </button>
            <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => setDraft((d) => d.map((l) => ({ ...l, present: true })))}>Everyone present</button>
            <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => setDraft((d) => d.map((l) => ({ ...l, shift: "S11" })))}>All on 11 h</button>
            <button type="button" className="btn btn-sm" disabled={save.pending} onClick={() => setDraft((d) => d.map((l) => ({ ...l, overtimeH: l.present ? DEFAULT_OVERTIME : 0 })))}>Everyone +{DEFAULT_OVERTIME} OT</button>
            {dirty && <button type="button" className="btn btn-sm btn-ghost" disabled={save.pending} onClick={() => setDraft(data.lines.map(toDraft))}>Reset</button>}
            {data.saved && (
              <button
                type="button" className="btn btn-sm btn-danger ms-auto" disabled={clear.pending}
                onClick={() => {
                  if (!confirm(`Forget ${deptLabel(data.dept)}'s record for ${data.dateISO}? Its man-hours leave the calibration.`)) return;
                  const fd = new FormData();
                  fd.set("date", data.dateISO);
                  fd.set("dept", data.dept);
                  clear.run(clearShiftDay, fd, "Day cleared.", () => setDraft((d) => d.map((l) => ({ ...l, present: true, shift: "S9", overtimeH: 0, machineId: null, note: "" }))));
                }}
              >
                Clear the day
              </button>
            )}
            <Msg msg={save.msg} />
            <Msg msg={clear.msg} />
          </div>
        )}
      </section>

      {hasMachines && <Downtime data={data} canEdit={canEdit} />}

      {/* the days recorded */}
      <section>
        <h2>Last days recorded — {deptLabel(data.dept)}</h2>
        {history.length === 0 ? (
          <p className="text-xs text-muted">Nothing recorded yet for this department.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {history.map((h) => (
              <Link key={h.dateISO} href={`/shifts?dept=${data.dept}&day=${h.dateISO}`} className={`pill ${h.dateISO === data.dateISO ? "pill-ok" : "pill-muted"} tabnum`} title="Open this day">
                {toDisplayDate(parseISODate(h.dateISO)!)} · {h.hours} mh
              </Link>
            ))}
            {history[0].dateISO !== today && !data.saved && data.dateISO === today && <span className="pill pill-warn">today not recorded</span>}
          </div>
        )}
      </section>
    </div>
  );
}

// ---- downtime: hours a machine stood still on the day ----

function Downtime({ data, canEdit }: { data: ShiftDayData; canEdit: boolean }) {
  const add = useAction();
  const del = useAction();
  const machine = (id: number) => data.machines.find((m) => m.id === id);
  return (
    <section className="bg-surface border rounded-xl p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="!mb-0">{machineWord(data.dept)[0].toUpperCase() + machineWord(data.dept).slice(1)} downtime</h2>
        <span className="text-[11px] text-muted">hours a machine stood still on the day, and why — the load it could not take</span>
      </div>
      {data.downtime.length > 0 && (
        <ul className="space-y-1">
          {data.downtime.map((d) => {
            const m = machine(d.machineId);
            const avail = m ? machineAvailable(m.hoursPerDay, d.hours) : null;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-bold ltr">{m ? `${m.code} · ${m.name}` : `#${d.machineId}`}</span>
                <span className="pill pill-warn tabnum">{d.hours} h down</span>
                {avail !== null && <span className="text-xs text-muted tabnum">{avail} h left of {m!.hoursPerDay}</span>}
                {d.reason && <span className="text-xs text-muted">— {d.reason}</span>}
                {canEdit && (
                  <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={del.pending} title="Remove" onClick={() => { const fd = new FormData(); fd.set("id", String(d.id)); del.run(deleteDowntime, fd, "Removed."); }}>✕</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2 no-print"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const fd = new FormData(form);
            fd.set("date", data.dateISO);
            fd.set("dept", data.dept);
            add.run(addDowntime, fd, "Added.", () => form.reset());
          }}
        >
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">Machine</span>
            <select name="machineId" required className="border rounded-md px-2 py-1.5 bg-surface text-sm" defaultValue="">
              <option value="" disabled>Pick…</option>
              {data.machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">
            <span className="block mb-1 text-muted">Hours</span>
            <input name="hours" type="number" min={0.5} max={24} step={0.5} required placeholder="h" className="w-20 border rounded-md px-2 py-1.5 bg-surface text-center tabnum text-sm" />
          </label>
          <label className="text-xs font-semibold flex-1 min-w-[12rem]">
            <span className="block mb-1 text-muted">Reason</span>
            <input name="reason" placeholder="breakdown, no material, maintenance…" className="w-full border rounded-md px-2 py-1.5 bg-surface text-sm" />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={add.pending}>Add downtime</button>
          <Msg msg={add.msg?.ok === false ? add.msg : null} />
          <Msg msg={del.msg?.ok === false ? del.msg : null} />
        </form>
      )}
      {!canEdit && data.downtime.length === 0 && <p className="text-xs text-muted">No downtime recorded.</p>}
    </section>
  );
}
