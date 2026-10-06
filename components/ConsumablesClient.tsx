"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { WORKER_GROUPS } from "@/lib/domain/tanks";
import { CONSUMABLE_LIMITS, NEW_DEPARTMENT, OVER_LIMIT_REASON_MAX, matchCatalogueItem, workersForDepartment } from "@/lib/domain/consumables";
import type { CatalogueOption, ConsumableIssueView, ConsumablesPageData, ConsumableWorkerOption } from "@/lib/server/consumables";
import type { LimitHint } from "@/lib/server/consumableLimits";
import { consumableLimitHints, createConsumableIssue, deleteConsumableIssue, updateConsumableIssue } from "@/app/consumables/actions";
import { ActionMsg as Msg, RevisionItem, useConsumableAction as useAction } from "@/components/consumablesUi";
import { Modal } from "@/components/Modal";
import { TableEmpty, TableFrame, Th, useConfirm, useRowMenu } from "@/components/DataTable";
import { SearchBox } from "@/components/FilterControls";

// The CONSUMABLES tab: the store's log of what it hands out — to a
// department (the limits count it there), naming who asked for it or
// collected it. The storekeeper records on one line above the log
// (consumables.edit); the log is everyone's to read. A saved row is
// corrected, in a popup, by the person who recorded it or an admin; its
// history, deleting and restoring are the admin's.

const F = "px-2.5 py-2 text-sm font-semibold";
const LABEL = "text-[11px] font-bold text-muted uppercase tracking-wide";
const ITEMS_LIST = "consumable-item-options";

/** The catalogue item the Item box names — typed or pasted, by name or code.
 *  A new hand-out links only an active item; a correction may keep its own
 *  retired one. */
function catalogueMatch(catalogue: CatalogueOption[], text: string, keepId: number | null = null): CatalogueOption | null {
  return matchCatalogueItem(text, catalogue.filter((c) => c.active || c.id === keepId));
}

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
  knownItems,
  itemText,
  setItemText,
  matched,
  setQty,
  qtyRef,
  row = false,
  trailing,
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
  /** Items typed on earlier rows — suggested after the catalogue. */
  knownItems: string[];
  itemText: string;
  setItemText: (v: string) => void;
  /** The catalogue item the text names, if any. */
  matched: CatalogueOption | null;
  setQty: (v: number) => void;
  qtyRef?: React.Ref<HTMLInputElement>;
  /** One line across the page (the record form above the log), rather than
   *  stacked (the correction popup). */
  row?: boolean;
  /** The row's last cell — its button. */
  trailing?: React.ReactNode;
}) {
  // the stacked layout's column spans; the row lays its cells out in order
  const span = (stacked: string) => (row ? "" : stacked);
  const items = useMemo(() => catalogueFor(catalogue, department), [catalogue, department]);
  const picked = matched;
  // the suggestions: this department's catalogue items, the rest of the
  // catalogue, then items typed before that are not in it
  const suggestions = useMemo(() => {
    const names = [...items.meant, ...items.rest].filter((c) => c.active).map((c) => c.name);
    const inCat = new Set(names.map((n) => n.toLowerCase()));
    return [...names, ...knownItems.filter((k) => !inCat.has(k.toLowerCase()))];
  }, [items, knownItems]);
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

  // what the Item box names: a catalogue item, or an item as typed
  const matchLine = itemText.trim() !== "" && (
    <p className={`${row ? "col-span-full" : "sm:col-span-6 -mt-1"} text-xs ${matched ? "text-ok-fg" : "text-muted"}`} aria-live="polite">
      {matched
        ? <>✓ In the catalogue: <b>{matched.name}</b>{matched.code ? <> · <span className="ltr">{matched.code}</span></> : null} · {matched.uom}{matched.active ? "" : " (retired)"}</>
        : "Not in the catalogue — recorded as typed, and no limit counts it."}
    </p>
  );

  return (
    <div className={row
      ? "grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(9rem,12rem)_minmax(10rem,15rem)_minmax(12rem,1fr)_6.5rem_minmax(8rem,14rem)_auto] lg:items-end"
      : "grid gap-3 sm:grid-cols-6"}>
      <input type="hidden" name="recipientScope" value="department" />
      <Field label="Department" className={span("sm:col-span-3")}>
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
        <Field label="New department" className={row ? "sm:col-span-2 lg:col-span-full lg:order-last" : "sm:col-span-3"}>
          <input
            type="text" name="departmentNew" required disabled={disabled} maxLength={CONSUMABLE_LIMITS.department}
            placeholder="e.g. Maintenance" autoComplete="off" autoFocus className={`${F} w-full`}
          />
        </Field>
      )}
      <Field label="Requested / collected by" className={span(department === NEW_DEPARTMENT ? "sm:col-span-6" : "sm:col-span-3")}>
        <select name="receivedById" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} required disabled={disabled || !department} className={`${F} w-full`}>
          <option value="" disabled>{department ? (offered.length ? "Pick the name…" : "No active worker in this section") : "Pick the department first"}</option>
          {offered.map((w) => <option key={w.id} value={w.id}>{workerLabel(w)}</option>)}
        </select>
      </Field>

      <Field label="Item — type or paste" className={span("sm:col-span-4")}>
        <input
          type="text" name="item" list={ITEMS_LIST} value={itemText} onChange={(e) => setItemText(e.target.value)} required disabled={disabled}
          maxLength={CONSUMABLE_LIMITS.item} placeholder="Paste the item, or type and pick a suggestion" autoComplete="off" className={`${F} w-full`}
        />
        <datalist id={ITEMS_LIST}>{suggestions.map((n) => <option key={n} value={n} />)}</datalist>
      </Field>
      <Field label="Qty" className={span("sm:col-span-2")}>
        {/* the box starts empty — a "0" would read as typed — and the item's
            unit sits right beside the number */}
        <span className="flex items-stretch">
          <input
            ref={qtyRef} name="qty" type="number" inputMode="decimal" step="0.001" min="0.001" max={CONSUMABLE_LIMITS.qtyMax}
            defaultValue={entry?.qty ?? ""} required disabled={disabled} aria-label={picked ? `Qty in ${picked.uom}` : "Qty"}
            className={`${F} ltr tabnum w-full min-w-0 font-extrabold !rounded-e-none`}
            onInput={(e) => setQty(Number((e.target as HTMLInputElement).value) || 0)}
          />
          <span className="inline-flex items-center px-2 text-xs font-semibold text-muted bg-surface-2 border border-s-0 border-[var(--border-strong)] rounded-e-[var(--r-sm)] whitespace-nowrap" title={picked ? "The catalogue item's unit" : "Pick a catalogue item to see its unit"}>
            {picked?.uom || "unit"}
          </span>
        </span>
      </Field>
      {!row && matchLine}

      <Field label="Notes (optional)" className={span("sm:col-span-6")}>
        <input type="text" name="notes" defaultValue={entry?.notes ?? ""} disabled={disabled} maxLength={CONSUMABLE_LIMITS.notes} autoComplete="off" className={`${F} w-full`} />
      </Field>
      {trailing && <div className={row ? "sm:col-span-2 lg:col-span-1 flex items-end" : "sm:col-span-6"}>{trailing}</div>}
      {row && matchLine}
    </div>
  );
}

/** The popup's foot: the message, then the buttons on the right. */
function FormFoot({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-3 mt-1 border-t">{children}</div>;
}

/**
 * Recording a hand-out: one line above the log — department, who asked for
 * it, the item (typed or pasted), qty, notes, Record. After a save the
 * department and the person stay and the item box is ready for the next
 * paste (the usual run at the store window).
 */
function RecordRow({ data }: { data: ConsumablesPageData }) {
  const add = useAction();
  const [department, setDepartment] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  const [itemText, setItemText] = useState("");
  const matched = useMemo(() => catalogueMatch(data.catalogue, itemText), [data.catalogue, itemText]);
  const itemId = matched ? String(matched.id) : "";
  const [qty, setQty] = useState(0);
  // the breach the server answered with; cleared as soon as the hand-out changes
  const [breaches, setBreaches] = useState<string[] | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // back to the item for the next one — once the save has finished and the
  // fields are enabled again
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0 && !add.pending) formRef.current?.querySelector<HTMLInputElement>('input[name="item"]')?.focus();
  }, [refocus, add.pending]);
  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); setBreaches(null); };

  // after a save the department and the person stay; the item, qty, notes
  // and any reason clear
  function clearForNext(form: HTMLFormElement) {
    for (const n of ["qty", "notes", "overLimitReason"]) {
      const el = form.elements.namedItem(n);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    setItemText("");
    setQty(0);
    setBreaches(null);
    setRefocus((n) => n + 1);
  }

  return (
    <form
      ref={formRef}
      className="bg-surface border rounded-xl p-3 space-y-2 no-print"
      onSubmit={(ev) => {
        ev.preventDefault();
        const form = ev.currentTarget;
        const okText = breaches ? "Saved over the limit — flagged with your reason." : "Saved — the date and time were stamped.";
        add.run(createConsumableIssue, new FormData(form), okText, (res) => {
          if (res.department) setDepartment(res.department);
          clearForNext(form);
        }, (res) => {
          if (res.needsReason && res.breaches) setBreaches(res.breaches);
          if (res.department) setDepartment(res.department);
        });
      }}
    >
      <IssueFields
        row
        departments={data.departments} catalogue={data.catalogue} disabled={add.pending}
        department={department} setDepartment={changed(setDepartment)} workers={data.workers} receivedBy={receivedBy} setReceivedBy={changed(setReceivedBy)}
        knownItems={data.knownItems} itemText={itemText} setItemText={changed(setItemText)} matched={matched} setQty={changed(setQty)}
        trailing={
          <button type="submit" className={`btn w-full lg:w-auto whitespace-nowrap ${breaches ? "btn-danger border" : "btn-primary"}`} disabled={add.pending}>
            {add.pending ? "Saving…" : breaches ? "Record over the limit" : "➕ Record"}
          </button>
        }
      />
      <LimitHints itemId={itemId} department={department} qty={qty} />
      {breaches && <OverLimitPrompt breaches={breaches} disabled={add.pending} />}
      {!breaches && <Msg msg={add.msg} />}
    </form>
  );
}

function EditDialog({ e, data, onClose }: { e: ConsumableIssueView; data: ConsumablesPageData; onClose: () => void }) {
  const edit = useAction();
  const [department, setDepartment] = useState(e.department);
  const [receivedBy, setReceivedBy] = useState(e.worker ? String(e.worker.id) : "");
  const [itemText, setItemText] = useState(e.item);
  const matched = useMemo(() => catalogueMatch(data.catalogue, itemText, e.itemId), [data.catalogue, itemText, e.itemId]);
  const itemId = matched ? String(matched.id) : "";
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
          knownItems={data.knownItems} itemText={itemText} setItemText={changed(setItemText)} matched={matched} setQty={changed(setQty)}
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
  const [confirmDelete, confirmDialog] = useConfirm();
  const what = `${e.qty}${e.uom ? ` ${e.uom}` : ""} × ${e.item} → ${e.departmentLabel}`;
  const row = useRowMenu(() => [
    { heading: `${e.issuedAtLabel} · ${e.item}` },
    ...(e.canEdit ? [{ key: "edit", label: "Edit hand-out…", icon: "✏️", onSelect: () => setEditing(true), disabled: del.pending }] : []),
    ...(isAdmin && e.edited ? [{ key: "history", label: history ? "Hide the history" : "Show the history", icon: "🕘", onSelect: () => setHistory((v) => !v) }] : []),
    ...(isAdmin ? [
      { sep: true } as const,
      {
        key: "delete", label: "Delete hand-out…", icon: "🗑", danger: true, disabled: del.pending,
        onSelect: async () => {
          const ok = await confirmDelete({
            title: "Delete this hand-out?",
            body: <>It leaves the log; you can restore it from the Edits view.</>,
            items: [`${e.issuedAtLabel} · ${what}`],
            confirmLabel: "Delete hand-out",
            danger: true,
          });
          if (!ok) return;
          const fd = new FormData();
          fd.set("id", String(e.id));
          fd.set("version", e.version);
          del.run(deleteConsumableIssue, fd, "Deleted.");
        },
      },
    ] : []),
  ], `Actions for ${e.item} (${e.issuedAtLabel})`);
  const hasMenu = e.canEdit || isAdmin;
  return (
    <Fragment>
      <tr className="border-t align-top" onContextMenu={hasMenu ? row.onContextMenu : undefined}>
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
        <td className="p-2 text-right ltr tabnum font-extrabold whitespace-nowrap">{e.qty}{e.uom && <span className="text-[10px] text-muted font-semibold ms-0.5">{e.uom}</span>}</td>
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
          <td className="p-2 whitespace-nowrap no-print text-center">
            {hasMenu && <>{row.button}{row.menu}{confirmDialog}</>}
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

  return (
    <div className="space-y-3">

      {canRecord && <RecordRow data={data} />}

      <div className="toolbar toolbar-row no-print !mb-0">
        <SearchBox value={q} onChange={setQ} placeholder="Search item, department, notes…" wide />
        <span className="ms-auto text-sm text-muted">
          <b className="text-foreground tabnum">{shown.length}</b>
          {shown.length !== data.entries.length && <> of <span className="tabnum">{data.entries.length}</span></>} hand-out{data.entries.length === 1 ? "" : "s"} {periodLabel}
        </span>
      </div>
      {!canRecord && <p className="text-xs text-muted">You can view the log. Recording hand-outs needs the “Consumables — record” permission — ask the admin.</p>}

      <section className="bg-surface border rounded-xl overflow-hidden">
        {data.entries.length === 0 ? (
          <TableEmpty title={`Nothing handed out ${periodLabel}`} hint={canRecord ? "Record a hand-out above — it shows here at once." : undefined} />
        ) : shown.length === 0 ? (
          <TableEmpty
            title={`No hand-out ${periodLabel} matches “${q}”`}
            action={<button type="button" className="btn btn-sm btn-secondary" onClick={() => setQ("")}>Clear the search</button>}
            filtered
          />
        ) : (
          // the log takes the rest of the screen and scrolls inside it, header pinned
          <TableFrame className="!max-h-[calc(100vh-17rem)] min-h-[16rem]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left">
                  <Th label="Date & time" />
                  <Th label="Item" />
                  <Th label="Qty" num />
                  <Th label="Department" />
                  <Th label="Collected by" full="Requested / collected by" />
                  <Th label="Notes" />
                  <Th label="Recorded by" />
                  {showActions && <Th label="Actions" hint="Correct your own rows; deleting is the admin's" className="no-print" center />}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => <IssueRow key={e.id} e={e} data={data} isAdmin={isAdmin} showActions={showActions} colSpan={colSpan} />)}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>
    </div>
  );
}
