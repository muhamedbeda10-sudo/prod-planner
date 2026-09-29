"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { WORKER_GROUPS } from "@/lib/domain/tanks";
import { CONSUMABLE_LIMITS, NEW_DEPARTMENT, NEW_ITEM, OVER_LIMIT_REASON_MAX, workersForDepartment } from "@/lib/domain/consumables";
import type { CatalogueOption, ConsumableIssueView, ConsumablesPageData, ConsumableWorkerOption } from "@/lib/server/consumables";
import type { LimitHint } from "@/lib/server/consumableLimits";
import { consumableLimitHints, createConsumableIssue, deleteConsumableIssue, updateConsumableIssue } from "@/app/consumables/actions";
import { ActionMsg as Msg, RevisionItem, useConsumableAction as useAction } from "@/components/consumablesUi";
import { Modal } from "@/components/Modal";

// The CONSUMABLES tab: the store's log of what it hands out — to a
// department (the limits count it there), naming who asked for it or
// collected it. "➕ New hand-out" opens the storekeeper's form
// in a popup (consumables.edit); the log below is everyone's to read. A
// saved row is corrected by the person who recorded it or an admin; its
// history, deleting and restoring are the admin's.

const F = "px-2.5 py-2 text-sm font-semibold";
const LABEL = "text-[11px] font-bold text-muted uppercase tracking-wide";
const ITEMS_LIST = "consumable-items";

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

const workerLabel = (w: { empId: string; name: string }) => `${w.empId} — ${w.name}`;

/** The items the dropdown offers for a department: those whose limits cover
 *  it first, then the rest of the catalogue. */
function catalogueFor(catalogue: CatalogueOption[], department: string) {
  const meant = (c: CatalogueOption) => c.departments === "*" || (department !== "" && c.departments.includes(department));
  return { meant: catalogue.filter(meant), rest: catalogue.filter((c) => !meant(c)) };
}

const itemLabel = (c: CatalogueOption) => `${c.name}${c.code ? ` · ${c.code}` : ""}${c.active ? "" : " (retired)"}`;

/**
 * Where the limits of the picked item stand for this department today,
 * asked of the server as the form is filled in — and what the quantity being
 * typed would make of them. For a row being corrected (`issueId`), its own
 * day, the row left out.
 */
function LimitHints({ itemId, department, qty, issueId }: { itemId: string; department: string; qty: number; issueId?: number }) {
  const [hints, setHints] = useState<LimitHint[] | null>(null);
  const ready = /^\d+$/.test(itemId) && department !== "" && department !== NEW_DEPARTMENT;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const t = setTimeout(async () => {
      const fd = new FormData();
      fd.set("itemId", itemId);
      fd.set("department", department);
      fd.set("recipientScope", "department");
      if (issueId) fd.set("id", String(issueId));
      const res = await consumableLimitHints(fd);
      if (live) setHints(res.hints);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [ready, itemId, department, issueId]);
  if (!ready || hints === null) return null;
  if (hints.length === 0) return <p className="text-xs text-muted">No limit on this item for this department.</p>;
  return (
    <ul className="flex flex-wrap gap-2 text-xs">
      {hints.map((h) => {
        const after = Math.round((h.used + (qty > 0 ? qty : 0)) * 1000) / 1000;
        const over = after > h.limit + 1e-9;
        const near = !over && after >= h.limit * 0.8;
        return (
          <li key={h.ruleId} className={`pill ${over ? "pill-bad" : near ? "pill-warn" : "pill-ok"}`} title={h.label}>
            {over ? "⚠ " : ""}{h.label}: <b className="tabnum">{h.used}</b> used{qty > 0 ? <> → <b className="tabnum">{after}</b></> : null} of {h.limit}
          </li>
        );
      })}
    </ul>
  );
}

/** The warning when a hand-out would take a limit over: what it breaks, and
 *  the reason the recorder must give to record it anyway. */
function OverLimitPrompt({ breaches, disabled }: { breaches: string[]; disabled?: boolean }) {
  return (
    <div className="border border-[var(--bad-fg)] rounded-lg p-2 space-y-1.5 bg-[var(--bad-bg)]" role="alert">
      <div className="text-sm font-bold text-bad-fg">⚠ This takes a limit over</div>
      <ul className="text-xs list-disc ms-4">{breaches.map((b) => <li key={b}>{b}</li>)}</ul>
      <Field label="Reason — required to record it anyway" className="w-full">
        <input type="text" name="overLimitReason" required autoFocus disabled={disabled} maxLength={OVER_LIMIT_REASON_MAX} autoComplete="off"
          placeholder="e.g. a second shift ran out, the old one was damaged…" className={`${F} w-full`} />
      </Field>
    </div>
  );
}

/**
 * The hand-out's fields, for a new one and for a correction alike, laid out
 * top to bottom: where (department) and who asked for it / collected it,
 * what (item, qty), notes. The item comes from the catalogue (the
 * department's items first) or is typed when it is not in it; the department
 * is a worker section, one typed before, or a new one; the person is a
 * worker of that section (anyone on the list for a typed department). The
 * hand-out is the department's — the limits count it there.
 */
function IssueFields({
  departments,
  catalogue,
  workers,
  entry,
  disabled,
  department,
  setDepartment,
  receivedBy,
  setReceivedBy,
  itemId,
  setItemId,
  setQty,
  qtyRef,
}: {
  departments: ConsumablesPageData["departments"];
  catalogue: CatalogueOption[];
  workers: ConsumableWorkerOption[];
  entry?: ConsumableIssueView;
  disabled?: boolean;
  department: string;
  setDepartment: (v: string) => void;
  receivedBy: string;
  setReceivedBy: (v: string) => void;
  itemId: string;
  setItemId: (v: string) => void;
  setQty: (v: number) => void;
  qtyRef?: React.Ref<HTMLInputElement>;
}) {
  const items = useMemo(() => catalogueFor(catalogue, department), [catalogue, department]);
  const picked = catalogue.find((c) => String(c.id) === itemId);
  // an older row's department may be one no longer offered — keep it pickable
  const known = department === "" || department === NEW_DEPARTMENT
    || departments.sections.some((s) => s.code === department) || departments.custom.includes(department);
  // the people the department offers; the one an older row names stays
  // pickable (deactivated or moved since) while its department stays
  const offered = useMemo(() => {
    const list = workersForDepartment(workers, department);
    const w = entry?.worker;
    if (w && department === entry.department && !list.some((x) => x.id === w.id)) {
      return [...list, { id: w.id, empId: w.empId, name: `${w.name}${w.active ? "" : " (deactivated)"}`, sections: [] }];
    }
    return list;
  }, [workers, department, entry]);

  function pickDepartment(next: string) {
    setDepartment(next);
    // someone not in the new section cannot stay picked
    if (receivedBy && !workersForDepartment(workers, next).some((w) => String(w.id) === receivedBy)) setReceivedBy("");
  }

  return (
    <div className="grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="recipientScope" value="department" />
      <Field label="Department" className="sm:col-span-3">
        <select name="department" value={department} onChange={(e) => pickDepartment(e.target.value)} required disabled={disabled} className={`${F} w-full`}>
          <option value="" disabled>Pick the department…</option>
          {!known && <option value={department}>{entry?.departmentLabel ?? department}</option>}
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
        <Field label="New department" className="sm:col-span-3">
          <input
            type="text" name="departmentNew" required disabled={disabled} maxLength={CONSUMABLE_LIMITS.department}
            placeholder="e.g. Maintenance" autoComplete="off" autoFocus className={`${F} w-full`}
          />
        </Field>
      )}
      <Field label="Requested / collected by" className={department === NEW_DEPARTMENT ? "sm:col-span-6" : "sm:col-span-3"}>
        <select name="receivedById" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} required disabled={disabled || !department} className={`${F} w-full`}>
          <option value="" disabled>{department ? (offered.length ? "Pick the name…" : "No active worker in this section") : "Pick the department first"}</option>
          {offered.map((w) => <option key={w.id} value={w.id}>{workerLabel(w)}</option>)}
        </select>
      </Field>

      <Field label="Item" className="sm:col-span-4">
        <select name="itemId" value={itemId} onChange={(e) => setItemId(e.target.value)} required disabled={disabled} className={`${F} w-full`}>
          <option value="" disabled>Pick the item…</option>
          {items.meant.length > 0 && (
            <optgroup label={department ? "For this department" : "Items with a limit for every department"}>
              {items.meant.map((c) => <option key={c.id} value={c.id}>{itemLabel(c)}</option>)}
            </optgroup>
          )}
          {items.rest.length > 0 && (
            <optgroup label={items.meant.length > 0 ? "Other items" : "The catalogue"}>
              {items.rest.map((c) => <option key={c.id} value={c.id}>{itemLabel(c)}</option>)}
            </optgroup>
          )}
          <option value={NEW_ITEM}>➕ Not in the catalogue — type it…</option>
        </select>
      </Field>
      <Field label={picked ? `Qty (${picked.uom})` : "Qty"} className="sm:col-span-2">
        <input
          ref={qtyRef} name="qty" type="number" inputMode="decimal" step="0.001" min="0.001" max={CONSUMABLE_LIMITS.qtyMax}
          defaultValue={entry?.qty ?? ""} required disabled={disabled} placeholder="0" className={`${F} ltr tabnum w-full font-extrabold`}
          onInput={(e) => setQty(Number((e.target as HTMLInputElement).value) || 0)}
        />
      </Field>
      {itemId === NEW_ITEM && (
        <Field label="Item name (not in the catalogue — no limit counts it)" className="sm:col-span-6">
          <input
            type="text" name="item" list={ITEMS_LIST} defaultValue={entry && entry.itemId === null ? entry.item : ""} required disabled={disabled}
            maxLength={CONSUMABLE_LIMITS.item} placeholder="e.g. Spare fuse 10A" autoComplete="off" autoFocus className={`${F} w-full`}
          />
        </Field>
      )}

      <Field label="Notes (optional)" className="sm:col-span-6">
        <input type="text" name="notes" defaultValue={entry?.notes ?? ""} disabled={disabled} maxLength={CONSUMABLE_LIMITS.notes} autoComplete="off" className={`${F} w-full`} />
      </Field>
    </div>
  );
}

/** The popup's foot: the message, then the buttons on the right. */
function FormFoot({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-3 mt-1 border-t">{children}</div>;
}

/**
 * Recording a hand-out, in a popup. "Record & next" keeps it open for the
 * next item to the same department (the usual run at the store
 * window); "Record" saves and closes.
 */
function RecordDialog({ data, onClose, onSaved }: { data: ConsumablesPageData; onClose: () => void; onSaved: (text: string) => void }) {
  const add = useAction();
  const [department, setDepartment] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState(0);
  // the breach the server answered with; cleared as soon as the hand-out changes
  const [breaches, setBreaches] = useState<string[] | null>(null);
  const keepOpen = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const [savedCount, setSavedCount] = useState(0);
  // back to the item for the next one — once the save has finished and the
  // fields are enabled again
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0 && !add.pending) formRef.current?.querySelector<HTMLSelectElement>('select[name="itemId"]')?.focus();
  }, [refocus, add.pending]);
  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); setBreaches(null); };

  // after "Record & next" the department stays; the item,
  // qty, notes and any reason clear
  function clearForNext(form: HTMLFormElement) {
    for (const n of ["item", "qty", "notes", "overLimitReason"]) {
      const el = form.elements.namedItem(n);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    setItemId("");
    setQty(0);
    setBreaches(null);
    setRefocus((n) => n + 1);
  }

  return (
    <Modal
      title="➕ New hand-out"
      sub={savedCount > 0 ? `${savedCount} recorded in this window — the department stays for the next.` : "The date and time are stamped when you save."}
      onClose={onClose}
      busy={add.pending}
    >
      <form
        ref={formRef}
        className="space-y-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          const form = ev.currentTarget;
          const stay = keepOpen.current;
          const okText = breaches ? "Saved over the limit — flagged with your reason." : "Saved — the date and time were stamped.";
          add.run(createConsumableIssue, new FormData(form), okText, (res) => {
            if (res.department) setDepartment(res.department);
            if (stay) {
              setSavedCount((n) => n + 1);
              clearForNext(form);
            } else {
              onSaved(okText);
            }
          }, (res) => {
            if (res.needsReason && res.breaches) setBreaches(res.breaches);
            if (res.department) setDepartment(res.department);
          });
        }}
      >
        <IssueFields
          departments={data.departments} catalogue={data.catalogue} disabled={add.pending}
          department={department} setDepartment={changed(setDepartment)} workers={data.workers} receivedBy={receivedBy} setReceivedBy={changed(setReceivedBy)}
          itemId={itemId} setItemId={changed(setItemId)} setQty={changed(setQty)} qtyRef={qtyRef}
        />
        <LimitHints itemId={itemId} department={department} qty={qty} />
        {breaches && <OverLimitPrompt breaches={breaches} disabled={add.pending} />}
        {!breaches && <Msg msg={add.msg} />}
        <FormFoot>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={add.pending}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-secondary" disabled={add.pending} onClick={() => { keepOpen.current = true; }}>
            {breaches ? "Record over the limit & next" : "Record & next"}
          </button>
          <button type="submit" className={`btn btn-sm ${breaches ? "btn-danger border" : "btn-primary"}`} disabled={add.pending} onClick={() => { keepOpen.current = false; }}>
            {add.pending ? "Saving…" : breaches ? "Record over the limit" : "Record"}
          </button>
        </FormFoot>
      </form>
    </Modal>
  );
}

function EditDialog({ e, data, onClose }: { e: ConsumableIssueView; data: ConsumablesPageData; onClose: () => void }) {
  const edit = useAction();
  const [department, setDepartment] = useState(e.department);
  const [receivedBy, setReceivedBy] = useState(e.worker ? String(e.worker.id) : "");
  const [itemId, setItemId] = useState(e.itemId === null ? NEW_ITEM : String(e.itemId));
  const [qty, setQty] = useState(e.qty);
  const [breaches, setBreaches] = useState<string[] | null>(null);
  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); setBreaches(null); };
  return (
    <Modal title="Correct a hand-out" sub={`Recorded ${e.issuedAtLabel} by ${e.recordedBy}. The time stays as recorded; the row as it is now is kept, and the admin can restore it.`} onClose={onClose} busy={edit.pending}>
      <form
        className="space-y-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          const fd = new FormData(ev.currentTarget);
          fd.set("id", String(e.id));
          fd.set("version", e.version);
          edit.run(updateConsumableIssue, fd, "Saved.", onClose, (res) => { if (res.needsReason && res.breaches) setBreaches(res.breaches); });
        }}
      >
        <IssueFields
          departments={data.departments} catalogue={data.catalogue} entry={e} disabled={edit.pending}
          department={department} setDepartment={changed(setDepartment)} workers={data.workers} receivedBy={receivedBy} setReceivedBy={changed(setReceivedBy)}
          itemId={itemId} setItemId={changed(setItemId)} setQty={changed(setQty)}
        />
        <LimitHints itemId={itemId} department={department} qty={qty} issueId={e.id} />
        {breaches && <OverLimitPrompt breaches={breaches} disabled={edit.pending} />}
        {e.overLimit && !breaches && <p className="text-xs text-bad-fg">Recorded over a limit — “{e.overLimit.reason}”. It keeps that reason while it stays over.</p>}
        {!breaches && <Msg msg={edit.msg} />}
        <FormFoot>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={edit.pending}>Cancel</button>
          <button type="submit" className={`btn btn-sm ${breaches ? "btn-danger border" : "btn-primary"}`} disabled={edit.pending}>
            {edit.pending ? "Saving…" : breaches ? "Save over the limit" : "Save"}
          </button>
        </FormFoot>
      </form>
    </Modal>
  );
}

function IssueRow({ e, data, isAdmin, showActions, colSpan }: { e: ConsumableIssueView; data: ConsumablesPageData; isAdmin: boolean; showActions: boolean; colSpan: number }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const del = useAction();
  return (
    <Fragment>
      <tr className="border-t align-top">
        <td className="p-2 ltr tabnum whitespace-nowrap">{e.issuedAtLabel}</td>
        <td className="p-2 font-semibold">
          {e.item}
          {e.overLimit && (
            <span className="pill pill-bad ms-1.5 align-middle" title={`Recorded over the limit — ${e.overLimit.note ?? ""}${e.overLimit.reason ? `\nReason: ${e.overLimit.reason}` : ""}`}>
              ⚠ over limit
            </span>
          )}
          {e.overLimit?.reason && <div className="text-xs text-bad-fg font-normal">“{e.overLimit.reason}”</div>}
        </td>
        <td className="p-2 text-center ltr tabnum font-extrabold whitespace-nowrap">{e.qty}{e.uom && <span className="text-[10px] text-muted font-semibold ms-0.5">{e.uom}</span>}</td>
        <td className="p-2">{e.departmentLabel}</td>
        <td className="p-2">
          {e.worker ? (
            <span className="whitespace-nowrap">
              <code className="ltr tabnum text-xs px-1 py-0.5 rounded bg-surface-2 border mr-1">{e.worker.empId}</code>
              {e.worker.name}
            </span>
          ) : e.group && e.group.workers.length > 0 ? (
            <span className="text-xs max-w-xs inline-block" title={e.group.workers.map(workerLabel).join(" · ")}>{e.group.label}</span>
          ) : (
            <span className="text-xs text-muted" title="Recorded to the department before the name was asked for">—</span>
          )}
        </td>
        <td className="p-2 text-muted">{e.notes ?? ""}</td>
        <td className="p-2 text-xs text-muted whitespace-nowrap">
          {e.recordedBy}
          {e.edited && (isAdmin ? (
            // the history is the admin's: the pill opens it
            <button
              type="button" className="pill pill-warn ml-1 cursor-pointer" aria-expanded={history}
              title={`Last changed by ${e.edited.by} at ${e.edited.atLabel} — click for the history`}
              onClick={() => setHistory((v) => !v)}
            >
              edited{e.revisions.length > 1 ? ` ×${e.revisions.length}` : ""}
            </button>
          ) : (
            <span className="pill pill-warn ml-1" title={`Last changed by ${e.edited.by} at ${e.edited.atLabel}`}>edited</span>
          ))}
        </td>
        {showActions && (
          <td className="p-2 whitespace-nowrap no-print">
            {e.canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} disabled={del.pending}>Edit</button>
            )}
            {isAdmin && (
              <button
                type="button" className="btn btn-sm btn-danger ml-1" disabled={del.pending}
                onClick={() => {
                  if (!confirm(`Delete this hand-out?\n\n${e.qty} × ${e.item} → ${e.departmentLabel}\n\nIt leaves the log; you can restore it from the Edits view.`)) return;
                  const fd = new FormData();
                  fd.set("id", String(e.id));
                  fd.set("version", e.version);
                  del.run(deleteConsumableIssue, fd, "Deleted.");
                }}
              >
                Delete
              </button>
            )}
            <Msg msg={del.msg && !del.msg.ok ? del.msg : null} />
          </td>
        )}
      </tr>
      {isAdmin && history && e.revisions.length > 0 && (
        <tr className="bg-surface-2">
          <td colSpan={colSpan} className="p-2">
            <div className="text-xs font-bold text-muted uppercase tracking-wide mb-1">History — newest first</div>
            <ul className="text-xs">
              {e.revisions.map((r) => <RevisionItem key={r.id} r={r} version={e.version} />)}
            </ul>
          </td>
        </tr>
      )}
      {editing && e.canEdit && <EditDialog e={e} data={data} onClose={() => setEditing(false)} />}
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
      [
        e.item, e.departmentLabel, e.worker?.name ?? "", e.worker?.empId ?? "", e.group?.label ?? "",
        ...(e.group?.workers.flatMap((w) => [w.name, w.empId]) ?? []), e.notes ?? "", e.recordedBy,
      ].some((v) => v.toLowerCase().includes(needle))
    );
  }, [data.entries, q]);
  // the actions column is there for an admin, or for a recorder with a row of his own on screen
  const showActions = isAdmin || data.entries.some((e) => e.canEdit);
  const colSpan = showActions ? 8 : 7;
  const [recording, setRecording] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <datalist id={ITEMS_LIST}>{data.knownItems.map((i) => <option key={i} value={i} />)}</datalist>

      {canRecord && recording && (
        <RecordDialog data={data} onClose={() => setRecording(false)} onSaved={(text) => { setRecording(false); setSaved(text); }} />
      )}

      <div className="flex flex-wrap items-center gap-2 no-print">
        {canRecord && (
          <button type="button" className="btn btn-primary" onClick={() => { setSaved(null); setRecording(true); }}>➕ New hand-out</button>
        )}
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item, department, notes…"
          aria-label="Search the log" className={`${F} w-full sm:w-72`}
        />
        <span className="text-sm text-muted">
          <b className="text-foreground tabnum">{shown.length}</b>
          {shown.length !== data.entries.length && <> of <span className="tabnum">{data.entries.length}</span></>} hand-out{data.entries.length === 1 ? "" : "s"} {periodLabel}
        </span>
        {saved && <span className="text-sm font-semibold text-ok-fg" role="status">✓ {saved}</span>}
      </div>
      {!canRecord && <p className="text-xs text-muted">You can view the log. Recording hand-outs needs the “Consumables — record” permission — ask the admin.</p>}

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
                  <th className="p-2">Requested / collected by</th>
                  <th className="p-2">Notes</th>
                  <th className="p-2">Recorded by</th>
                  {showActions && <th className="p-2 no-print" title="Correct your own rows; deleting is the admin's">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => <IssueRow key={e.id} e={e} data={data} isAdmin={isAdmin} showActions={showActions} colSpan={colSpan} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
