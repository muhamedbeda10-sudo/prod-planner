"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Wrench } from "lucide-react";
import { EmptyState, Note } from "@/components/primitives";
import { Badge } from "@/components/Badge";
import { ExportButton } from "@/components/ExportButton";
import { TableFrame, Th, useConfirm } from "@/components/DataTable";
import { DOWNTIME_REASONS, MAX_STOP_HOURS, STOP_STEP, downtimeByCause, downtimeLabel } from "@/lib/domain/downtime";
import { WORK_CENTRE_LABEL, isRosterDept, round1, type RosterDept } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import { formatDate } from "@/lib/domain/format";
import type { DowntimeDay } from "@/lib/server/downtime";
import { addDowntime, deleteDowntime } from "@/app/shifts/downtimeActions";

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
  const [form, setForm] = useState({ machineId: "", hours: "", reasonCode: "", reason: "" });
  const byDept = useMemo(() => {
    const groups = new Map<string, typeof machines>();
    for (const m of machines) groups.set(m.dept, [...(groups.get(m.dept) ?? []), m]);
    return [...groups.entries()];
  }, [machines]);
  const { causes, unplannedH, plannedH } = downtimeByCause(data.rows);

  const add = () => {
    const fd = new FormData();
    fd.set("date", data.dateISO);
    for (const [k, v] of Object.entries(form)) fd.set(k, v);
    setMsg(null);
    start(async () => {
      const res = await addDowntime(fd);
      if (res.ok) {
        const m = machines.find((x) => String(x.id) === form.machineId);
        setMsg({ ok: true, text: `Recorded — ${m?.code ?? "the machine"} stood ${res.hours} h.` });
        setForm({ machineId: form.machineId, hours: "", reasonCode: "", reason: "" });
        router.refresh();
      } else setMsg({ ok: false, text: res.error ?? "Could not record the stop." });
    });
  };

  const remove = async (id: number, label: string) => {
    if (!(await confirm({ title: "Delete this stop?", body: "Its hours come back to the machine's day and leave the loss counts.", items: [label], confirmLabel: "Delete", danger: true }))) return;
    const fd = new FormData();
    fd.set("id", String(id));
    start(async () => {
      const res = await deleteDowntime(fd);
      setMsg(res.ok ? { ok: true, text: "Stop deleted." } : { ok: false, text: res.error ?? "Could not delete." });
      if (res.ok) router.refresh();
    });
  };

  const ready = form.machineId && Number(form.hours) > 0 && form.reasonCode;

  return (
    <div className="space-y-3">
      {confirmDialog}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="!mb-0">Machine stops — {formatDate(data.dateISO)}</h2>
        <span className="text-sm text-muted tabnum">
          {data.rows.length === 0 ? "none recorded" : `${round1(unplannedH)} h lost${plannedH > 0 ? ` · ${round1(plannedH)} h planned maintenance` : ""}`}
        </span>
        {data.rows.length > 0 && (
          <span className="ms-auto">
            <ExportButton
              filename={`machine-stops-${data.dateISO}.xlsx`}
              sheetName="Stops"
              rows={data.rows.map((r) => ({ Date: data.dateISO, Machine: r.machineCode, Name: r.machineName, Centre: r.centre ? WORK_CENTRE_LABEL[r.centre] : deptName(r.dept), Hours: r.hours, Why: downtimeLabel(r.reasonCode, r.reason), Note: r.reasonCode ? r.reason ?? "" : "", By: r.recordedBy ?? "" }))}
            />
          </span>
        )}
      </div>

      {machines.length > 0 && (
        <div className="toolbar !mb-0">
          <div className="toolbar-row">
            <select value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value }))} aria-label="Machine" className="ctl" disabled={pending}>
              <option value="">Machine…</option>
              {byDept.map(([dept, ms]) => (
                <optgroup key={dept} label={deptName(dept)}>
                  {ms.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                </optgroup>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input type="number" min={STOP_STEP} max={MAX_STOP_HOURS} step={STOP_STEP} inputMode="decimal" value={form.hours} onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))} aria-label="Hours stopped" placeholder="Hours" className="ctl w-24 tabnum ltr" disabled={pending} />
              <span className="text-muted">h</span>
            </label>
            <select value={form.reasonCode} onChange={(e) => setForm((f) => ({ ...f, reasonCode: e.target.value }))} aria-label="Why it stopped" className="ctl" disabled={pending}>
              <option value="">Why…</option>
              {DOWNTIME_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} aria-label="Note" placeholder="Note (optional)" maxLength={200} className="ctl min-w-[12rem] flex-1" disabled={pending} />
            <button type="button" className="btn btn-primary btn-sm" disabled={pending || !ready} onClick={add}>
              <Plus size={14} aria-hidden /> Add stop
            </button>
          </div>
        </div>
      )}
      <Note msg={msg} />

      {data.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState compact icon={Wrench} title="No machine stopped this day" hint={machines.length > 0 ? "Add a stop above when a machine stands — a breakdown, no material, a setup — so what it costs is counted." : "Recording stops needs the department's shift-log permission."} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" aria-label="Hours by cause">
            {causes.map((c) => (
              <Badge key={c.code} tone={c.planned ? "neutral" : "danger"}>{c.label} · {c.hours} h</Badge>
            ))}
          </div>
          <section className="bg-surface border rounded-xl overflow-hidden">
            <TableFrame>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th label="Machine" />
                    <Th label="Centre" className="max-md:hidden" />
                    <Th label="Hours" num className="text-right" />
                    <Th label="Why" />
                    <Th label="Note" className="max-md:hidden" />
                    <Th label="By" className="max-md:hidden" />
                    <th className="w-10" aria-label="Delete" />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 whitespace-nowrap"><span className="code-chip">{r.machineCode}</span> <span className="text-muted ms-1">{r.machineName}</span></td>
                      <td className="px-2 text-muted max-md:hidden">{r.centre ? WORK_CENTRE_LABEL[r.centre] : deptName(r.dept)}</td>
                      <td className="px-2 text-right tabnum font-bold">{r.hours}</td>
                      <td className="px-2">{downtimeLabel(r.reasonCode, r.reason)}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.reasonCode ? r.reason ?? "" : ""}</td>
                      <td className="px-2 text-muted max-md:hidden">{r.recordedBy ?? ""}</td>
                      <td className="px-1 text-center">
                        {canRecord(r.dept) && (
                          <button type="button" className="btn btn-sm btn-ghost" disabled={pending} aria-label={`Delete the stop of ${r.machineCode}`} onClick={() => remove(r.id, `${r.machineCode} · ${r.hours} h · ${downtimeLabel(r.reasonCode, r.reason)}`)}>
                            <Trash2 size={14} aria-hidden />
                          </button>
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
