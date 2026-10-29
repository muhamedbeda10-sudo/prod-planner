"use client";

import { formatDate } from "@/lib/domain/format";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { WORKER_GROUPS, WORKER_SECTIONS, sectionLabel } from "@/lib/domain/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { createWorker, updateWorker, setWorkerActive, deleteWorker, setWorkerVacation } from "./actions";
import { parseISODate } from "@/lib/domain/dates";
import { Modal } from "@/components/Modal";
import { PageHead } from "@/components/ui";
import { EmptyState, Note } from "@/components/primitives";

// The list behind every "who did this?" dropdown: the head-count per part of
// the plant, then each section's people as a column. A person opens in a
// popup to be edited, sent on vacation, deactivated or deleted.

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

function DeptChecks({ defaults, disabled }: { defaults: Set<string>; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      {WORKER_GROUPS.map((g) => (
        <div key={g.key} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="filter-label w-24">{g.label}</span>
          {WORKER_SECTIONS.filter((sec) => sec.group === g.key).map((sec) => (
            <label key={sec.code} className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                name="depts"
                value={sec.code}
                defaultChecked={defaults.has(sec.code)}
                disabled={disabled}
              />
              <span className="font-semibold">{sec.label}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function Field({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="field-label" title={title}>{label}</span>
      {children}
    </label>
  );
}

/** One person, open in the popup: what they are, then the form. */
function WorkerCard({ worker, onClose }: { worker: WorkerDTO; onClose: () => void }) {
  const edit = useAction();
  const act = useAction();
  const del = useAction();
  const vac = useAction();
  const depts = new Set(worker.sections);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="code-chip">{worker.empId}</span>
        {worker.jobTitle && <span className="text-sm text-muted">{worker.jobTitle}</span>}
        {worker.stamp && <span className="pill pill-muted ltr">stamp {worker.stamp}</span>}
        {!worker.active && <span className="pill pill-muted">Deactivated</span>}
        {worker.onVacation && <span className="pill pill-warn">On vacation until {formatDate(parseISODate(worker.vacationUntil!)!)}</span>}
        <span className="text-xs text-muted">{worker.sections.length > 0 ? worker.sections.map(sectionLabel).join(" · ") : "No section assigned"}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {worker.onVacation ? (
          <button
            type="button" className="btn btn-secondary btn-sm" disabled={vac.pending}
            onClick={() => { const fd = new FormData(); fd.set("id", String(worker.id)); fd.set("until", ""); vac.run(setWorkerVacation, fd, "Back at work."); }}
          >
            Back at work
          </button>
        ) : (
          <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
            Vacation until
            <input
              type="date" aria-label="On vacation until" disabled={vac.pending}
              className="px-2 py-1 text-sm ltr tabnum"
              onChange={(e) => { if (!e.target.value) return; const fd = new FormData(); fd.set("id", String(worker.id)); fd.set("until", e.target.value); vac.run(setWorkerVacation, fd, "On vacation."); }}
            />
          </label>
        )}
        <span className="ms-auto inline-flex items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
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
            className="btn btn-ghost btn-sm text-bad-fg"
            disabled={del.pending}
            onClick={() => {
              if (!confirm(`Delete ${worker.name} permanently?`)) return;
              const fd = new FormData();
              fd.set("id", String(worker.id));
              del.run(deleteWorker, fd, "Deleted.", onClose);
            }}
          >
            Delete
          </button>
        </span>
      </div>
      <Note msg={act.msg} />
      <Note msg={del.msg} />
      <Note msg={vac.msg} />

      <form
        className="space-y-3 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          fd.set("id", String(worker.id));
          edit.run(updateWorker, fd, "Saved.", onClose);
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="ID"><input name="empId" defaultValue={worker.empId} required inputMode="numeric" className={`${inputCls} ltr tabnum`} /></Field>
          <Field label="Name"><input name="name" defaultValue={worker.name} required className={inputCls} /></Field>
          <Field label="Job title (optional)"><input name="jobTitle" defaultValue={worker.jobTitle ?? ""} className={inputCls} /></Field>
          <Field label="Welder stamp (optional)" title="The letter this welder punches into every tank he welds">
            <input name="stamp" defaultValue={worker.stamp ?? ""} maxLength={4} className={`${inputCls} ltr`} />
          </Field>
          <Field label="On vacation until (optional)"><input name="vacationUntil" type="date" defaultValue={worker.vacationUntil ?? ""} className={`${inputCls} ltr tabnum`} /></Field>
        </div>
        <DeptChecks defaults={depts} disabled={edit.pending} />
        <div className="flex items-center justify-end gap-3 pt-3 border-t">
          <Note msg={edit.msg} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={edit.pending}>Close</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>{edit.pending ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}

/** One section's column: its people, active first, the retired dimmed at the end. */
function DeptColumn({ title, count, workers, selectedId, onPick, tone }: { title: string; count: number; workers: WorkerDTO[]; selectedId: number | null; onPick: (id: number) => void; tone?: "warn" }) {
  return (
    <div className="col-card min-w-0">
      <div className={`col-head ${tone === "warn" ? "col-head-warn" : ""}`}>
        <span className="truncate">{title}</span>
        <span className="ms-auto pill pill-muted tabnum">{count}</span>
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
                className={`col-row ${selectedId === w.id ? "col-row-on" : ""} ${w.active ? "" : "opacity-50"}`}
                title={w.active ? "Open" : "Deactivated — open to edit or reactivate"}
              >
                <span className="block font-semibold text-sm leading-tight">{w.name}</span>
                <span className="block text-xs text-muted ltr tabnum">{w.empId}{w.jobTitle ? ` · ${w.jobTitle}` : ""}{w.stamp ? ` · ${w.stamp}` : ""}</span>
                {w.onVacation && <span className="pill pill-warn mt-0.5">until {formatDate(parseISODate(w.vacationUntil!)!)}</span>}
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
    <div className="space-y-4">
      <PageHead
        title="Production Workers"
        sub="The shop-floor people of every section — the shift log and the tank dropdowns"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden /> Add a worker
          </button>
        }
      />

      {/* the head-count per part of the plant — active people; the retired are not counted */}
      <div className="kpi-strip">
        {groups.map((g) => (
          <div key={g.key} className="kpi">
            <div className="kpi-label">{g.label}</div>
            <div className="kpi-value">{activeCount(g.people)}</div>
            <div className="kpi-sub">{g.sections.length} section{g.sections.length === 1 ? "" : "s"}{g.people.length > activeCount(g.people) ? ` · ${g.people.length - activeCount(g.people)} deactivated` : ""}</div>
          </div>
        ))}
        <div className="kpi">
          <div className="kpi-label">On vacation</div>
          <div className={`kpi-value ${away.length ? "text-warn-fg" : ""}`}>{away.length}</div>
          <div className="kpi-sub">absent on the shift log until they are back</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">All workers</div>
          <div className="kpi-value">{activeCount(workers)}</div>
          <div className="kpi-sub">{workers.length - activeCount(workers)} deactivated{unassigned.length ? ` · ${unassigned.length} in no section` : ""}</div>
        </div>
      </div>

      {open && (
        <Modal title="Add a worker" sub="After Add the form clears for the next one." onClose={() => setOpen(false)} busy={add.pending}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              add.run(createWorker, new FormData(form), "Added.", () => form.reset());
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="ID"><input name="empId" required inputMode="numeric" placeholder="Badge number, e.g. 100058" className={`${inputCls} ltr tabnum`} /></Field>
              <Field label="Name"><input name="name" required placeholder="Worker's name" className={inputCls} /></Field>
              <Field label="Job title (optional)"><input name="jobTitle" placeholder="Tank Full Welder" className={inputCls} /></Field>
              <Field label="Welder stamp (optional)" title="The letter this welder punches into every tank he welds">
                <input name="stamp" maxLength={4} placeholder="X" className={`${inputCls} ltr`} />
              </Field>
            </div>
            <DeptChecks defaults={new Set()} disabled={add.pending} />
            <div className="flex items-center justify-end gap-3 pt-3 border-t">
              <Note msg={add.msg} />
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
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Plus}
            title="No workers on the list yet"
            hint="Without them, the shop floor has no ID to enter when recording who welded, tested or painted a tank."
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Add the first worker</button>}
          />
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="flex items-baseline gap-2">
                {g.label}
                <span className="text-xs font-normal normal-case tracking-normal text-muted tabnum">{activeCount(g.people)} people</span>
              </h2>
              <div className="grid gap-3 items-start grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))]">
                {g.sections.map((sec) => (
                  <DeptColumn key={sec.code} title={sec.label} count={activeCount(sec.list)} workers={sec.list} selectedId={selectedId} onPick={setSelectedId} />
                ))}
              </div>
            </section>
          ))}
          <section>
            <h2 className="flex items-baseline gap-2">
              Away
              <span className="text-xs font-normal normal-case tracking-normal text-muted tabnum">{away.length} on vacation</span>
            </h2>
            <div className="grid gap-3 items-start grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))]">
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
