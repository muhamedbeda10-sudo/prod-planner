"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, Wrench } from "lucide-react";
import { EmptyState, Note } from "@/components/primitives";
import { Badge } from "@/components/Badge";
import { ExportButton } from "@/components/ExportButton";
import { TableFrame, Th, useConfirm } from "@/components/DataTable";
import { DOWNTIME_REASONS, downtimeByCause, downtimeLabel, stopDurationLabel, stopTiming } from "@/lib/domain/downtime";
import { WORK_CENTRE_LABEL, isRosterDept, workerCentres, type RosterDept } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
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
  const [editing, setEditing] = useState<DowntimeRowDTO | null>(null);
  const blankForm = () => ({ machineId: "", customName: "", customDept: editableDepts.length === 1 ? editableDepts[0] : "", customCentre: "", startTime: "", endTime: "", endsNextDay: false, reasonCode: "", reason: "" });
  const [form, setForm] = useState(blankForm);
  const timing = stopTiming(form.startTime, form.endTime, form.endsNextDay);
  const custom = form.machineId === "custom";
  const centres = workerCentres(form.customDept);
  const legacy = !!editing && !editing.startTime && !form.startTime && !form.endTime && !form.endsNextDay;
  const changeTime = (key: "startTime" | "endTime", value: string) => setForm((f) => {
    const next = { ...f, [key]: value };
    next.endsNextDay = !!next.startTime && !!next.endTime && next.endTime < next.startTime;
    return next;
  });
  useEffect(() => {
    if (!editing) return;
    editor.current?.scrollIntoView({ block: "nearest" });
    editor.current?.querySelector<HTMLInputElement>("input[aria-label='Stop start time']")?.focus({ preventScroll: true });
  }, [editing]);
  const byDept = useMemo(() => {
    const groups = new Map<string, typeof machines>();
    for (const m of machines) groups.set(m.dept, [...(groups.get(m.dept) ?? []), m]);
    return [...groups.entries()];
  }, [machines]);
  const { causes, unplannedH, plannedH } = downtimeByCause(data.rows);

  const add = () => {
    const fd = new FormData();
    fd.set("date", data.dateISO);
    for (const [k, v] of Object.entries(form)) fd.set(k, String(v));
    if (editing) {
      fd.set("id", String(editing.id));
      fd.set("before", JSON.stringify({ hours: editing.hours, reasonCode: editing.reasonCode, reason: editing.reason, startTime: editing.startTime ?? null, endTime: editing.endTime ?? null, endsNextDay: editing.endsNextDay ?? false }));
      if (legacy) fd.set("hours", String(editing.hours));
    }
    setMsg(null);
    start(async () => {
      try {
        const res = editing ? await updateDowntime(fd) : await addDowntime(fd);
        if (res.ok) {
          const m = machines.find((x) => String(x.id) === form.machineId);
          setMsg({ ok: true, text: `${editing ? "Updated" : "Recorded"} — ${editing?.machineCode ?? (custom ? form.customName : m?.code) ?? "the equipment"} stopped for ${stopDurationLabel(res.hours ?? 0)}.` });
          setEditing(null);
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
      if (res.ok) { if (editing?.id === id) { setEditing(null); setForm(blankForm()); } router.refresh(); }
    });
  };

  const ready = (editing || (custom ? form.customName.trim() && form.customDept && (!centres || form.customCentre) : form.machineId)) && (timing || legacy) && form.reasonCode;

  return (
    <div className="space-y-3">
      {confirmDialog}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="!mb-0">Machine stops — {formatDate(data.dateISO)}</h2>
        <span className="text-sm text-muted tabnum">
          {data.rows.length === 0 ? "none recorded" : `${stopDurationLabel(unplannedH)} lost${plannedH > 0 ? ` · ${stopDurationLabel(plannedH)} planned maintenance` : ""}`}
        </span>
        {data.rows.length > 0 && (
          <span className="ms-auto">
            <ExportButton
              filename={`machine-stops-${data.dateISO}.xlsx`}
              sheetName="Stops"
              rows={data.rows.map((r) => ({ Date: data.dateISO, Machine: r.machineCode, Name: r.machineName, Department: deptName(r.dept), Centre: r.centre ? WORK_CENTRE_LABEL[r.centre] : deptName(r.dept), From: r.startTime ?? "", To: r.endTime ?? "", "End next day": r.endsNextDay ? "Yes" : "", Duration: stopDurationLabel(r.hours), Hours: r.hours, Why: downtimeLabel(r.reasonCode, r.reason), Note: r.reasonCode ? r.reason ?? "" : "", By: r.recordedBy ?? "" }))}
            />
          </span>
        )}
      </div>

      {(editableDepts.length > 0 || editing) && (
        <div ref={editor} className="toolbar !mb-0">
          {editing && <p className="text-xs font-semibold px-3 pt-2">Editing {editing.machineCode} · {formatDate(data.dateISO)}</p>}
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
            <label className="text-xs font-semibold text-muted">To<input type="time" step={60} value={form.endTime} onChange={(e) => changeTime("endTime", e.target.value)} aria-label="Stop end time" className="ctl block tabnum ltr" disabled={pending} /></label>
            <label className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"><input type="checkbox" aria-label="Stop ends next day" checked={form.endsNextDay} onChange={(e) => setForm((f) => ({ ...f, endsNextDay: e.target.checked }))} disabled={pending} />End next day</label>
            <output aria-label="Calculated stop duration" className="text-sm font-semibold tabnum whitespace-nowrap">{timing ? stopDurationLabel(timing.hours) : legacy ? stopDurationLabel(editing.hours) : "—"}</output>
            <select value={form.reasonCode} onChange={(e) => setForm((f) => ({ ...f, reasonCode: e.target.value }))} aria-label="Why it stopped" className="ctl" disabled={pending}>
              <option value="">Why…</option>
              {DOWNTIME_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} aria-label="Note" placeholder="Note (optional)" maxLength={200} className="ctl min-w-[12rem] flex-1" disabled={pending} />
            <button type="button" className="btn btn-primary btn-sm" disabled={pending || !ready} onClick={add}>
              {editing ? <Pencil size={14} aria-hidden /> : <Plus size={14} aria-hidden />}{editing ? "Save stop changes" : "Add stop"}
            </button>
            {editing && <button type="button" disabled={pending} className="btn btn-ghost btn-sm" onClick={() => { setEditing(null); setForm(blankForm()); }}>Cancel edit</button>}
          </div>
          <p className="px-3 pb-2 text-xs text-muted">Times use the selected factory date. An end before the start selects the next day automatically; its hours stay on the starting date.{legacy && ` This older stop has duration only (${stopDurationLabel(editing.hours)}). Leave both times blank to keep it, or enter both to record the actual range.`}{form.startTime && form.endTime && !timing && <span className="block text-bad-fg">End must be after start and within 24 hours. Check the next-day option.</span>}</p>
        </div>
      )}
      <Note msg={msg} />

      {data.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState compact icon={Wrench} title="No machine stopped this day" hint={editableDepts.length > 0 ? "Choose equipment or type an unlisted name, then record when the stop started and ended." : "Recording stops needs the department's shift-log permission."} />
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
                    <Th label="Time range" />
                    <Th label="Duration" num className="text-right" />
                    <Th label="Why" />
                    <Th label="Note" className="max-md:hidden" />
                    <Th label="By" className="max-md:hidden" />
                    <th className="w-20" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 whitespace-nowrap"><span className="code-chip">{r.machineCode}</span> <span className="text-muted ms-1">{r.machineName}</span></td>
                      <td className="px-2 text-muted max-md:hidden">{r.centre ? WORK_CENTRE_LABEL[r.centre] : deptName(r.dept)}</td>
                      <td className="px-2 whitespace-nowrap tabnum">{r.startTime && r.endTime ? <>{r.startTime} → {r.endTime}{r.endsNextDay && <span className="text-muted ms-1">(+1 day)</span>}</> : <span className="text-muted text-xs">Duration only</span>}</td>
                      <td className="px-2 text-right tabnum font-bold whitespace-nowrap">{stopDurationLabel(r.hours)}</td>
                      <td className="px-2">{downtimeLabel(r.reasonCode, r.reason)}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.reasonCode ? r.reason ?? "" : ""}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.recordedBy ?? ""}</td>
                      <td className="px-1 text-center">
                        {canRecord(r.dept) && (
                          <span className="inline-flex gap-1">
                          <button type="button" className="btn btn-sm btn-ghost" disabled={pending} aria-label={`Edit the stop of ${r.machineCode}`} onClick={() => { setEditing(r); setForm({ machineId: r.machineId === null ? "custom" : String(r.machineId), customName: r.machineId === null ? r.machineCode : "", customDept: r.dept, customCentre: r.centre ?? "", startTime: r.startTime ?? "", endTime: r.endTime ?? "", endsNextDay: r.endsNextDay ?? false, reasonCode: r.reasonCode ?? "", reason: r.reason ?? "" }); }}><Pencil size={14} aria-hidden /></button>
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
