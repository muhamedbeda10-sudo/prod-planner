"use client";

import { useState, useTransition } from "react";
import { WORKER_DEPTS, WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { createWorker, updateWorker, setWorkerActive, deleteWorker } from "./actions";

// The list behind every "who did this?" dropdown. Kept deliberately plain: a
// name, an optional badge number, and the stages the person can be credited in.

const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";

function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  function run(
    fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    fd: FormData,
    okText: string,
    after?: () => void
  ) {
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

function DeptChecks({ defaults, disabled }: { defaults: Set<string>; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {WORKER_DEPTS.map((d) => (
        <label key={d} className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="checkbox"
            name="depts"
            value={d}
            defaultChecked={defaults.has(d)}
            disabled={disabled}
            className="accent-[var(--brand,#1b7a43)]"
          />
          <span className="font-semibold">{WORKER_DEPT_LABEL[d]}</span>
        </label>
      ))}
    </div>
  );
}

function WorkerCard({ worker, onClose }: { worker: WorkerDTO; onClose?: () => void }) {
  const [editing, setEditing] = useState(!!onClose);
  const edit = useAction();
  const act = useAction();
  const del = useAction();
  const depts = new Set(worker.depts);

  return (
    <div className={`border rounded-xl p-4 ${worker.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="font-bold flex items-center gap-2">
            <code className="ltr tabnum text-sm px-1.5 py-0.5 rounded bg-surface-2 border">{worker.empId}</code>
            {worker.name}
            {worker.stamp && <span className="pill pill-muted ltr">stamp {worker.stamp}</span>}
            {!worker.active && <span className="pill pill-muted">Deactivated</span>}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {worker.jobTitle ? `${worker.jobTitle} · ` : ""}
            {worker.depts.length > 0 ? worker.depts.map((d) => WORKER_DEPT_LABEL[d]).join(" · ") : "No stage assigned"}
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => (onClose && editing ? onClose() : setEditing((v) => !v))}>
          {editing ? "Close" : "Edit"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={act.pending}
          onClick={() => {
            const fd = new FormData();
            fd.set("id", String(worker.id));
            fd.set("active", worker.active ? "false" : "true");
            act.run(setWorkerActive, fd, worker.active ? "Deactivated." : "Back on the list.");
          }}
        >
          {worker.active ? "Deactivate" : "Activate"}
        </button>
        <button
          type="button"
          className="btn btn-sm text-bad-fg"
          disabled={del.pending}
          onClick={() => {
            if (!confirm(`Delete ${worker.name} permanently?`)) return;
            const fd = new FormData();
            fd.set("id", String(worker.id));
            del.run(deleteWorker, fd, "Deleted.");
          }}
        >
          Delete
        </button>
      </div>

      <Msg msg={act.msg} />
      <Msg msg={del.msg} />

      {editing && (
        <form
          className="mt-3 space-y-2.5 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("id", String(worker.id));
            edit.run(updateWorker, fd, "Saved.", () => (onClose ? onClose() : setEditing(false)));
          }}
        >
          <div className="grid sm:grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-xs font-bold text-muted">ID</span>
              <input name="empId" defaultValue={worker.empId} required inputMode="numeric" className={`${inputCls} ltr tabnum`} />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-muted">Name</span>
              <input name="name" defaultValue={worker.name} required className={inputCls} />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-muted">Job title (optional)</span>
              <input name="jobTitle" defaultValue={worker.jobTitle ?? ""} className={inputCls} />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-muted" title="The letter this welder punches into every tank he welds">
                Welder stamp (optional)
              </span>
              <input name="stamp" defaultValue={worker.stamp ?? ""} maxLength={4} className={`${inputCls} ltr`} />
            </label>
          </div>
          <DeptChecks defaults={depts} disabled={edit.pending} />
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>
              Save
            </button>
            <Msg msg={edit.msg} />
          </div>
        </form>
      )}
    </div>
  );
}

/** One department's column: its people, active first, the retired dimmed at the end. */
function DeptColumn({ title, count, workers, selectedId, onPick }: { title: string; count: number; workers: WorkerDTO[]; selectedId: number | null; onPick: (id: number) => void }) {
  return (
    <div className="bg-surface border rounded-xl overflow-hidden flex flex-col min-w-[11rem]">
      <div className="px-3 py-2 bg-brand text-white flex items-baseline gap-2">
        <span className="font-bold text-sm">{title}</span>
        <span className="ms-auto text-xs tabnum opacity-90">{count}</span>
      </div>
      {workers.length === 0 ? (
        <p className="text-xs text-muted p-3">Nobody yet</p>
      ) : (
        <ul className="divide-y">
          {workers.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => onPick(w.id)}
                className={`w-full text-start px-3 py-1.5 hover:bg-surface-2 ${selectedId === w.id ? "bg-surface-2" : ""} ${w.active ? "" : "opacity-50"}`}
                title={w.active ? "Edit" : "Deactivated — click to edit or reactivate"}
              >
                <span className="block font-semibold text-sm leading-tight">{w.name}</span>
                <span className="block text-[11px] text-muted ltr tabnum">{w.empId}{w.jobTitle ? ` · ${w.jobTitle}` : ""}{w.stamp ? ` · ${w.stamp}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorkersManager({ workers }: { workers: WorkerDTO[] }) {
  const add = useAction();
  const [open, setOpen] = useState(workers.length === 0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = workers.find((w) => w.id === selectedId) ?? null;

  // a worker sits in every department he is ticked for; the active first
  const order = (a: WorkerDTO, b: WorkerDTO) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name);
  const byDept = WORKER_DEPTS.map((d) => ({ dept: d, list: workers.filter((w) => w.depts.includes(d)).sort(order) }));
  const unassigned = workers.filter((w) => w.depts.length === 0).sort(order);
  const activeCount = (list: WorkerDTO[]) => list.filter((w) => w.active).length;

  return (
    <div className="space-y-5">
      {/* the head-count per department — active people; the retired are not counted */}
      <div className="flex flex-wrap gap-2">
        {byDept.map(({ dept, list }) => (
          <div key={dept} className="bg-surface border rounded-xl px-3 py-2 min-w-[7.5rem]">
            <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{WORKER_DEPT_LABEL[dept]}</div>
            <div className="text-2xl font-extrabold tabnum leading-tight">{activeCount(list)}</div>
            {list.length > activeCount(list) && <div className="text-[11px] text-muted tabnum">+{list.length - activeCount(list)} deactivated</div>}
          </div>
        ))}
        <div className="bg-surface border rounded-xl px-3 py-2 min-w-[7.5rem]">
          <div className="text-[11px] font-bold text-muted uppercase tracking-wide">All workers</div>
          <div className="text-2xl font-extrabold tabnum leading-tight">{activeCount(workers)}</div>
          <div className="text-[11px] text-muted tabnum">{workers.length - activeCount(workers)} deactivated{unassigned.length ? ` · ${unassigned.length} in no department` : ""}</div>
        </div>
        <div className="ms-auto self-center">
          <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "➕ Add a worker"}
          </button>
        </div>
      </div>

      {open && (
        <div className="border rounded-xl p-4">
          <form
            className="space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              add.run(createWorker, new FormData(form), "Added.", () => form.reset());
            }}
          >
            <div className="grid sm:grid-cols-2 gap-2.5">
              <label className="block">
                <span className="text-xs font-bold text-muted">ID</span>
                <input name="empId" required inputMode="numeric" placeholder="Badge number, e.g. 100058" className={`${inputCls} ltr tabnum`} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-muted">Name</span>
                <input name="name" required placeholder="Worker's name" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-muted">Job title (optional)</span>
                <input name="jobTitle" placeholder="Tank Full Welder" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-muted" title="The letter this welder punches into every tank he welds">
                  Welder stamp (optional)
                </span>
                <input name="stamp" maxLength={4} placeholder="X" className={`${inputCls} ltr`} />
              </label>
            </div>
            <DeptChecks defaults={new Set()} disabled={add.pending} />
            <div className="flex items-center gap-3">
              <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>
                Add
              </button>
              <Msg msg={add.msg} />
            </div>
          </form>
        </div>
      )}

      {/* the one being edited — above the columns, so the columns never reflow */}
      {selected && <WorkerCard key={selected.id} worker={selected} onClose={() => setSelectedId(null)} />}

      {workers.length === 0 ? (
        <p className="text-sm text-muted">
          No workers on the list yet. Without them, the shop floor has no ID to enter when recording who welded, tested or painted a tank.
        </p>
      ) : (
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          {byDept.map(({ dept, list }) => (
            <DeptColumn key={dept} title={WORKER_DEPT_LABEL[dept]} count={activeCount(list)} workers={list} selectedId={selectedId} onPick={setSelectedId} />
          ))}
          {unassigned.length > 0 && (
            <DeptColumn title="No department" count={activeCount(unassigned)} workers={unassigned} selectedId={selectedId} onPick={setSelectedId} />
          )}
        </div>
      )}
    </div>
  );
}
