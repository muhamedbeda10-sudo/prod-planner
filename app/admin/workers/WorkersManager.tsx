"use client";

import { useState, useTransition } from "react";
import { WORKER_GROUPS, WORKER_SECTIONS, sectionLabel } from "@/lib/domain/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { createWorker, updateWorker, setWorkerActive, deleteWorker, setWorkerVacation } from "./actions";
import { parseISODate, toDisplayDate } from "@/lib/domain/dates";
import { Modal } from "@/components/Modal";

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
    <div className="space-y-2">
      {WORKER_GROUPS.map((g) => (
        <div key={g.key} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-[11px] font-bold text-muted uppercase tracking-wide w-24">{g.label}</span>
          {WORKER_SECTIONS.filter((sec) => sec.group === g.key).map((sec) => (
            <label key={sec.code} className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                name="depts"
                value={sec.code}
                defaultChecked={defaults.has(sec.code)}
                disabled={disabled}
                className="accent-[var(--brand,#1b7a43)]"
              />
              <span className="font-semibold">{sec.label}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function WorkerCard({ worker, onClose }: { worker: WorkerDTO; onClose?: () => void }) {
  const [editing, setEditing] = useState(!!onClose);
  const edit = useAction();
  const act = useAction();
  const del = useAction();
  const vac = useAction();
  const depts = new Set(worker.sections);

  return (
    <div className={`border rounded-xl p-4 ${worker.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="font-bold flex items-center gap-2">
            <code className="ltr tabnum text-sm px-1.5 py-0.5 rounded bg-surface-2 border">{worker.empId}</code>
            {worker.name}
            {worker.stamp && <span className="pill pill-muted ltr">stamp {worker.stamp}</span>}
            {!worker.active && <span className="pill pill-muted">Deactivated</span>}
            {worker.onVacation && <span className="pill pill-warn">On vacation until {toDisplayDate(parseISODate(worker.vacationUntil!)!)}</span>}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {worker.jobTitle ? `${worker.jobTitle} · ` : ""}
            {worker.sections.length > 0 ? worker.sections.map(sectionLabel).join(" · ") : "No section assigned"}
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => (onClose && editing ? onClose() : setEditing((v) => !v))}>
          {editing ? "Close" : "Edit"}
        </button>
        {worker.onVacation ? (
          <button
            type="button" className="btn btn-sm" disabled={vac.pending}
            onClick={() => { const fd = new FormData(); fd.set("id", String(worker.id)); fd.set("until", ""); vac.run(setWorkerVacation, fd, "Back at work."); }}
          >
            Back at work
          </button>
        ) : (
          <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
            Vacation until
            <input
              type="date" aria-label="On vacation until" disabled={vac.pending}
              className="border rounded-md px-2 py-1 bg-surface text-sm ltr tabnum"
              onChange={(e) => { if (!e.target.value) return; const fd = new FormData(); fd.set("id", String(worker.id)); fd.set("until", e.target.value); vac.run(setWorkerVacation, fd, "On vacation."); }}
            />
          </label>
        )}
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
      <Msg msg={vac.msg} />

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
            <label className="block">
              <span className="text-xs font-bold text-muted">On vacation until (optional)</span>
              <input name="vacationUntil" type="date" defaultValue={worker.vacationUntil ?? ""} className={`${inputCls} ltr tabnum`} />
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
function DeptColumn({ title, count, workers, selectedId, onPick, tone }: { title: string; count: number; workers: WorkerDTO[]; selectedId: number | null; onPick: (id: number) => void; tone?: "warn" }) {
  return (
    <div className="bg-surface border rounded-xl overflow-hidden flex flex-col min-w-[11rem]">
      <div className={`px-3 py-2 text-white flex items-baseline gap-2 ${tone === "warn" ? "bg-[var(--warn-fg,#b45309)]" : "bg-brand"}`}>
        <span className="font-bold text-sm">{title}</span>
        <span className="ms-auto text-xs tabnum opacity-90">{count}</span>
      </div>
      {workers.length === 0 ? (
        <p className="text-xs text-muted p-3">{tone === "warn" ? "Nobody away" : "Nobody yet"}</p>
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
                {w.onVacation && <span className="pill pill-warn mt-0.5">until {toDisplayDate(parseISODate(w.vacationUntil!)!)}</span>}
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

  // a worker sits in every section he is ticked for; the active first
  const order = (a: WorkerDTO, b: WorkerDTO) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name);
  const activeCount = (list: WorkerDTO[]) => list.filter((w) => w.active).length;
  const groups = WORKER_GROUPS.map((g) => {
    const sections = WORKER_SECTIONS.filter((sec) => sec.group === g.key).map((sec) => ({ ...sec, list: workers.filter((w) => w.sections.includes(sec.code)).sort(order) }));
    const people = workers.filter((w) => w.sections.some((c) => sections.some((sec) => sec.code === c)));
    return { ...g, sections, people };
  });
  const unassigned = workers.filter((w) => w.sections.length === 0).sort(order);
  const away = workers.filter((w) => w.active && w.onVacation).sort((a, b) => (a.vacationUntil ?? "").localeCompare(b.vacationUntil ?? ""));

  return (
    <div className="space-y-5">
      {/* the head-count per part of the plant — active people; the retired are not counted */}
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <div key={g.key} className="bg-surface border rounded-xl px-3 py-2 min-w-[8rem]">
            <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{g.label}</div>
            <div className="text-2xl font-extrabold tabnum leading-tight">{activeCount(g.people)}</div>
            <div className="text-[11px] text-muted tabnum">{g.sections.length} section{g.sections.length === 1 ? "" : "s"}{g.people.length > activeCount(g.people) ? ` · +${g.people.length - activeCount(g.people)} deactivated` : ""}</div>
          </div>
        ))}
        <div className="bg-surface border rounded-xl px-3 py-2 min-w-[8rem]">
          <div className="text-[11px] font-bold text-muted uppercase tracking-wide">On vacation</div>
          <div className={`text-2xl font-extrabold tabnum leading-tight ${away.length ? "text-warn-fg" : ""}`}>{away.length}</div>
          <div className="text-[11px] text-muted">absent on the shift log until they are back</div>
        </div>
        <div className="bg-surface border rounded-xl px-3 py-2 min-w-[8rem]">
          <div className="text-[11px] font-bold text-muted uppercase tracking-wide">All workers</div>
          <div className="text-2xl font-extrabold tabnum leading-tight">{activeCount(workers)}</div>
          <div className="text-[11px] text-muted tabnum">{workers.length - activeCount(workers)} deactivated{unassigned.length ? ` · ${unassigned.length} in no section` : ""}</div>
        </div>
        <div className="ms-auto self-center">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            ➕ Add a worker
          </button>
        </div>
      </div>

      {open && (
        <Modal title="➕ Add a worker" sub="After Add the form clears for the next one." onClose={() => setOpen(false)} busy={add.pending}>
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
            <div className="flex items-center justify-end gap-3 pt-3 border-t">
              <Msg msg={add.msg} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={add.pending}>Close</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>
                {add.pending ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* the one being edited, in a popup over the columns */}
      {selected && (
        <Modal title={selected.name} sub={`ID ${selected.empId}`} onClose={() => setSelectedId(null)} width="max-w-3xl">
          <WorkerCard key={selected.id} worker={selected} onClose={() => setSelectedId(null)} />
        </Modal>
      )}

      {workers.length === 0 ? (
        <p className="text-sm text-muted">
          No workers on the list yet. Without them, the shop floor has no ID to enter when recording who welded, tested or painted a tank.
        </p>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="flex items-baseline gap-2">
                {g.label}
                <span className="text-sm font-normal text-muted tabnum">{activeCount(g.people)} people</span>
              </h2>
              <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
                {g.sections.map((sec) => (
                  <DeptColumn key={sec.code} title={sec.label} count={activeCount(sec.list)} workers={sec.list} selectedId={selectedId} onPick={setSelectedId} />
                ))}
              </div>
            </section>
          ))}
          <section>
            <h2 className="flex items-baseline gap-2">
              Away
              <span className="text-sm font-normal text-muted tabnum">{away.length} on vacation</span>
            </h2>
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
              <DeptColumn title="On vacation" count={away.length} workers={away} selectedId={selectedId} onPick={setSelectedId} tone="warn" />
              {unassigned.length > 0 && (
                <DeptColumn title="No section" count={activeCount(unassigned)} workers={unassigned} selectedId={selectedId} onPick={setSelectedId} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
