"use client";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useMemo, useRef, useState, useTransition } from "react";
import { WORKER_GROUPS } from "@/lib/domain/tanks";
import { CONSUMABLE_LIMITS, NEW_DEPARTMENT, workersForDepartment } from "@/lib/domain/consumables";
import type { ConsumableIssueView, ConsumablesPageData, ConsumableWorkerOption } from "@/lib/server/consumables";
import { createConsumableIssue, deleteConsumableIssue, updateConsumableIssue } from "@/app/consumables/actions";

// The CONSUMABLES tab: the store's log of what it hands out. The form on top
// is the storekeeper's (consumables.edit); the log below is everyone's to
// read, and only an admin can change or delete a row once it is saved.

type ActionResult = { ok: boolean; error?: string; department?: string };
type ActionFn = (fd: FormData) => Promise<ActionResult>;

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(
    (fn: ActionFn, fd: FormData, okText: string, after?: (res: ActionResult) => void) => {
      startTransition(async () => {
        const res = await fn(fd);
        setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
        if (res.ok) {
          after?.(res);
          router.refresh();
        }
      });
    },
    [router]
  );
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`} role="status">{msg.text}</p>;
}

const F = "px-2 py-1.5 text-sm font-semibold";
const ITEMS_LIST = "consumable-items";

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`inline-flex flex-col gap-0.5 ${className}`}>
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

const workerLabel = (w: { empId: string; name: string }) => `${w.empId} — ${w.name}`;

/**
 * The row's fields, for a new hand-out and for an admin's edit alike. The
 * department and the worker are dropdowns: the department is a worker
 * section, a department typed before, or a new one typed in the box that
 * opens beside it; the worker list narrows to the section picked.
 */
function IssueFields({
  departments,
  workers,
  entry,
  disabled,
  department,
  setDepartment,
  workerId,
  setWorkerId,
  itemRef,
}: {
  departments: ConsumablesPageData["departments"];
  workers: ConsumableWorkerOption[];
  entry?: ConsumableIssueView;
  disabled?: boolean;
  department: string;
  setDepartment: (v: string) => void;
  workerId: string;
  setWorkerId: (v: string) => void;
  itemRef?: React.Ref<HTMLInputElement>;
}) {
  // an old row's worker may since have left the list or the section — the
  // admin's edit still shows him, so the row can be saved as it is
  const offered = useMemo(() => {
    const list = workersForDepartment(workers, department);
    if (entry && String(entry.worker.id) === workerId && !list.some((w) => w.id === entry.worker.id)) {
      return [...list, { id: entry.worker.id, empId: entry.worker.empId, name: `${entry.worker.name}${entry.worker.active ? "" : " (deactivated)"}`, sections: [] }];
    }
    return list;
  }, [workers, department, entry, workerId]);

  function pickDepartment(next: string) {
    setDepartment(next);
    // a worker who is not in the new section cannot stay picked
    if (workerId && !workersForDepartment(workers, next).some((w) => String(w.id) === workerId)) setWorkerId("");
  }

  return (
    <>
      <Field label="Item" className="w-full sm:w-64">
        <input
          ref={itemRef} type="text" name="item" list={ITEMS_LIST} defaultValue={entry?.item ?? ""} required disabled={disabled}
          maxLength={CONSUMABLE_LIMITS.item} placeholder="e.g. Welding wire 1.2 mm" autoComplete="off" className={`${F} w-full`}
        />
      </Field>
      <Field label="Qty" className="w-24">
        <input
          name="qty" type="number" inputMode="decimal" step="0.001" min="0.001" max={CONSUMABLE_LIMITS.qtyMax}
          defaultValue={entry?.qty ?? ""} required disabled={disabled} placeholder="0" className={`${F} ltr tabnum w-full font-extrabold`}
        />
      </Field>
      <Field label="Department" className="w-full sm:w-56">
        <select name="department" value={department} onChange={(e) => pickDepartment(e.target.value)} required disabled={disabled} className={`${F} w-full`}>
          <option value="" disabled>Pick the department…</option>
          {WORKER_GROUPS.map((g) => (
            <optgroup key={g.key} label={g.label}>
              {departments.sections.filter((s) => s.group === g.key).map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </optgroup>
          ))}
          {departments.custom.length > 0 && (
            <optgroup label="Other departments">
              {departments.custom.map((d) => <option key={d} value={d}>{d}</option>)}
            </optgroup>
          )}
          <option value={NEW_DEPARTMENT}>➕ New department…</option>
        </select>
      </Field>
      {department === NEW_DEPARTMENT && (
        <Field label="New department" className="w-full sm:w-48">
          <input
            type="text" name="departmentNew" required disabled={disabled} maxLength={CONSUMABLE_LIMITS.department}
            placeholder="e.g. Maintenance" autoComplete="off" autoFocus className={`${F} w-full`}
          />
        </Field>
      )}
      <Field label="Technician / worker" className="w-full sm:w-64">
        <select name="workerId" value={workerId} onChange={(e) => setWorkerId(e.target.value)} required disabled={disabled || !department} className={`${F} w-full`}>
          <option value="" disabled>{department ? (offered.length ? "Pick the name…" : "No active worker in this section") : "Pick the department first"}</option>
          {offered.map((w) => <option key={w.id} value={w.id}>{workerLabel(w)}</option>)}
        </select>
      </Field>
      <Field label="Notes (optional)" className="w-full sm:flex-1 sm:min-w-[12rem]">
        <input type="text" name="notes" defaultValue={entry?.notes ?? ""} disabled={disabled} maxLength={CONSUMABLE_LIMITS.notes} autoComplete="off" className={`${F} w-full`} />
      </Field>
    </>
  );
}

function RecordForm({ data }: { data: ConsumablesPageData }) {
  const add = useAction();
  const [department, setDepartment] = useState("");
  const [workerId, setWorkerId] = useState("");
  const itemRef = useRef<HTMLInputElement>(null);

  // after a save the next hand-out is usually to the same man: department and
  // worker stay, the item, qty and notes clear
  function clearForNext(form: HTMLFormElement) {
    for (const n of ["item", "qty", "notes"]) {
      const el = form.elements.namedItem(n);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    itemRef.current?.focus();
  }

  return (
    <form
      className="bg-surface border rounded-xl p-3 space-y-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        const form = ev.currentTarget;
        add.run(createConsumableIssue, new FormData(form), "Saved — the date and time were stamped.", (res) => {
          clearForNext(form);
          // a department typed new is in the dropdown after the refresh, under
          // the name it was stored with
          if (res.department) setDepartment(res.department);
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <IssueFields
          departments={data.departments} workers={data.workers} disabled={add.pending}
          department={department} setDepartment={setDepartment} workerId={workerId} setWorkerId={setWorkerId} itemRef={itemRef}
        />
        <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={add.pending}>
          {add.pending ? "Saving…" : "Record"}
        </button>
      </div>
      <p className="text-xs text-muted">The date and time are stamped when you save. A saved row can only be changed by an admin.</p>
      <Msg msg={add.msg} />
    </form>
  );
}

function EditRow({ e, data, colSpan, onClose }: { e: ConsumableIssueView; data: ConsumablesPageData; colSpan: number; onClose: () => void }) {
  const edit = useAction();
  const [department, setDepartment] = useState(e.department);
  const [workerId, setWorkerId] = useState(String(e.worker.id));
  return (
    <tr className="bg-surface-2">
      <td colSpan={colSpan} className="p-2">
        <form
          className="space-y-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            const fd = new FormData(ev.currentTarget);
            fd.set("id", String(e.id));
            fd.set("version", e.version);
            edit.run(updateConsumableIssue, fd, "Saved.", onClose);
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <IssueFields
              departments={data.departments} workers={data.workers} entry={e} disabled={edit.pending}
              department={department} setDepartment={setDepartment} workerId={workerId} setWorkerId={setWorkerId}
            />
            <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={edit.pending}>Save</button>
            <button type="button" className="btn btn-sm btn-ghost shrink-0" onClick={onClose} disabled={edit.pending}>Cancel</button>
          </div>
          <p className="text-xs text-muted">Recorded {e.issuedAtLabel} by {e.recordedBy}. The time stays as recorded; the row as it is now is kept in its history.</p>
          <Msg msg={edit.msg} />
        </form>
      </td>
    </tr>
  );
}

function IssueRow({ e, data, isAdmin, colSpan }: { e: ConsumableIssueView; data: ConsumablesPageData; isAdmin: boolean; colSpan: number }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const del = useAction();
  return (
    <Fragment>
      <tr className="border-t align-top">
        <td className="p-2 ltr tabnum whitespace-nowrap">{e.issuedAtLabel}</td>
        <td className="p-2 font-semibold">{e.item}</td>
        <td className="p-2 text-center ltr tabnum font-extrabold">{e.qty}</td>
        <td className="p-2">{e.departmentLabel}</td>
        <td className="p-2 whitespace-nowrap">
          <code className="ltr tabnum text-xs px-1 py-0.5 rounded bg-surface-2 border mr-1">{e.worker.empId}</code>
          {e.worker.name}
        </td>
        <td className="p-2 text-muted">{e.notes ?? ""}</td>
        <td className="p-2 text-xs text-muted whitespace-nowrap">
          {e.recordedBy}
          {e.edited && (
            <button
              type="button" className="pill pill-warn ml-1 cursor-pointer" aria-expanded={history}
              title={`Edited by ${e.edited.by} at ${e.edited.atLabel} — click for the history`}
              onClick={() => setHistory((v) => !v)}
            >
              edited
            </button>
          )}
        </td>
        {isAdmin && (
          <td className="p-2 whitespace-nowrap no-print">
            <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)} disabled={del.pending}>
              {editing ? "Close" : "Edit"}
            </button>
            <button
              type="button" className="btn btn-sm btn-danger ml-1" disabled={del.pending}
              onClick={() => {
                if (!confirm(`Delete this hand-out?\n\n${e.qty} × ${e.item} → ${e.worker.name}\n\nIt leaves the log; its history is kept.`)) return;
                const fd = new FormData();
                fd.set("id", String(e.id));
                fd.set("version", e.version);
                del.run(deleteConsumableIssue, fd, "Deleted.");
              }}
            >
              Delete
            </button>
            <Msg msg={del.msg && !del.msg.ok ? del.msg : null} />
          </td>
        )}
      </tr>
      {history && e.revisions.length > 0 && (
        <tr className="bg-surface-2">
          <td colSpan={colSpan} className="p-2">
            <ul className="text-xs space-y-0.5">
              {e.revisions.map((r) => (
                <li key={r.id}>
                  <span className="ltr tabnum text-muted">{r.atLabel}</span> — <b>{r.by}</b> {r.action === "delete" ? "deleted" : "edited"} the row. It read: <span className="font-semibold">{r.before}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
      {editing && isAdmin && <EditRow e={e} data={data} colSpan={colSpan} onClose={() => setEditing(false)} />}
    </Fragment>
  );
}

export function ConsumablesClient({
  data,
  canRecord,
  isAdmin,
  periodLabel,
}: {
  data: ConsumablesPageData;
  canRecord: boolean;
  isAdmin: boolean;
  periodLabel: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return data.entries;
    return data.entries.filter((e) =>
      [e.item, e.departmentLabel, e.worker.name, e.worker.empId, e.notes ?? "", e.recordedBy].some((v) => v.toLowerCase().includes(needle))
    );
  }, [data.entries, q]);
  const colSpan = isAdmin ? 8 : 7;

  return (
    <div className="space-y-3">
      <datalist id={ITEMS_LIST}>{data.knownItems.map((i) => <option key={i} value={i} />)}</datalist>

      {canRecord ? (
        <RecordForm data={data} />
      ) : (
        <p className="text-xs text-muted">You can view the log. Recording hand-outs needs the “Consumables — record” permission — ask the admin.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 no-print">
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item, worker, department…"
          aria-label="Search the log" className={`${F} w-full sm:w-72`}
        />
        <span className="text-sm text-muted">
          <b className="text-foreground tabnum">{shown.length}</b>
          {shown.length !== data.entries.length && <> of <span className="tabnum">{data.entries.length}</span></>} hand-out{data.entries.length === 1 ? "" : "s"} {periodLabel}
        </span>
      </div>

      <section className="bg-surface border rounded-xl overflow-hidden">
        {data.entries.length === 0 ? (
          <p className="text-sm text-muted p-4">Nothing handed out {periodLabel}.</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted p-4">No hand-out {periodLabel} matches “{q}”.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-left">
                  <th className="p-2">Date &amp; time</th>
                  <th className="p-2">Item</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2">Department</th>
                  <th className="p-2">Technician / worker</th>
                  <th className="p-2">Notes</th>
                  <th className="p-2">Recorded by</th>
                  {isAdmin && <th className="p-2 no-print" title="Only an admin changes a saved row">Admin</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => <IssueRow key={e.id} e={e} data={data} isAdmin={isAdmin} colSpan={colSpan} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
