"use client";

import { useState } from "react";
import { Archive, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { deptLabel } from "@/lib/domain/constants";
import { CENTERS, CENTER_LABEL, SHIFT_DEPTS, type ShiftDept } from "@/lib/domain/shifts";
import type { MachineRuleView } from "@/lib/domain/machineRules";
import type { MachineDTO } from "@/lib/server/machines";
import { createMachine, updateMachine, setMachineActive, deleteMachine } from "./actions";
import { inputCls, Msg, useAction } from "./formBits";
import { MachineRules } from "./MachineRules";
import { Modal } from "@/components/Modal";
import { PageHead } from "@/components/ui";
import { EmptyState } from "@/components/primitives";

// The machines list, by department. A code, a name, the work centre it
// belongs to (every laser and punch is "Cutting" — a job goes to whichever is
// free) and the hours it is available on a working day — and the planner's
// rules for what each machine takes, which ⚡ Plan follows.

function Fields({ m, disabled }: { m?: MachineDTO; disabled?: boolean }) {
  const [dept, setDept] = useState<ShiftDept>((m?.dept as ShiftDept) ?? "Cut");
  const centers = CENTERS[dept];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
      <label className="block">
        <span className="field-label">Code</span>
        <input name="code" defaultValue={m?.code ?? ""} required placeholder="B4-10" disabled={disabled} className={`${inputCls} ltr`} />
      </label>
      <label className="block md:col-span-2">
        <span className="field-label">Name</span>
        <input name="name" defaultValue={m?.name ?? ""} required placeholder="Bodor 3K watt" disabled={disabled} className={inputCls} />
      </label>
      <label className="block">
        <span className="field-label">Department</span>
        <select name="dept" value={dept} onChange={(e) => setDept(e.target.value as ShiftDept)} disabled={disabled} className={inputCls}>
          {SHIFT_DEPTS.map((d) => <option key={d} value={d}>{deptLabel(d)}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="field-label">Work centre</span>
        <select name="center" defaultValue={m?.center ?? centers[0] ?? ""} disabled={disabled || centers.length === 0} className={inputCls}>
          {centers.length === 0 && <option value="">—</option>}
          {centers.map((c) => <option key={c} value={c}>{CENTER_LABEL[c] ?? c}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="field-label">Hours / day</span>
        <input name="hoursPerDay" type="number" min={0} max={24} step={0.5} defaultValue={m?.hoursPerDay ?? ""} placeholder="—" disabled={disabled} className={`${inputCls} tabnum`} />
      </label>
      <input type="hidden" name="sortOrder" value={m?.sortOrder ?? 0} />
    </div>
  );
}

function MachineRow({ m, rules, planningOn }: { m: MachineDTO; rules: MachineRuleView[]; planningOn: boolean }) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const act = useAction();
  const del = useAction();
  return (
    <article className={`rounded-xl border bg-surface ${m.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:px-4">
        <span className="code-chip">{m.code}</span>
        <span className="font-bold text-sm">{m.name}</span>
        {m.center && <span className="pill pill-muted">{CENTER_LABEL[m.center] ?? m.center}</span>}
        <span className="text-xs text-muted tabnum">{m.hoursPerDay !== null ? `${m.hoursPerDay} h/day` : "hours/day not set"}</span>
        {!m.active && <span className="pill pill-warn">Retired</span>}
        <span className="ms-auto inline-flex items-center gap-1">
          <button type="button" className="icon-btn icon-btn-md" onClick={() => setEditing(true)} title="Edit" aria-label={`Edit ${m.code}`}>
            <Pencil size={15} />
          </button>
          <button
            type="button" className="icon-btn icon-btn-md" disabled={act.pending}
            title={m.active ? "Retire — it leaves the dropdowns, its days stay" : "Bring back into service"}
            aria-label={m.active ? `Retire ${m.code}` : `Bring ${m.code} back`}
            onClick={() => { const fd = new FormData(); fd.set("id", String(m.id)); fd.set("active", m.active ? "false" : "true"); act.run(setMachineActive, fd, m.active ? "Retired." : "Back in service."); }}
          >
            {m.active ? <Archive size={15} /> : <RotateCcw size={15} />}
          </button>
          <button
            type="button" className="icon-btn icon-btn-md icon-btn-danger" disabled={del.pending} title="Delete" aria-label={`Delete ${m.code}`}
            onClick={() => { if (!confirm(`Delete ${m.code} ${m.name} permanently?`)) return; const fd = new FormData(); fd.set("id", String(m.id)); del.run(deleteMachine, fd, "Deleted."); }}
          >
            <Trash2 size={15} />
          </button>
        </span>
        <Msg msg={act.msg} />
        <Msg msg={del.msg} />
      </div>
      <MachineRules machine={m} rules={rules} planningOn={planningOn} />
      {editing && (
        <Modal title={`Edit ${m.code}`} sub={m.name} onClose={() => setEditing(false)} busy={edit.pending}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", String(m.id)); edit.run(updateMachine, fd, "Saved.", () => setEditing(false)); }}
          >
            <Fields m={m} disabled={edit.pending} />
            <div className="flex items-center justify-end gap-2 pt-3 border-t">
              <Msg msg={edit.msg} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={edit.pending}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>{edit.pending ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </Modal>
      )}
    </article>
  );
}

export function MachinesManager({ machines, rules, planningOn }: { machines: MachineDTO[]; rules: MachineRuleView[]; planningOn: boolean }) {
  const add = useAction();
  const [open, setOpen] = useState(false);
  const live = machines.filter((m) => m.active).length;
  return (
    <div className="space-y-4">
      <PageHead
        title="Machines & lines"
        sub={`${live} in service${machines.length > live ? ` · ${machines.length - live} retired — they stay on the days they were used and leave the dropdowns` : ""}${planningOn ? "" : " · machine planning is off (Settings)"}`}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden /> Add a machine
          </button>
        }
      />
      {open && (
        <Modal title="Add a machine" onClose={() => setOpen(false)} busy={add.pending}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; add.run(createMachine, new FormData(form), "Added.", () => { form.reset(); setOpen(false); }); }}
          >
            <Fields disabled={add.pending} />
            <div className="flex items-center justify-end gap-2 pt-3 border-t">
              <Msg msg={add.msg} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={add.pending}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>{add.pending ? "Adding…" : "Add"}</button>
            </div>
          </form>
        </Modal>
      )}
      {machines.length === 0 && (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Plus}
            title="No machines yet"
            hint="Add the lasers, punches, presses, shot-blast cabinets and paint lines — the worklists and ⚡ Plan put the work on them."
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Add the first machine</button>}
          />
        </div>
      )}
      {SHIFT_DEPTS.map((d) => {
        const list = machines.filter((m) => m.dept === d);
        if (list.length === 0) return null;
        return (
          <section key={d} className="space-y-2">
            <h2 className="flex items-baseline gap-2">
              {deptLabel(d)}
              <span className="text-xs font-normal normal-case tracking-normal text-muted tabnum">{list.length}</span>
            </h2>
            {list.map((m) => <MachineRow key={m.id} m={m} rules={rules.filter((r) => r.machineId === m.id)} planningOn={planningOn} />)}
          </section>
        );
      })}
    </div>
  );
}
