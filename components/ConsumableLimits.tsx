"use client";

import { Fragment, useMemo, useState } from "react";
import { WORKER_GROUPS } from "@/lib/domain/tanks";
import { ALL_DEPARTMENTS, LIMIT_PERIODS, PERIOD_LABEL, PERIOD_NOUN, type LimitBasis, type LimitPeriod } from "@/lib/domain/consumableLimits";
import type { CatalogueChangeView, CatalogueItemDTO, LimitDTO } from "@/lib/server/consumableLimits";
import { deleteConsumableLimit, saveCatalogueItem, saveConsumableLimit } from "@/app/consumables/catalogueActions";
import { ActionMsg as Msg, useConsumableAction as useAction } from "@/components/consumablesUi";

// The CONSUMABLES tab's Limits view: the store's catalogue — code, name, unit
// — each item with its limits and where each stands right now in its own
// period. Whoever records hand-outs (consumables.edit) adds items, changes
// them, retires them, and adds, changes or removes their limits in place;
// every change is kept (the list at the foot of the page).

type Standing = { used: number; limit: number; windowLabel: string; overWorkers: number };
type Departments = { sections: { code: string; label: string; group: string }[]; custom: string[] };

const F = "px-2 py-1.5 text-sm font-semibold";
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 3 }));

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`inline-flex flex-col gap-0.5 ${className}`}>
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

/** Used against the limit in the current window: a bar, green → amber at
 *  80% → red past the limit. */
function UsageBar({ s, basis }: { s: Standing | undefined; basis: LimitBasis }) {
  if (!s) return null;
  const ratio = s.limit > 0 ? s.used / s.limit : 0;
  const tone = ratio > 1 + 1e-9 ? "var(--bad-fg)" : ratio >= 0.8 ? "var(--warn-fg)" : "var(--ok-fg)";
  return (
    <div className="min-w-[9rem]" title={`${basis === "person" ? "The worker who took the most" : "Handed out"} ${s.windowLabel}: ${fmt(s.used)} of ${fmt(s.limit)}`}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted">{s.windowLabel}</span>
        <span className="tabnum font-bold" style={{ color: ratio > 1 ? "var(--bad-fg)" : undefined }}>{fmt(s.used)} / {fmt(s.limit)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-0.5">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: tone }} />
      </div>
      {basis === "person" && s.overWorkers > 0 && <div className="text-[11px] text-bad-fg font-semibold">{s.overWorkers} worker(s) over</div>}
    </div>
  );
}

function ItemForm({ item, onDone }: { item?: CatalogueItemDTO; onDone: () => void }) {
  const save = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.currentTarget);
        if (item) fd.set("id", String(item.id));
        save.run(saveCatalogueItem, fd, item ? "Saved." : "Added to the catalogue.", onDone);
      }}
    >
      <Field label="Code" className="w-44"><input type="text" name="code" defaultValue={item?.code ?? ""} maxLength={60} placeholder="C-CON-…" className={`${F} ltr w-full`} disabled={save.pending} /></Field>
      <Field label="Name" className="w-full sm:w-72"><input type="text" name="name" defaultValue={item?.name ?? ""} maxLength={120} required className={`${F} w-full`} disabled={save.pending} autoFocus /></Field>
      <Field label="Unit" className="w-20"><input type="text" name="uom" defaultValue={item?.uom ?? "PC"} maxLength={12} className={`${F} w-full`} disabled={save.pending} /></Field>
      <Field label="Remark" className="w-full sm:w-56"><input type="text" name="remark" defaultValue={item?.remark ?? ""} maxLength={200} className={`${F} w-full`} disabled={save.pending} /></Field>
      {item && (
        <Field label="In use" className="w-32">
          <select name="active" defaultValue={item.active ? "true" : "false"} className={`${F} w-full`} disabled={save.pending}>
            <option value="true">Active</option>
            <option value="false">Retired</option>
          </select>
        </Field>
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending}>{item ? "Save" : "Add item"}</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onDone} disabled={save.pending}>Cancel</button>
      <div className="w-full"><Msg msg={save.msg} /></div>
    </form>
  );
}

function LimitForm({ itemId, limit, departments, onDone }: { itemId: number; limit?: LimitDTO; departments: Departments; onDone: () => void }) {
  const save = useAction();
  const del = useAction();
  const [all, setAll] = useState(limit?.departments === ALL_DEPARTMENTS);
  const picked = new Set(limit && limit.departments !== ALL_DEPARTMENTS ? limit.departments : []);
  const busy = save.pending || del.pending;
  return (
    <form
      className="space-y-2 border rounded-lg p-2 bg-surface"
      onSubmit={(ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.currentTarget);
        fd.set("itemId", String(itemId));
        if (limit) fd.set("id", String(limit.id));
        fd.set("allDepartments", all ? "true" : "false");
        save.run(saveConsumableLimit, fd, limit ? "Saved." : "Limit added.", onDone);
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Quantity" className="w-24">
          <input type="number" name="qty" inputMode="decimal" step="0.001" min="0.001" required defaultValue={limit?.qty ?? ""} className={`${F} ltr tabnum w-full`} disabled={busy} />
        </Field>
        <Field label="Per" className="w-32">
          <select name="period" defaultValue={limit?.period ?? "week"} className={`${F} w-full`} disabled={busy}>
            {LIMIT_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p as LimitPeriod]}</option>)}
          </select>
        </Field>
        <Field label="Counted" className="w-56">
          <select name="basis" defaultValue={limit?.basis ?? "pool"} className={`${F} w-full`} disabled={busy}>
            <option value="pool">Shared by the departments picked</option>
            <option value="person">For each worker</option>
          </select>
        </Field>
      </div>
      <div className="space-y-1">
        <label className="inline-flex items-center gap-1.5 text-sm font-bold cursor-pointer">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} disabled={busy} className="accent-[var(--brand,#1b7a43)]" />
          All departments
        </label>
        {!all && (
          <div className="space-y-1">
            {WORKER_GROUPS.map((g) => (
              <div key={g.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[11px] font-bold text-muted uppercase tracking-wide w-24">{g.label}</span>
                {departments.sections.filter((s) => s.group === g.key).map((s) => (
                  <label key={s.code} className="inline-flex items-center gap-1 text-sm cursor-pointer">
                    <input type="checkbox" name="departments" value={s.code} defaultChecked={picked.has(s.code)} disabled={busy} className="accent-[var(--brand,#1b7a43)]" />
                    {s.label}
                  </label>
                ))}
              </div>
            ))}
            {departments.custom.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[11px] font-bold text-muted uppercase tracking-wide w-24">Other</span>
                {departments.custom.map((d) => (
                  <label key={d} className="inline-flex items-center gap-1 text-sm cursor-pointer">
                    <input type="checkbox" name="departments" value={d} defaultChecked={picked.has(d)} disabled={busy} className="accent-[var(--brand,#1b7a43)]" />
                    {d}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] text-muted">Several departments on one limit share the number. To give each its own, add a limit per department.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{limit ? "Save limit" : "Add limit"}</button>
        {limit && (
          <button
            type="button" className="btn btn-sm btn-danger" disabled={busy}
            onClick={() => {
              if (!confirm(`Remove this limit (${limit.qty} ${PERIOD_LABEL[limit.period]} · ${limit.departmentsLabel})?`)) return;
              const fd = new FormData();
              fd.set("id", String(limit.id));
              del.run(deleteConsumableLimit, fd, "Removed.", onDone);
            }}
          >
            Remove
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone} disabled={busy}>Cancel</button>
      </div>
      <Msg msg={save.msg ?? del.msg} />
    </form>
  );
}

function ItemRow({ item, standings, departments, canEdit }: { item: CatalogueItemDTO; standings: Record<number, Standing>; departments: Departments; canEdit: boolean }) {
  const [editing, setEditing] = useState<"item" | "new-limit" | number | null>(null);
  const close = () => setEditing(null);
  const worst = Math.max(0, ...item.limits.map((l) => { const s = standings[l.id]; return s && s.limit > 0 ? s.used / s.limit : 0; }));
  return (
    <Fragment>
      <tr className={`border-t align-top ${item.active ? "" : "opacity-60"}`}>
        <td className="p-2">
          <div className="font-semibold">
            {item.name}
            {!item.active && <span className="pill pill-muted ms-1.5">retired</span>}
            {worst > 1 + 1e-9 && <span className="pill pill-bad ms-1.5">⚠ over</span>}
          </div>
          <div className="text-xs text-muted ltr">{item.code ?? "no code"}{item.remark ? <span className="ms-2 not-italic">· {item.remark}</span> : null}</div>
        </td>
        <td className="p-2 text-xs font-bold">{item.uom}</td>
        <td className="p-2">
          {item.limits.length === 0 ? <span className="text-xs text-muted">No limit</span> : (
            <ul className="space-y-2">
              {item.limits.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="min-w-[14rem]">
                    <span className="tabnum font-extrabold">{fmt(l.qty)}</span> <span className="text-muted text-xs">{item.uom} {PERIOD_LABEL[l.period]}</span>
                    {l.basis === "person" && <span className="pill pill-muted ms-1">per person</span>}
                    <div className="text-xs">{l.departmentsLabel}</div>
                  </div>
                  <UsageBar s={standings[l.id]} basis={l.basis} />
                  {canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(editing === l.id ? null : l.id)}>{editing === l.id ? "Close" : "Edit"}</button>}
                </li>
              ))}
            </ul>
          )}
        </td>
        {canEdit && (
          <td className="p-2 whitespace-nowrap">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(editing === "item" ? null : "item")}>{editing === "item" ? "Close" : "Edit item"}</button>
            <button type="button" className="btn btn-sm ms-1" onClick={() => setEditing(editing === "new-limit" ? null : "new-limit")}>+ Limit</button>
          </td>
        )}
      </tr>
      {editing !== null && canEdit && (
        <tr className="bg-surface-2">
          <td colSpan={4} className="p-2">
            {editing === "item" ? <ItemForm item={item} onDone={close} />
              : editing === "new-limit" ? <LimitForm itemId={item.id} departments={departments} onDone={close} />
              : <LimitForm itemId={item.id} limit={item.limits.find((l) => l.id === editing)} departments={departments} onDone={close} />}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function ConsumableLimits({
  items,
  standings,
  departments,
  changes,
  canEdit,
}: {
  items: CatalogueItemDTO[];
  standings: Record<number, Standing>;
  departments: Departments;
  changes: CatalogueChangeView[];
  canEdit: boolean;
}) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [adding, setAdding] = useState(false);
  const [onlyAlarms, setOnlyAlarms] = useState(false);

  // the items with a limit over right now (per-person: any worker over)
  const overIds = useMemo(
    () => new Set(items.filter((i) => i.limits.some((l) => { const s = standings[l.id]; return !!s && (s.used > s.limit + 1e-9 || s.overWorkers > 0); })).map((i) => i.id)),
    [items, standings]
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) =>
      (!needle || [i.name, i.code ?? "", i.remark ?? ""].some((v) => v.toLowerCase().includes(needle)))
      && (!dept || i.limits.some((l) => l.departments === ALL_DEPARTMENTS || l.departments.includes(dept)))
      && (!onlyAlarms || overIds.has(i.id))
    );
  }, [items, q, dept, onlyAlarms, overIds]);
  const overCount = overIds.size;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 no-print">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item, code…" aria-label="Search the catalogue" className={`${F} w-full sm:w-64`} />
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className={`${F} w-full sm:w-56`}>
          <option value="">Every department</option>
          {departments.sections.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          {departments.custom.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button type="button" className={`pill cursor-pointer ${onlyAlarms ? "pill-bad" : overCount ? "pill-warn" : "pill-muted"}`} onClick={() => setOnlyAlarms((v) => !v)} aria-pressed={onlyAlarms}>
          ⚠ {overCount} over their limit now
        </button>
        <span className="text-sm text-muted">{shown.length} of {items.length} items</span>
        {canEdit && <button type="button" className="btn btn-primary btn-sm ms-auto" onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "+ Add item"}</button>}
      </div>
      {adding && canEdit && <div className="bg-surface border rounded-xl p-3"><ItemForm onDone={() => setAdding(false)} /></div>}
      {!canEdit && <p className="text-xs text-muted">Changing the catalogue and its limits needs the “Consumables — record” permission.</p>}

      <section className="bg-surface border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2">Item</th>
                <th className="p-2">UOM</th>
                <th className="p-2">Limits · where each stands now ({(["day", "week", "month", "quarter"] as LimitPeriod[]).map((p) => PERIOD_NOUN[p]).join(", ")})</th>
                {canEdit && <th className="p-2 no-print">Change</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => <ItemRow key={i.id} item={i} standings={standings} departments={departments} canEdit={canEdit} />)}
              {shown.length === 0 && <tr><td colSpan={4} className="p-4 text-sm text-muted">No item matches.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <details className="bg-surface border rounded-xl p-3">
        <summary className="font-bold cursor-pointer">Changes to the catalogue and limits <span className="text-muted font-normal text-sm">· the latest {changes.length}</span></summary>
        {changes.length === 0 ? <p className="text-sm text-muted mt-2">Nothing changed yet.</p> : (
          <ul className="mt-2 text-xs divide-y">
            {changes.map((c) => (
              <li key={c.id} className="py-1.5">
                <span className="ltr tabnum text-muted">{c.atLabel}</span> — <b>{c.by}</b> {c.action === "create" ? "added" : c.action === "delete" ? "removed" : "changed"} {c.entity === "limit" ? "a limit of" : ""} <b>{c.item}</b>: {c.text}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
