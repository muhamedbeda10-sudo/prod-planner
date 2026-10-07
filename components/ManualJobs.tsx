"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { createManualJob, deleteManualJob, reopenManualJob, type ManualActionResult } from "@/app/worklist/manualActions";
import { assignLineMachine } from "@/app/worklist/machineActions";
import { MANUAL_BOM, MANUAL_ITEM, manualMo, type ManualJobView } from "@/lib/domain/manualJob";
import { MATERIAL_PRESETS, SHEET_SIZE_PRESETS } from "@/lib/domain/material";
import { machineWord } from "@/lib/domain/shifts";
import { formatDate } from "@/lib/domain/format";
import type { MachineDTO } from "@/lib/server/machines";

// ✋ Jobs from outside the plan: typed in on the board and put on a machine
// to be worked like any plan line — and kept, in a list to come back to.

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const run = (fn: (fd: FormData) => Promise<ManualActionResult>, fd: FormData, after?: () => void) => {
    setErr("");
    start(async () => {
      const r = await fn(fd);
      if (!r.ok) { setErr(r.error ?? "Could not save."); return; }
      after?.();
      router.refresh();
    });
  };
  return { pending, err, run };
}

/** "+ Job" — a job the plan does not carry, straight onto a machine. */
export function AddManualJob({ dept, machines }: { dept: string; machines: MachineDTO[] }) {
  const [open, setOpen] = useState(false);
  const a = useRun();
  const word = machineWord(dept);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("dept", dept);
    a.run(createManualJob, fd, () => setOpen(false));
  };
  const field = "border rounded-md px-2 py-1.5 bg-surface text-sm w-full";
  const label = "block text-xs font-semibold text-muted mb-0.5";
  return (
    <>
      <button type="button" className="btn btn-sm btn-secondary ms-1 normal-case no-print" onClick={() => setOpen(true)} title={`Put a job that is not in the plan on a ${word} — a repair, a sample, a spare part. It is kept in the list.`}>
        ✋ Add job
      </button>
      {open && (
        <Modal title="✋ Add a job from outside the plan" sub={`It queues on the ${word} like any plan line, and stays in the Manual jobs list.`} onClose={() => setOpen(false)} busy={a.pending} width="max-w-xl">
          <form onSubmit={submit} className="grid grid-cols-2 gap-3">
            <label className="col-span-2"><span className={label}>What is it? *</span>
              <input name="title" required maxLength={120} className={field} placeholder="e.g. Brackets for maintenance, sample tank cover…" autoFocus />
            </label>
            <label><span className={label}>Pieces *</span>
              <input name="qty" type="number" min={1} step={1} required className={`${field} tabnum`} />
            </label>
            <label><span className={label}>{word[0].toUpperCase() + word.slice(1)}</span>
              <select name="machineId" defaultValue={machines[0]?.id ?? ""} className={field}>
                <option value="">— none yet, just save it —</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
              </select>
            </label>
            <label><span className={label}>BOM (if any)</span>
              <input name="bom" maxLength={60} className={field} />
            </label>
            <label><span className={label}>Part / item (if any)</span>
              <input name="item" maxLength={60} className={field} placeholder="Tank, bracket…" />
            </label>
            <div className="col-span-2 text-[11px] font-bold uppercase tracking-wide text-muted border-t pt-2">The sheet — for the technician</div>
            <label><span className={label}>Thickness (mm)</span>
              <input name="thicknessMm" type="number" min={0} step="0.1" className={`${field} tabnum`} />
            </label>
            <label><span className={label}>Material</span>
              <input name="material" list="manual-materials" className={field} placeholder="Steel, GI…" />
              <datalist id="manual-materials">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            <label><span className={label}>Sheet size</span>
              <input name="sheetSize" list="manual-sizes" className={field} placeholder="1220*2440" />
              <datalist id="manual-sizes">{SHEET_SIZE_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            <label><span className={label}>Sheets for the job</span>
              <input name="sheets" type="number" min={0} step="0.01" className={`${field} tabnum`} />
            </label>
            <label className="col-span-2"><span className={label}>Note</span>
              <input name="note" maxLength={500} className={field} placeholder="Who asked for it, drawing no., …" />
            </label>
            {a.err && <p className="col-span-2 text-sm font-semibold text-bad-fg">{a.err}</p>}
            <div className="col-span-2 flex justify-end gap-2">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={a.pending}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={a.pending}>{a.pending ? "Saving…" : "Save job"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

const sheetText = (j: ManualJobView) =>
  [j.thicknessMm !== null ? `${j.thicknessMm} mm` : "", j.material, j.sheetSize.replace(/\*/g, "×"), j.sheets !== null ? `${j.sheets} sh` : ""].filter(Boolean).join(" · ");

/** 📋 The jobs typed in from outside the plan — open ones first, then the
 *  finished ones — to come back to: put one on a machine again, open a
 *  finished one for more pieces, or delete a mistake. */
export function ManualJobsList({ dept, jobs, machines, canEdit }: { dept: string; jobs: ManualJobView[]; machines: MachineDTO[]; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const a = useRun();
  const word = machineWord(dept);
  const openCount = jobs.filter((j) => !j.doneAtISO).length;
  const putOn = (j: ManualJobView, machineId: string) => {
    const fd = new FormData();
    fd.set("dept", dept); fd.set("bom", MANUAL_BOM); fd.set("mo", manualMo(j.id)); fd.set("item", MANUAL_ITEM); fd.set("machineId", machineId);
    a.run(assignLineMachine, fd);
  };
  const byId = (fn: (fd: FormData) => Promise<ManualActionResult>, id: number, extra?: Record<string, string>) => {
    const fd = new FormData();
    fd.set("id", String(id));
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    a.run(fn, fd);
  };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost ms-1 normal-case no-print" onClick={() => setOpen(true)} title="Every job typed in from outside the plan — open and finished">
        📋 Manual jobs{openCount > 0 ? ` (${openCount})` : ""}
      </button>
      {open && (
        <Modal title="📋 Manual jobs" sub={`Jobs put on a ${word} from outside the plan — kept here, done or not.`} onClose={() => setOpen(false)} busy={a.pending} width="max-w-5xl">
          {jobs.length === 0 ? (
            <p className="text-sm text-muted">None yet — ✋ Add job puts one on a {word}.</p>
          ) : (
            <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-left text-xs text-muted border-b">
                    <th className="p-2">Job</th>
                    <th className="p-2 text-center">Done</th>
                    <th className="p-2">Sheet</th>
                    <th className="p-2">Where</th>
                    <th className="p-2">Added</th>
                    {canEdit && <th className="p-2"></th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {jobs.map((j) => {
                    const done = !!j.doneAtISO;
                    return (
                      <tr key={j.id} className={done ? "opacity-70" : ""}>
                        <td className="p-2">
                          <div className="font-bold">{j.title}</div>
                          <div className="text-xs text-muted">{[j.bom && `BOM ${j.bom}`, j.item, j.note].filter(Boolean).join(" · ") || "—"}</div>
                        </td>
                        <td className="p-2 text-center tabnum whitespace-nowrap"><b>{j.doneQty}</b> / {j.qty}</td>
                        <td className="p-2 text-xs whitespace-nowrap">{sheetText(j) || "—"}</td>
                        <td className="p-2 text-xs whitespace-nowrap">
                          {done ? <span className="pill pill-ok">✓ done {formatDate(j.doneAtISO!.slice(0, 10))}</span>
                            : j.onMachines.length > 0 ? <span className="pill pill-muted">on {j.onMachines.join(", ")}</span>
                            : <span className="pill pill-warn">on no {word}</span>}
                          {j.lastMachine && <div className="text-muted mt-0.5">last on {j.lastMachine}</div>}
                        </td>
                        <td className="p-2 text-xs text-muted whitespace-nowrap">{formatDate(j.createdAtISO.slice(0, 10))}{j.createdBy ? ` · ${j.createdBy}` : ""}</td>
                        {canEdit && (
                          <td className="p-2 whitespace-nowrap text-right">
                            {!done && (
                              <select
                                className="border rounded-md px-1.5 py-1 bg-surface text-xs me-1"
                                value=""
                                disabled={a.pending}
                                onChange={(e) => { if (e.target.value) putOn(j, e.target.value); }}
                                title={`Put it on a ${word} — at the back of its queue`}
                              >
                                <option value="">{j.onMachines.length > 0 ? "Move to…" : "Put on…"}</option>
                                {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
                              </select>
                            )}
                            {done && (
                              <button type="button" className="btn btn-sm btn-secondary me-1" disabled={a.pending} title="Open it again for more pieces"
                                onClick={() => { const v = prompt(`More pieces of “${j.title}” wanted:`, "1"); if (v === null) return; byId(reopenManualJob, j.id, { more: v.trim() || "0" }); }}>
                                ↺ Again
                              </button>
                            )}
                            <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={a.pending} title="Delete — typed by mistake"
                              onClick={() => { if (confirm(`Delete “${j.title}”? It goes off every ${word} and out of the list.`)) byId(deleteManualJob, j.id); }}>
                              ✕
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {a.err && <p className="text-sm font-semibold text-bad-fg mt-2">{a.err}</p>}
        </Modal>
      )}
    </>
  );
}
