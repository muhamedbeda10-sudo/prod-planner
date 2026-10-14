"use client";

import { Fragment, useMemo, useState } from "react";
import { WORKER_GROUPS } from "@/lib/domain/tanks";
import { ALL_DEPARTMENTS, LIMIT_PERIODS, PERIOD_LABEL, type LimitBasis, type LimitPeriod } from "@/lib/domain/consumableLimits";
import { NEAR_RATIO } from "@/lib/domain/consumableMonthly";
import type { CatalogueChangeView, CatalogueItemDTO, LimitDTO, LimitStandingView } from "@/lib/server/consumableLimits";
import { deleteConsumableLimit, saveCatalogueItem, saveConsumableLimit } from "@/app/consumables/catalogueActions";
import { ActionMsg as Msg, useConsumableAction as useAction } from "@/components/consumablesUi";
import { Modal } from "@/components/Modal";
import { TableEmpty, TableFrame, Th, useRowMenu } from "@/components/DataTable";
import { SearchBox } from "@/components/FilterControls";
import { StatTile } from "@/components/charts/kit";

// The CONSUMABLES tab's Limits view: the store's catalogue — code, name, unit
// — each item with its limits, one line per limit, and where each stands
// right now in its own window (this month, this quarter …). An "each
// department" or "per worker" limit is every department's own number, so its
// line adds them up and opens onto each department's standing. Whoever
// records hand-outs (consumables.edit) adds items, changes them, retires
// them, and adds, changes or removes their limits; every change is kept (the
// list at the foot of the page).

type Departments = { sections: { code: string; label: string; group: string }[]; custom: string[] };

const F = "px-2 py-1.5 text-sm font-semibold";
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 3 }));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const BASIS_LABEL: Record<LimitBasis, string> = { pool: "Shared", each: "Each department", person: "Per worker" };
const BASIS_HINT: Record<LimitBasis, string> = {
  pool: "One number for all the departments picked together",
  each: "Every department picked has the whole number to itself",
  person: "The number per worker, times each department's workers on the workers list",
};

/** Where a limit stands now, in four words. */
type LimitState = "over" | "near" | "ok" | "idle";
const STATE_LABEL: Record<LimitState, string> = { over: "Over", near: "Close", ok: "Within", idle: "Not used" };
const STATE_PILL: Record<LimitState, string> = { over: "pill-bad", near: "pill-warn", ok: "pill-ok", idle: "pill-muted" };
const STATE_TONE: Record<LimitState, string> = { over: "var(--bad-fg)", near: "var(--warn-fg)", ok: "var(--ok-fg)", idle: "var(--border-strong)" };

function stateOf(s: LimitStandingView | undefined): LimitState {
  if (!s || s.used <= 0) return "idle";
  if (s.over > 0) return "over";
  if (s.worstRatio >= NEAR_RATIO - 1e-9) return "near";
  return "ok";
}
const ratioState = (used: number, limit: number): LimitState =>
  used <= 0 ? "idle" : used > limit + 1e-9 ? "over" : used >= limit * NEAR_RATIO - 1e-9 ? "near" : "ok";

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`inline-flex flex-col gap-0.5 ${className}`}>
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

/** Used against the limit: the bar fills to the limit; past it, the bar is
 *  full and red, and the figure says by how much. */
function Bar({ used, limit, state }: { used: number; limit: number; state: LimitState }) {
  const ratio = limit > 0 ? used / limit : 0;
  return (
    <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden" aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: STATE_TONE[state] }} />
    </div>
  );
}

function StatePill({ state }: { state: LimitState }) {
  return <span className={`pill ${STATE_PILL[state]} whitespace-nowrap`}>{state === "over" ? "⚠ " : ""}{STATE_LABEL[state]}</span>;
}

function ItemForm({ item, onDone, departments }: { item?: CatalogueItemDTO; onDone: () => void; departments?: Departments }) {
  const save = useAction();
  // a new item takes its limit in the same form — how much, how often, for
  // which departments and how it counts — so it is set in one go
  const [withLimit, setWithLimit] = useState(!item);
  const [all, setAll] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.currentTarget);
        if (item) fd.set("id", String(item.id));
        if (!item) {
          fd.set("withLimit", withLimit ? "true" : "false");
          fd.set("allDepartments", all ? "true" : "false");
        }
        save.run(saveCatalogueItem, fd, item ? "Saved." : withLimit ? "Added to the catalogue with its limit." : "Added to the catalogue.", onDone);
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
      {!item && departments && (
        <div className="w-full border rounded-lg p-2 space-y-2 mt-1">
          <label className="inline-flex items-center gap-1.5 text-sm font-bold cursor-pointer">
            <input type="checkbox" checked={withLimit} onChange={(e) => setWithLimit(e.target.checked)} disabled={save.pending} className="accent-[var(--brand,#1b7a43)]" />
            Its limit
          </label>
          {withLimit && <LimitFields departments={departments} all={all} setAll={setAll} busy={save.pending} />}
          {!withLimit && <p className="text-[11px] text-muted">No limit — anything handed out of it is only logged. Limits can be added to the item later.</p>}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending}>{item ? "Save" : "Add item"}</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onDone} disabled={save.pending}>Cancel</button>
      <div className="w-full"><Msg msg={save.msg} /></div>
    </form>
  );
}

/** The limit's own fields — quantity, how often, how it counts, which
 *  departments — shared by the limit form and the add-item form. */
function LimitFields({ limit, departments, all, setAll, busy }: {
  limit?: LimitDTO; departments: Departments; all: boolean; setAll: (v: boolean) => void; busy: boolean;
}) {
  const picked = new Set(limit && limit.departments !== ALL_DEPARTMENTS ? limit.departments : []);
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Quantity" className="w-24">
          <input type="number" name="qty" inputMode="decimal" step="0.001" min="0.001" required defaultValue={limit?.qty ?? ""} className={`${F} ltr tabnum w-full`} disabled={busy} />
        </Field>
        <Field label="How often" className="w-44">
          <select name="period" defaultValue={limit?.period ?? "month"} className={`${F} w-full`} disabled={busy}>
            {LIMIT_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p as LimitPeriod]}</option>)}
          </select>
        </Field>
        <Field label="The quantity is" className="w-80">
          <select name="basis" defaultValue={limit?.basis ?? "each"} className={`${F} w-full`} disabled={busy}>
            <option value="each">Each department its own</option>
            <option value="pool">Shared by the departments picked</option>
            <option value="person">Per worker (× the department&apos;s workers)</option>
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
        <p className="text-[11px] text-muted">
          <b>Each its own</b>: every department picked gets the whole number. <b>Shared</b>: the departments picked use one number between them.
          <b> Per worker</b>: the number times each department&apos;s workers on the workers list becomes that department&apos;s limit.
        </p>
      </div>
    </>
  );
}

function LimitForm({ itemId, limit, departments, onDone }: { itemId: number; limit?: LimitDTO; departments: Departments; onDone: () => void }) {
  const save = useAction();
  const del = useAction();
  const [all, setAll] = useState(limit?.departments === ALL_DEPARTMENTS);
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
      <LimitFields limit={limit} departments={departments} all={all} setAll={setAll} busy={busy} />
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

/** Every department's own standing under an "each" or per-worker limit. */
function DepartmentBreakdown({ s, uom, basis }: { s: LimitStandingView; uom: string; basis: LimitBasis }) {
  return (
    <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
      {s.departments.map((d) => {
        const st = ratioState(d.used, d.limit);
        return (
          <li key={d.department} className="min-w-0">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-semibold truncate min-w-0 flex-1" title={d.label}>{d.label}</span>
              <span className="tabnum whitespace-nowrap"><b style={{ color: st === "over" ? "var(--bad-fg)" : undefined }}>{fmt(d.used)}</b> / {fmt(d.limit)} {uom}</span>
            </div>
            <Bar used={d.used} limit={d.limit} state={st} />
            {basis === "person" && d.workers !== null && (
              <div className="text-[11px] text-muted">{d.workers > 0 ? `${d.workers} worker${d.workers === 1 ? "" : "s"} on the list` : "no one on the workers list — counted as one"}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One limit's line: the number, how it counts, for whom, and where it stands now. */
function LimitCells({ l, s, uom, open, toggle }: { l: LimitDTO; s: LimitStandingView | undefined; uom: string; open: boolean; toggle: () => void }) {
  const state = stateOf(s);
  const split = !!s && s.departments.length > 0;
  const left = s ? round3(s.limit - s.used) : null;
  return (
    <>
      <td className="p-2 whitespace-nowrap">
        <span className="tabnum font-extrabold">{fmt(l.qty)}</span> <span className="text-xs text-muted">{uom}</span>
        <div className="text-xs text-muted">{PERIOD_LABEL[l.period]}</div>
      </td>
      <td className="p-2"><span className="pill pill-muted whitespace-nowrap" title={BASIS_HINT[l.basis]}>{BASIS_LABEL[l.basis]}</span></td>
      <td className="p-2 text-xs max-w-[16rem]">{l.departmentsLabel}</td>
      <td className="p-2 min-w-[11rem]">
        {s ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted whitespace-nowrap">{s.windowLabel}</span>
              <span className="tabnum whitespace-nowrap"><b style={{ color: state === "over" ? "var(--bad-fg)" : undefined }}>{fmt(s.used)}</b> / {fmt(s.limit)}</span>
            </div>
            <Bar used={s.used} limit={s.limit} state={split ? ratioState(s.used, s.limit) : state} />
            {split && (
              <button type="button" className="text-[11px] text-muted hover:text-foreground mt-0.5 no-print" onClick={toggle} aria-expanded={open}>
                {open ? "▾" : "▸"} {s.departments.length} department{s.departments.length === 1 ? "" : "s"}
                {s.over > 0 ? <b className="text-bad-fg"> · {s.over} over</b> : null}
              </button>
            )}
          </>
        ) : <span className="text-xs text-muted">—</span>}
      </td>
      <td className="p-2 text-right tabnum whitespace-nowrap">
        {left === null ? "—" : split ? <span className="text-xs text-muted" title="Every department has its own number — see each one">by department</span>
          : <b style={{ color: left < 0 ? "var(--bad-fg)" : undefined }}>{fmt(left)}</b>}
      </td>
      <td className="p-2"><StatePill state={state} /></td>
    </>
  );
}

/** A line's ⋯ menu (and right-click): its limit, and the item's own actions. */
function RowActions({ name, limitId, onEdit }: { name: string; limitId?: number; onEdit: (what: "item" | "new-limit" | number) => void }) {
  const menu = useRowMenu(() => [
    { heading: name },
    ...(limitId !== undefined ? [{ key: "edit-limit", label: "Edit this limit…", icon: "✏️", onSelect: () => onEdit(limitId) }] : []),
    { key: "add-limit", label: "Add a limit…", icon: "➕", onSelect: () => onEdit("new-limit") },
    { sep: true } as const,
    { key: "edit-item", label: "Edit the item…", icon: "📦", onSelect: () => onEdit("item") },
  ], `Actions for ${name}`);
  return <td className="p-2 text-center no-print" onContextMenu={menu.onContextMenu}>{menu.button}{menu.menu}</td>;
}

function ItemRows({ item, standings, departments, canEdit }: { item: CatalogueItemDTO; standings: Record<number, LimitStandingView>; departments: Departments; canEdit: boolean }) {
  const [editing, setEditing] = useState<"item" | "new-limit" | number | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const close = () => setEditing(null);
  const toggle = (id: number) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // the item's cells run down its limits' lines and any department list opened under them
  const hasBreakdown = (id: number) => open.has(id) && (standings[id]?.departments.length ?? 0) > 0;
  const span = Math.max(1, item.limits.length + item.limits.filter((l) => hasBreakdown(l.id)).length);
  const cols = canEdit ? 9 : 8;

  const itemCells = (
    <>
      <td className="p-2 align-top" rowSpan={span}>
        <div className="font-semibold">
          {item.name}
          {!item.active && <span className="pill pill-muted ms-1.5">retired</span>}
        </div>
        <div className="text-xs text-muted ltr">{item.code ?? "no code"}</div>
        {item.remark && <div className="text-xs text-muted">{item.remark}</div>}
      </td>
      <td className="p-2 align-top text-xs font-bold" rowSpan={span}>{item.uom}</td>
    </>
  );

  return (
    <Fragment>
      {item.limits.length === 0 ? (
        <tr className={`border-t ${item.active ? "" : "opacity-60"}`}>
          {itemCells}
          <td className="p-2 text-xs text-muted" colSpan={6}>No limit — what is handed out of it is logged, nothing holds it back.</td>
          {canEdit && <RowActions name={item.name} onEdit={setEditing} />}
        </tr>
      ) : item.limits.map((l, k) => (
        <Fragment key={l.id}>
          <tr className={`${k === 0 ? "border-t" : ""} ${item.active ? "" : "opacity-60"}`}>
            {k === 0 && itemCells}
            <LimitCells l={l} s={standings[l.id]} uom={item.uom} open={open.has(l.id)} toggle={() => toggle(l.id)} />
            {canEdit && <RowActions name={item.name} limitId={l.id} onEdit={setEditing} />}
          </tr>
          {hasBreakdown(l.id) && (
            <tr className="bg-surface-2/60">
              <td colSpan={cols - 2} className="p-3">
                <DepartmentBreakdown s={standings[l.id]} uom={item.uom} basis={l.basis} />
              </td>
            </tr>
          )}
        </Fragment>
      ))}
      {editing !== null && canEdit && (
        <Modal
          title={editing === "item" ? `Edit ${item.name}` : editing === "new-limit" ? `Add a limit to ${item.name}` : `Edit a limit of ${item.name}`}
          sub={item.code ?? undefined}
          onClose={close}
        >
          {editing === "item" ? <ItemForm item={item} onDone={close} />
            : editing === "new-limit" ? <LimitForm itemId={item.id} departments={departments} onDone={close} />
            : <LimitForm itemId={item.id} limit={item.limits.find((l) => l.id === editing)} departments={departments} onDone={close} />}
        </Modal>
      )}
    </Fragment>
  );
}

type Filter = "all" | "over" | "near" | "nolimit" | "retired";

export function ConsumableLimits({
  items,
  standings,
  departments,
  changes,
  canEdit,
}: {
  items: CatalogueItemDTO[];
  standings: Record<number, LimitStandingView>;
  departments: Departments;
  changes: CatalogueChangeView[];
  canEdit: boolean;
}) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // an item is as bad as its worst limit
  const stateOfItem = useMemo(() => {
    const rank: Record<LimitState, number> = { over: 3, near: 2, ok: 1, idle: 0 };
    return new Map(items.map((i) => [i.id, i.limits.map((l) => stateOf(standings[l.id])).reduce<LimitState>((w, s) => (rank[s] > rank[w] ? s : w), "idle")]));
  }, [items, standings]);
  const counts = useMemo(() => {
    const active = items.filter((i) => i.active);
    return {
      all: items.length,
      over: active.filter((i) => stateOfItem.get(i.id) === "over").length,
      near: active.filter((i) => stateOfItem.get(i.id) === "near").length,
      nolimit: active.filter((i) => i.limits.length === 0).length,
      retired: items.length - active.length,
      active: active.length,
      limits: active.reduce((n, i) => n + i.limits.length, 0),
    };
  }, [items, stateOfItem]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) =>
      (!needle || [i.name, i.code ?? "", i.remark ?? ""].some((v) => v.toLowerCase().includes(needle)))
      && (!dept || i.limits.some((l) => l.departments === ALL_DEPARTMENTS || l.departments.includes(dept)))
      && (filter === "all" ? true
        : filter === "retired" ? !i.active
        : filter === "nolimit" ? i.active && i.limits.length === 0
        : i.active && stateOfItem.get(i.id) === filter)
    );
  }, [items, q, dept, filter, stateOfItem]);

  const FILTERS: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: counts.all },
    { key: "over", label: "Over now", n: counts.over },
    { key: "near", label: "Close", n: counts.near },
    { key: "nolimit", label: "No limit", n: counts.nolimit },
    { key: "retired", label: "Retired", n: counts.retired },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <StatTile label="Items in use" value={fmt(counts.active)} sub={`${fmt(counts.limits)} limit${counts.limits === 1 ? "" : "s"} set`} />
        <StatTile label="Over a limit now" value={fmt(counts.over)} sub={counts.over ? "items past a number in its current window" : "✓ every item within its limits"} />
        <StatTile label={`Close (${Math.round(NEAR_RATIO * 100)}%+)`} value={fmt(counts.near)} sub="items near a limit" />
        <StatTile label="No limit" value={fmt(counts.nolimit)} sub="active items only logged" />
      </div>

      <div className="toolbar toolbar-row no-print !mb-0">
        <SearchBox value={q} onChange={setQ} placeholder="Search item, code, remark…" wide />
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className={`${F} w-full sm:w-56`}>
          <option value="">Every department</option>
          {WORKER_GROUPS.map((g) => (
            <optgroup key={g.key} label={g.label}>
              {departments.sections.filter((s) => s.group === g.key).map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </optgroup>
          ))}
          {departments.custom.length > 0 && (
            <optgroup label="Other departments">{departments.custom.map((d) => <option key={d} value={d}>{d}</option>)}</optgroup>
          )}
        </select>
        <nav className="seg" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>
              {f.label} <span className="tabnum">{f.n}</span>
            </button>
          ))}
        </nav>
        <span className="text-sm text-muted ms-auto"><b className="text-foreground tabnum">{shown.length}</b> of <span className="tabnum">{items.length}</span> items</span>
        {canEdit && <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Add item</button>}
      </div>
      {adding && canEdit && (
        <Modal title="Add an item to the catalogue" sub="The item, and its limit — how much, how often, for which departments" onClose={() => setAdding(false)}>
          <ItemForm departments={departments} onDone={() => setAdding(false)} />
        </Modal>
      )}
      {!canEdit && <p className="text-xs text-muted">Changing the catalogue and its limits needs the “Consumables — record” permission.</p>}

      <section className="bg-surface border rounded-xl overflow-hidden">
        {shown.length === 0 ? (
          <TableEmpty
            title={items.length === 0 ? "The catalogue is empty" : "No item matches"}
            hint={items.length === 0 && canEdit ? "Add the store's items and their limits — hand-outs of them are then counted." : undefined}
            filtered={items.length > 0}
            action={items.length > 0 ? <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setQ(""); setDept(""); setFilter("all"); }}>Show every item</button> : undefined}
          />
        ) : (
          <TableFrame className="!max-h-[calc(100vh-16rem)] min-h-[16rem]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left">
                  <Th label="Item" />
                  <Th label="Unit" />
                  <Th label="Limit" hint="How much, how often — months run Jan–Mar, Apr–Jun … for every 3 months" />
                  <Th label="Counted" full="How the number counts" hint="Shared: one number for the departments together · Each department: every department the whole number · Per worker: the number times each department's workers" />
                  <Th label="For" full="The departments it covers" />
                  <Th label="Now" full="Used in the current window" hint="This month, or the months of a longer limit so far. An each-department or per-worker limit adds its departments up — open it to see each one." />
                  <Th label="Left" num className="text-right" hint="What can still be handed out before the limit" />
                  <Th label="Status" hint={`Over: past the number · Close: ${Math.round(NEAR_RATIO * 100)}% or more · Within · Not used. An each-department or per-worker limit takes its fullest department.`} />
                  {canEdit && <Th label="" className="no-print w-10" />}
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => <ItemRows key={i.id} item={i} standings={standings} departments={departments} canEdit={canEdit} />)}
              </tbody>
            </table>
          </TableFrame>
        )}
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
