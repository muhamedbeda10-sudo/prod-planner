"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, Wrench } from "lucide-react";
import { EmptyState, Note } from "@/components/primitives";
import { Badge } from "@/components/Badge";
import { ExportButton } from "@/components/ExportButton";
import { TableFrame, Th, useConfirm } from "@/components/DataTable";
import { DOWNTIME_REASONS, downtimeByCause, downtimeLabel, clockMinutes, stopDurationLabel } from "@/lib/domain/downtime";
import { WORK_CENTRE_LABEL, isRosterDept, workerCentres, type RosterDept } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import { factoryDayISO, factoryWallClockMs } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { downtimeHoursInRange, elapsedStopHours, stopPeriodBounds } from "@/lib/domain/downtimePeriods";
import { formatDate } from "@/lib/domain/format";
import type { DowntimeDay, DowntimeRowDTO } from "@/lib/server/downtime";
import { addDowntime, deleteDowntime, updateDowntime } from "@/app/shifts/downtimeActions";

// The day's machine stops: which machine stood, how long, and why — one of the
// plant's codes, so the losses can be counted by cause. The supervisor
// adds a stop as it is known; each line can be deleted on its own.

const deptName = (d: string) => (isRosterDept(d) ? WORKER_DEPT_LABEL[d] : d);

export function ShiftDowntime({ data, editableDepts }: { data: DowntimeDay; editableDepts: RosterDept[] }) {
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canRecord = (dept: string) => isRosterDept(dept) && editableDepts.includes(dept);
  const machines = useMemo(() => data.machines.filter((m) => isRosterDept(m.dept) && editableDepts.includes(m.dept)), [data.machines, editableDepts]);
  const editor = useRef<HTMLDivElement>(null);
  const [clock, setNow] = useState(() => new Date(data.asOf ?? Date.now()));
  const now = new Date(Math.max(clock.getTime(), data.asOf ? Date.parse(data.asOf) : 0));
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState<DowntimeRowDTO | null>(null);
  const blankForm = () => ({ machineId: "", customName: "", customDept: editableDepts.length === 1 ? editableDepts[0] : "", customCentre: "", startTime: "", endTime: "", endDate: "", endsNextDay: false, reasonCode: "", reason: "" });
  const [form, setForm] = useState(blankForm);
  const startDate = editing?.dateISO ?? data.dateISO;
  const period = { date: startDate, hours: 0, startTime: form.startTime, endTime: form.endTime, endDate: form.endDate || null, endsNextDay: form.endsNextDay, isOpen: !!form.startTime && !form.endTime };
  const bounds = stopPeriodBounds(period, factoryWallClockMs(now));
  const open = !!form.startTime && !form.endTime;
  const validStart = clockMinutes(form.startTime) !== null && !!bounds && bounds.start <= factoryWallClockMs(now);
  const timing = form.endTime && form.endDate && bounds && bounds.end > bounds.start && bounds.end <= factoryWallClockMs(now) ? { hours: (bounds.end - bounds.start) / 3600000 } : null;
  const liveRows = data.rows.map((r) => {
    const p = { date: r.dateISO ?? data.dateISO, hours: r.storedHours ?? r.hours, startTime: r.startTime, endTime: r.endTime, endsNextDay: r.endsNextDay, isOpen: r.isOpen, endDate: r.endDateISO };
    return { ...r, hours: elapsedStopHours(p, now), dayHours: downtimeHoursInRange(p, data.dateISO, data.dateISO, now) };
  });
  useEffect(() => {
    if (!data.rows.some((r) => r.isOpen) && !open) return;
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, [data.rows, open]);
  const custom = form.machineId === "custom";
  const centres = workerCentres(form.customDept);
  const legacy = !!editing && !editing.startTime && !form.startTime && !form.endTime && !form.endsNextDay;
  const changeTime = (key: "startTime" | "endTime", value: string) => setForm((f) => {
    const next = { ...f, [key]: value };
    if (!next.endTime) { next.endDate = ""; next.endsNextDay = false; }
    else {
      if (!next.endDate) next.endDate = closing ? factoryDayISO(now) : addDaysISO(startDate, next.endTime < next.startTime ? 1 : 0);
      else if (!closing && next.endDate === startDate && next.endTime < next.startTime) next.endDate = addDaysISO(startDate, 1);
      next.endsNextDay = next.endDate > startDate;
    }
    return next;
  });
  useEffect(() => {
    if (!editing) return;
    editor.current?.scrollIntoView({ block: "nearest" });
    editor.current?.querySelector<HTMLInputElement>(closing ? "input[aria-label='Stop end time']" : "input[aria-label='Stop start time']")?.focus({ preventScroll: true });
  }, [editing, closing]);
  const byDept = useMemo(() => {
    const groups = new Map<string, typeof machines>();
    for (const m of machines) groups.set(m.dept, [...(groups.get(m.dept) ?? []), m]);
    return [...groups.entries()];
  }, [machines]);
  const { causes, unplannedH, plannedH } = downtimeByCause(liveRows.map((r) => ({ ...r, hours: r.dayHours })));

  const add = () => {
    const fd = new FormData();
    fd.set("date", startDate);
    for (const [k, v] of Object.entries(form)) fd.set(k, String(v));
    if (form.startTime) fd.set("isOpen", String(!form.endTime));
    if (editing) {
      fd.set("id", String(editing.id));
      fd.set("before", JSON.stringify({ hours: editing.storedHours ?? editing.hours, isOpen: editing.isOpen ?? false, endDate: editing.endDateISO ?? null, reasonCode: editing.reasonCode, reason: editing.reason, startTime: editing.startTime ?? null, endTime: editing.endTime ?? null, endsNextDay: editing.endsNextDay ?? false }));
      if (legacy) fd.set("hours", String(editing.hours));
    }
    setMsg(null);
    start(async () => {
      try {
        const res = editing ? await updateDowntime(fd) : await addDowntime(fd);
        if (res.ok) {
          const m = machines.find((x) => String(x.id) === form.machineId);
          const label = editing?.machineCode ?? (custom ? form.customName : m?.code) ?? "the equipment";
          setMsg({ ok: true, text: res.isOpen ? `${editing ? "Updated" : "Recorded"} — ${label}: open stop. Add its end when repaired.` : `${editing?.isOpen ? "Resolved" : editing ? "Updated" : "Recorded"} — ${label} stopped for ${stopDurationLabel(res.hours ?? 0)}.` });
          setEditing(null); setClosing(false);
          setForm(blankForm());
          router.refresh();
        } else setMsg({ ok: false, text: res.error ?? "Could not record the stop." });
      } catch { setMsg({ ok: false, text: "Could not confirm the save. Refresh and check the records before trying again." }); }
    });
  };

  const remove = async (id: number, label: string) => {
    if (!(await confirm({ title: "Delete this stop?", body: "Its hours come back to the machine's day and leave the loss counts.", items: [label], confirmLabel: "Delete", danger: true }))) return;
    const fd = new FormData();
    fd.set("id", String(id));
    start(async () => {
      const res = await deleteDowntime(fd);
      setMsg(res.ok ? { ok: true, text: "Stop deleted." } : { ok: false, text: res.error ?? "Could not delete." });
      if (res.ok) { if (editing?.id === id) { setEditing(null); setClosing(false); setForm(blankForm()); } router.refresh(); }
    });
  };

  const editStop = (r: DowntimeRowDTO, resolve = false) => {
    setEditing(r); setClosing(resolve);
    const from = r.dateISO ?? data.dateISO;
    setForm({ machineId: r.machineId === null ? "custom" : String(r.machineId), customName: r.machineId === null ? r.machineCode : "", customDept: r.dept, customCentre: r.centre ?? "", startTime: r.startTime ?? "", endTime: r.endTime ?? "", endDate: resolve ? factoryDayISO(now) : r.endDateISO ?? (r.endTime ? addDaysISO(from, r.endsNextDay ? 1 : 0) : ""), endsNextDay: r.endsNextDay ?? false, reasonCode: r.reasonCode ?? "", reason: r.reason ?? "" });
  };
  const ready = (editing || (custom ? form.customName.trim() && form.customDept && (!centres || form.customCentre) : form.machineId)) && (timing || (open && validStart) || legacy) && (!closing || !!form.endTime) && form.reasonCode;

  return (
    <div className="space-y-3">
      {confirmDialog}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="!mb-0">Machine stops — {formatDate(data.dateISO)}</h2>
        <span className="text-sm text-muted tabnum">
          {data.rows.length === 0 ? "none recorded" : `${stopDurationLabel(unplannedH)} lost${plannedH > 0 ? ` · ${stopDurationLabel(plannedH)} planned maintenance` : ""}`}
        </span>
        {data.rows.some((r) => r.isOpen) && <Badge tone="danger">{data.rows.filter((r) => r.isOpen).length} still open</Badge>}
        {data.rows.length > 0 && (
          <span className="ms-auto">
            <ExportButton
              filename={`machine-stops-${data.dateISO}.xlsx`}
              sheetName="Stops"
              rows={liveRows.map((r) => ({ Date: r.dateISO ?? data.dateISO, Status: r.isOpen ? "Open" : "Resolved", "As of": now.toISOString(), "Hours on selected day": r.dayHours, "End date": r.endDateISO ?? "", Machine: r.machineCode, Name: r.machineName, Department: deptName(r.dept), Centre: r.centre ? WORK_CENTRE_LABEL[r.centre] : deptName(r.dept), From: r.startTime ?? "", To: r.endTime ?? "", "End next day": r.endsNextDay ? "Yes" : "", Duration: stopDurationLabel(r.hours), Hours: r.hours, Why: downtimeLabel(r.reasonCode, r.reason), Note: r.reasonCode ? r.reason ?? "" : "", By: r.recordedBy ?? "" }))}
            />
          </span>
        )}
      </div>

      {(editableDepts.length > 0 || editing) && (
        <div ref={editor} className="toolbar !mb-0">
          {editing && <p className="text-xs font-semibold px-3 pt-2">{closing ? "Resolve" : "Editing"} {editing.machineCode} · Started {formatDate(startDate)}</p>}
          <div className="toolbar-row">
            <select value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value, customName: "", customCentre: "" }))} aria-label="Machine" className="ctl" disabled={pending || !!editing}>
              <option value="">Machine…</option>
              <option value="custom">Other equipment — type a name…</option>
              {editing?.machineId && !machines.some((m) => m.id === editing.machineId) && <option value={editing.machineId}>{editing.machineCode} — {editing.machineName}</option>}
              {byDept.map(([dept, ms]) => (
                <optgroup key={dept} label={deptName(dept)}>
                  {ms.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                </optgroup>
              ))}
            </select>
            {custom && <>
              <input value={form.customName} onChange={(e) => setForm((f) => ({ ...f, customName: e.target.value }))} maxLength={120} aria-label="Unlisted equipment name" placeholder="Equipment name…" className="ctl min-w-40" disabled={pending || !!editing} />
              <select aria-label="Equipment department" value={form.customDept} onChange={(e) => setForm((f) => ({ ...f, customDept: e.target.value, customCentre: "" }))} className="ctl" disabled={pending || !!editing}><option value="">Department…</option>{editableDepts.map((d) => <option key={d} value={d}>{deptName(d)}</option>)}</select>
              {centres && <select aria-label="Equipment work centre" value={form.customCentre} onChange={(e) => setForm((f) => ({ ...f, customCentre: e.target.value }))} className="ctl" disabled={pending || !!editing}><option value="">Work centre…</option>{centres.map((c) => <option key={c} value={c}>{WORK_CENTRE_LABEL[c]}</option>)}</select>}
            </>}
            <label className="text-xs font-semibold text-muted">From<input type="time" step={60} value={form.startTime} onChange={(e) => changeTime("startTime", e.target.value)} aria-label="Stop start time" className="ctl block tabnum ltr" disabled={pending} /></label>
            <label className="text-xs font-semibold text-muted">To (when resolved)<input type="time" step={60} value={form.endTime} onChange={(e) => changeTime("endTime", e.target.value)} aria-label="Stop end time" className="ctl block tabnum ltr" disabled={pending} /></label>
            {form.endTime && <button type="button" aria-label="Leave end time unknown" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => { setClosing(false); changeTime("endTime", ""); }}>Still open</button>}
            {form.endTime && <label className="text-xs font-semibold text-muted">End date<input type="date" aria-label="Stop end date" min={startDate} max={factoryDayISO(now)} value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value, endsNextDay: e.target.value > startDate }))} className="ctl block" disabled={pending} /></label>}
            <output aria-label="Calculated stop duration" className="text-sm font-semibold tabnum whitespace-nowrap">{open && validStart ? `Open · ${bounds && bounds.end > bounds.start ? `${stopDurationLabel((bounds.end - bounds.start) / 3600000)} elapsed` : "just started"}` : timing ? stopDurationLabel(timing.hours) : legacy ? stopDurationLabel(editing.hours) : "—"}</output>
            <select value={form.reasonCode} onChange={(e) => setForm((f) => ({ ...f, reasonCode: e.target.value }))} aria-label="Why it stopped" className="ctl" disabled={pending}>
              <option value="">Why…</option>
              {DOWNTIME_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} aria-label="Note" placeholder="Note (optional)" maxLength={200} className="ctl min-w-[12rem] flex-1" disabled={pending} />
            <button type="button" className="btn btn-primary btn-sm" disabled={pending || !ready} onClick={add}>
              {editing ? <Pencil size={14} aria-hidden /> : <Plus size={14} aria-hidden />}{editing?.isOpen && form.endTime ? "Save resolution" : editing ? "Save stop changes" : open ? "Save open stop" : "Add stop"}
            </button>
            {editing && <button type="button" disabled={pending} className="btn btn-ghost btn-sm" onClick={() => { setEditing(null); setClosing(false); setForm(blankForm()); }}>Cancel edit</button>}
          </div>
          <p className="px-3 pb-2 text-xs text-muted">Leave To blank while the problem is unresolved. Use Resolve later to record its actual end time and date.{editing && <span> Started {formatDate(startDate)}.</span>}{legacy && ` This older stop has duration only (${stopDurationLabel(editing.hours)}). Keep both times blank to retain it, or enter the actual start.`}{form.startTime && form.endTime && !timing && <span className="block text-bad-fg">The actual end must be after the start and no later than now. Check the end date.</span>}</p>
        </div>
      )}
      <Note msg={msg} />

      {data.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState compact icon={Wrench} title="No machine stopped this day" hint={editableDepts.length > 0 ? "Choose equipment or type an unlisted name, then record its start. Leave To blank until it is repaired." : "Recording stops needs the department's shift-log permission."} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" aria-label="Hours by cause">
            {causes.map((c) => (
              <Badge key={c.code} tone={c.planned ? "neutral" : "danger"}>{c.label} · {stopDurationLabel(c.hours)}</Badge>
            ))}
          </div>
          <section className="bg-surface border rounded-xl overflow-hidden">
            <TableFrame>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th label="Machine" />
                    <Th label="Centre" className="max-md:hidden" />
                    <Th label="Status" />
                    <Th label="Time range" />
                    <Th label="Duration" num className="text-right" />
                    <Th label="Why" />
                    <Th label="Note" className="max-md:hidden" />
                    <Th label="By" className="max-md:hidden" />
                    <th className="w-20" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {liveRows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 whitespace-nowrap"><span className="code-chip">{r.machineCode}</span> <span className="text-muted ms-1">{r.machineName}</span>{r.isOpen && canRecord(r.dept) && <div className="md:hidden py-1"><button type="button" className="btn btn-sm btn-primary" disabled={pending} aria-label={`Resolve stop of ${r.machineCode}`} onClick={() => editStop(r, true)}>Resolve</button></div>}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.centre ? WORK_CENTRE_LABEL[r.centre] : deptName(r.dept)}</td>
                      <td className="px-2"><Badge tone={r.isOpen ? "danger" : "neutral"}>{r.isOpen ? "Open" : "Resolved"}</Badge></td>
                      <td className="px-2 whitespace-nowrap tabnum">{r.dateISO && r.dateISO !== data.dateISO && <span className="block text-xs text-muted">Started {formatDate(r.dateISO)}</span>}{r.isOpen ? <>{r.startTime} → <span className="text-warn-fg">Still open</span></> : r.startTime && r.endTime ? <>{r.startTime} → {r.endTime}{r.endDateISO && r.endDateISO !== (r.dateISO ?? data.dateISO) ? <span className="text-muted ms-1">({formatDate(r.endDateISO)})</span> : r.endsNextDay && <span className="text-muted ms-1">(+1 day)</span>}</> : <span className="text-muted text-xs">Duration only</span>}</td>
                      <td className="px-2 text-right tabnum font-bold whitespace-nowrap">{stopDurationLabel(r.hours)}{(r.isOpen || (r.endDateISO && r.endDateISO !== (r.dateISO ?? data.dateISO)) || (r.dateISO && r.dateISO !== data.dateISO)) && <span className="block text-xs text-muted font-normal">{r.isOpen ? "so far · " : ""}{stopDurationLabel(r.dayHours)} this day</span>}</td>
                      <td className="px-2">{downtimeLabel(r.reasonCode, r.reason)}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.reasonCode ? r.reason ?? "" : ""}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.recordedBy ?? ""}</td>
                      <td className="px-1 text-center">
                        {canRecord(r.dept) && (
                          <span className="inline-flex gap-1">
                          {r.isOpen && <button type="button" className="btn btn-sm btn-primary max-md:hidden" disabled={pending} aria-label={`Resolve stop of ${r.machineCode}`} onClick={() => editStop(r, true)}>Resolve</button>}
                          <button type="button" className="btn btn-sm btn-ghost" disabled={pending} aria-label={`Edit the stop of ${r.machineCode}`} onClick={() => editStop(r)}><Pencil size={14} aria-hidden /></button>
                          <button type="button" className="btn btn-sm btn-ghost" disabled={pending} aria-label={`Delete the stop of ${r.machineCode}`} onClick={() => remove(r.id, `${r.machineCode} · ${stopDurationLabel(r.hours)} · ${downtimeLabel(r.reasonCode, r.reason)}`)}>
                            <Trash2 size={14} aria-hidden />
                          </button></span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </section>
        </>
      )}
    </div>
  );
}
