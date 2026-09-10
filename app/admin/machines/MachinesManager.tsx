"use client";

import { useState, useTransition } from "react";
import { deptLabel } from "@/lib/domain/constants";
import { CENTERS, CENTER_LABEL, SHIFT_DEPTS, type ShiftDept } from "@/lib/domain/shifts";
import type { MachineDTO } from "@/lib/server/machines";
import { createMachine, updateMachine, setMachineActive, deleteMachine } from "./actions";

// The machines list, by department. A code, a name, the work centre it
// belongs to (every laser and punch is "Cutting" — a job goes to whichever is
// free) and the hours it is available on a working day.

const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";

function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  function run(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn(fd);
      setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
      if (res.ok) after?.();
    });
  }
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

function Fields({ m, disabled }: { m?: MachineDTO; disabled?: boolean }) {
  const [dept, setDept] = useState<ShiftDept>((m?.dept as ShiftDept) ?? "Cut");
  const centers = CENTERS[dept];
  return (
    <div className="grid gap-2.5 md:grid-cols-6">
      <label className="text-xs font-semibold">
        <span className="block mb-1 text-muted">Code</span>
        <input name="code" defaultValue={m?.code ?? ""} required placeholder="B4-10" disabled={disabled} className={`${inputCls} ltr`} />
      </label>
      <label className="text-xs font-semibold md:col-span-2">
        <span className="block mb-1 text-muted">Name</span>
        <input name="name" defaultValue={m?.name ?? ""} required placeholder="Bodor 3K watt" disabled={disabled} className={inputCls} />
      </label>
      <label className="text-xs font-semibold">
        <span className="block mb-1 text-muted">Department</span>
        <select name="dept" value={dept} onChange={(e) => setDept(e.target.value as ShiftDept)} disabled={disabled} className={inputCls}>
          {SHIFT_DEPTS.map((d) => <option key={d} value={d}>{deptLabel(d)}</option>)}
        </select>
      </label>
      <label className="text-xs font-semibold">
        <span className="block mb-1 text-muted">Work centre</span>
        <select name="center" defaultValue={m?.center ?? centers[0] ?? ""} disabled={disabled || centers.length === 0} className={inputCls}>
          {centers.length === 0 && <option value="">—</option>}
          {centers.map((c) => <option key={c} value={c}>{CENTER_LABEL[c] ?? c}</option>)}
        </select>
      </label>
      <label className="text-xs font-semibold">
        <span className="block mb-1 text-muted">Hours / day</span>
        <input name="hoursPerDay" type="number" min={0} max={24} step={0.5} defaultValue={m?.hoursPerDay ?? ""} placeholder="—" disabled={disabled} className={`${inputCls} tabnum`} />
      </label>
      <input type="hidden" name="sortOrder" value={m?.sortOrder ?? 0} />
    </div>
  );
}

function MachineRow({ m }: { m: MachineDTO }) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const act = useAction();
  const del = useAction();
  return (
    <div className={`border rounded-xl p-3 ${m.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <code className="ltr tabnum text-sm px-1.5 py-0.5 rounded bg-surface-2 border font-bold">{m.code}</code>
        <span className="font-bold">{m.name}</span>
        {m.center && <span className="pill pill-muted">{CENTER_LABEL[m.center] ?? m.center}</span>}
        <span className="text-xs text-muted tabnum">{m.hoursPerDay !== null ? `${m.hoursPerDay} h/day` : "hours/day not set"}</span>
        {!m.active && <span className="pill pill-muted">Retired</span>}
        <span className="ms-auto inline-flex gap-1">
          <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
          <button
            type="button" className="btn btn-sm" disabled={act.pending}
            onClick={() => { const fd = new FormData(); fd.set("id", String(m.id)); fd.set("active", m.active ? "false" : "true"); act.run(setMachineActive, fd, m.active ? "Retired." : "Back in service."); }}
          >
            {m.active ? "Retire" : "Bring back"}
          </button>
          <button
            type="button" className="btn btn-sm text-bad-fg" disabled={del.pending}
            onClick={() => { if (!confirm(`Delete ${m.code} ${m.name} permanently?`)) return; const fd = new FormData(); fd.set("id", String(m.id)); del.run(deleteMachine, fd, "Deleted."); }}
          >
            Delete
          </button>
        </span>
      </div>
      <Msg msg={act.msg} />
      <Msg msg={del.msg} />
      {editing && (
        <form
          className="mt-3 space-y-2.5 border-t pt-3"
          onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", String(m.id)); edit.run(updateMachine, fd, "Saved.", () => setEditing(false)); }}
        >
          <Fields m={m} disabled={edit.pending} />
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>Save</button>
            <Msg msg={edit.msg} />
          </div>
        </form>
      )}
    </div>
  );
}

export function MachinesManager({ machines }: { machines: MachineDTO[] }) {
  const add = useAction();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">{machines.length} machine(s) · retired ones stay on the days they were used and leave the dropdowns</span>
        <button type="button" className="btn btn-primary btn-sm ms-auto" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "➕ Add a machine"}</button>
      </div>
      {open && (
        <form
          className="border rounded-xl p-3 space-y-2.5"
          onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; add.run(createMachine, new FormData(form), "Added.", () => form.reset()); }}
        >
          <Fields disabled={add.pending} />
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>Add</button>
            <Msg msg={add.msg} />
          </div>
        </form>
      )}
      {SHIFT_DEPTS.map((d) => {
        const list = machines.filter((m) => m.dept === d);
        if (list.length === 0) return null;
        return (
          <section key={d} className="space-y-2">
            <h2>{deptLabel(d)} <span className="text-muted font-normal text-sm">· {list.length}</span></h2>
            {list.map((m) => <MachineRow key={m.id} m={m} />)}
          </section>
        );
      })}
    </div>
  );
}
