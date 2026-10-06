"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { AlertTriangle, Inbox, MoreHorizontal, RotateCw } from "lucide-react";
import { ContextMenu, useContextMenu, type MenuEntry } from "@/components/ContextMenu";
import { Modal } from "@/components/Modal";
import { Tooltip } from "@/components/Tooltip";

// The pieces every data sheet is built from, so a table reads and behaves
// the same on every page:
//   · TableFrame — the scroll box (header pinned, wide sheets scroll sideways)
//     at the compact row height;
//   · Th — a header cell: a short label of two lines at most, its unit, and
//     the full name / explanation in a tooltip;
//   · GroupBand — the band over the headers that says which columns come from
//     the source, which are typed here and which are calculated;
//   · CellEditor — a cell that looks like text until it is edited, and edits
//     like a spreadsheet (Enter / ↑ ↓ move, Esc cancels);
//   · RowMenu — the row's ⋯ button, the same menu a right-click opens;
//   · useConfirm — a confirmation that names exactly what it changes;
//   · TableEmpty / TableSkeleton / ErrorState — the three states a table has
//     besides its rows.
// Display only: none of it computes, fetches or saves anything on its own.

// ---- row height: compact (36px) everywhere — one height, no switch ----

/** The scroll box around a sheet: the header stays pinned while the rows
 *  scroll, a wide sheet scrolls sideways, rows sit at the compact height. */
export function TableFrame({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`overflow-x-auto erp-scroll dt ${className}`} data-density="compact" style={style}>
      {children}
    </div>
  );
}

// ---- headers ----

/** Where a column's figures come from. Shown as a coloured hairline over its
 *  header and named in the GroupBand. */
export type ColGroup = "source" | "input" | "computed";
export const COL_GROUP_LABEL: Record<ColGroup, string> = {
  source: "From the sheet",
  input: "Typed here",
  computed: "Calculated",
};

/**
 * One header cell. `label` is what fits (two lines at most); `full` is the
 * column's whole name, shown in the tooltip along with `hint`. A unit sits
 * after the label in lower case — "Weight kg", not "WEIGHT(KG)".
 */
export function Th({
  label, full, unit, hint, group, num = false, center = false, className = "", style, colSpan, rowSpan,
}: {
  label: ReactNode;
  full?: string;
  unit?: string;
  hint?: ReactNode;
  group?: ColGroup;
  num?: boolean;
  center?: boolean;
  className?: string;
  style?: CSSProperties;
  colSpan?: number;
  rowSpan?: number;
}) {
  const tip = full || hint || group ? (
    <span className="block max-w-[18rem]">
      {full && <span className="block font-semibold">{full}{unit ? ` (${unit})` : ""}</span>}
      {hint && <span className="block mt-0.5">{hint}</span>}
      {group && <span className="block mt-0.5 opacity-75">{COL_GROUP_LABEL[group]}</span>}
    </span>
  ) : null;
  const inner = (
    <span className="dt-th-label" tabIndex={tip ? 0 : undefined}>
      {label}
      {unit && <span className="dt-unit">{unit}</span>}
      {hint && <span className="dt-hint" aria-hidden>?</span>}
    </span>
  );
  return (
    <th
      scope="col"
      data-group={group}
      colSpan={colSpan}
      rowSpan={rowSpan}
      aria-label={full ?? (typeof label === "string" ? label : undefined)}
      className={`dt-th px-2 ${num ? "num" : center ? "text-center" : "text-left"} ${className}`}
      style={style}
    >
      {tip ? <Tooltip content={tip} side="bottom">{inner}</Tooltip> : inner}
    </th>
  );
}

/** The band over the header row: a coloured line over each run of columns,
 *  by where its figures come from. A span may carry a label; the first one
 *  usually carries the GroupLegend that names the colours. */
export function GroupBand({ spans, className = "" }: { spans: { span: number; group?: ColGroup; label?: ReactNode; className?: string; style?: CSSProperties }[]; className?: string }) {
  return (
    <tr className={`dt-band ${className}`}>
      {spans.map((s, i) => (
        <th key={i} colSpan={s.span} data-group={s.group} className={`dt-band-cell ${s.className ?? ""}`} style={s.style} scope="colgroup" aria-label={s.group ? COL_GROUP_LABEL[s.group] : undefined}>
          {s.label}
        </th>
      ))}
    </tr>
  );
}

/** What the band's colours mean. */
export function GroupLegend({ groups = ["source", "input", "computed"] }: { groups?: ColGroup[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 normal-case tracking-normal font-medium">
      {groups.map((g) => (
        <span key={g} className="inline-flex items-center gap-1" data-group={g}>
          <span className="inline-block w-3 h-[3px] rounded" style={{ background: "var(--grp)" }} aria-hidden />
          {COL_GROUP_LABEL[g]}
        </span>
      ))}
    </span>
  );
}

// ---- an editable cell ----

/**
 * A cell that reads as plain text and edits in place. A hairline shows on
 * hover, a brand outline while editing. Enter saves and moves down (Shift+Enter
 * up), ↑ ↓ do the same without the Enter, Tab moves along the row, Escape puts
 * the value back. `col` names the column so the keys find the cell above or
 * below. What saving does is the caller's: onCommit gets the trimmed text.
 */
export function CellEditor({
  value, onCommit, col, type = "number", step, min, placeholder = "—", title, ariaLabel, disabled, list, className = "", inputMode, warn = false,
}: {
  value: string;
  onCommit: (v: string) => void;
  col: string;
  type?: "number" | "text";
  step?: string;
  min?: string;
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  list?: string;
  className?: string;
  inputMode?: "decimal" | "numeric" | "text";
  warn?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) { setPrev(value); setDraft(value); }
  const cancelled = useRef(false);

  const commit = () => {
    if (cancelled.current) { cancelled.current = false; return; }
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };
  const move = (el: HTMLInputElement, dir: -1 | 1) => {
    const table = el.closest("table");
    const cells = table ? Array.from(table.querySelectorAll<HTMLInputElement>(`input[data-edit-col="${col}"]:not(:disabled)`)) : [];
    const next = cells[cells.indexOf(el) + dir];
    if (next) { next.focus(); next.select(); } else el.blur();
  };
  return (
    <input
      type={type}
      step={step}
      min={min}
      inputMode={inputMode ?? (type === "number" ? "decimal" : undefined)}
      value={draft}
      disabled={disabled}
      list={list}
      data-edit-col={col}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setDraft(value); el.blur(); }
        else if (e.key === "Enter") { e.preventDefault(); move(el, e.shiftKey ? -1 : 1); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(el, e.key === "ArrowUp" ? -1 : 1); }
      }}
      placeholder={placeholder}
      title={title}
      aria-label={ariaLabel ?? title}
      className={`cell-edit ${warn ? "cell-edit-warn" : ""} ${type === "number" ? "text-right tabnum ltr" : ""} ${className}`}
    />
  );
}

// ---- the row's actions ----

/**
 * A row's actions, two ways in: the ⋯ `button` (visible, and reachable from
 * the keyboard) and a right-click anywhere on the row (`onContextMenu` on the
 * <tr>). Both open the same entries. Render `menu` once, anywhere.
 */
export function useRowMenu(entries: () => MenuEntry[], label: string) {
  const m = useContextMenu<null>();
  const button = (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={!!m.menu}
      title={`${label} (or right-click the row)`}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        m.open({ preventDefault() {}, clientX: r.right - 224, clientY: r.bottom + 4 }, null);
      }}
    >
      <MoreHorizontal size={15} />
    </button>
  );
  const onContextMenu = (e: ReactMouseEvent) => {
    // a right-click in a field keeps the browser's own menu (paste, spelling)
    if ((e.target as HTMLElement).closest("input, textarea, select, a")) return;
    m.open(e, null);
  };
  const menu = m.menu ? <ContextMenu x={m.menu.x} y={m.menu.y} entries={entries()} onClose={m.close} /> : null;
  return { button, onContextMenu, menu };
}

// ---- confirmation that names what changes ----

export interface ConfirmRequest {
  title: string;
  /** What is about to happen, in a sentence. */
  body?: ReactNode;
  /** Exactly which records change — one line each. */
  items?: string[];
  confirmLabel: string;
  danger?: boolean;
}

/** `const [confirm, dialog] = useConfirm()` — render `dialog`, then
 *  `if (!(await confirm({...}))) return;` where window.confirm was. */
export function useConfirm(): [(req: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{ req: ConfirmRequest; resolve: (ok: boolean) => void } | null>(null);
  const ask = (req: ConfirmRequest) => new Promise<boolean>((resolve) => setPending({ req, resolve }));
  const answer = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  return [ask, pending ? <ConfirmDialog {...pending.req} onAnswer={answer} /> : null];
}

const LIST_MAX = 12;

export function ConfirmDialog({ title, body, items, confirmLabel, danger = false, onAnswer }: ConfirmRequest & { onAnswer: (ok: boolean) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  // the safe answer holds the focus: Enter on a destructive dialog cancels
  useEffect(() => { cancel.current?.focus(); }, []);
  const shown = items?.slice(0, LIST_MAX) ?? [];
  const more = (items?.length ?? 0) - shown.length;
  return (
    <Modal title={title} onClose={() => onAnswer(false)} width="max-w-lg">
      {body && <div className="text-sm">{body}</div>}
      {shown.length > 0 && (
        <ul className="mt-2 max-h-56 overflow-y-auto rounded-md border bg-surface-2 px-3 py-2 text-sm ltr tabnum space-y-0.5">
          {shown.map((s, i) => <li key={i} className="break-words">{s}</li>)}
          {more > 0 && <li className="text-muted">and {more} more</li>}
        </ul>
      )}
      <div className="flex justify-end gap-2 pt-3 mt-3 border-t">
        <button ref={cancel} type="button" className="btn btn-sm btn-ghost" onClick={() => onAnswer(false)}>Cancel</button>
        <button type="button" className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => onAnswer(true)}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ---- a short form in a dialog, where window.prompt was ----

export interface AskField {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select";
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
  options?: { value: string; label: string }[];
}
export interface AskRequest {
  title: string;
  body?: ReactNode;
  fields: AskField[];
  confirmLabel: string;
  danger?: boolean;
}

/** `const [ask, dialog] = useAsk()` — render `dialog`, then
 *  `const v = await ask({...}); if (!v) return;` — v holds each field's text
 *  by name. The browser checks the fields (required, min, max) before it
 *  answers; a date field is a date picker, not typed YYYY-MM-DD. */
export function useAsk(): [(req: AskRequest) => Promise<Record<string, string> | null>, ReactNode] {
  const [pending, setPending] = useState<{ req: AskRequest; resolve: (v: Record<string, string> | null) => void } | null>(null);
  const ask = (req: AskRequest) => new Promise<Record<string, string> | null>((resolve) => setPending({ req, resolve }));
  const answer = (v: Record<string, string> | null) => { pending?.resolve(v); setPending(null); };
  return [ask, pending ? <AskDialog {...pending.req} onAnswer={answer} /> : null];
}

function AskDialog({ title, body, fields, confirmLabel, danger = false, onAnswer }: AskRequest & { onAnswer: (v: Record<string, string> | null) => void }) {
  return (
    <Modal title={title} onClose={() => onAnswer(null)} width="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          onAnswer(Object.fromEntries(fields.map((f) => [f.name, String(fd.get(f.name) ?? "").trim()])));
        }}
      >
        {body && <div className="text-sm mb-3">{body}</div>}
        <div className="space-y-3">
          {fields.map((f) => (
            <label key={f.name} className="block">
              <span className="filter-label block mb-1">{f.label}</span>
              {f.type === "select" ? (
                <select name={f.name} defaultValue={f.defaultValue ?? ""} required={f.required} className="ctl w-full">
                  {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  name={f.name} type={f.type} defaultValue={f.defaultValue} placeholder={f.placeholder} required={f.required}
                  min={f.min} max={f.max} step={f.step}
                  className={`ctl w-full ${f.type === "number" || f.type === "date" ? "tabnum ltr" : ""}`}
                />
              )}
              {f.hint && <span className="block text-xs text-muted mt-1">{f.hint}</span>}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-3 mt-4 border-t">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onAnswer(null)}>Cancel</button>
          <button type="submit" className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- the states besides rows ----

/** Nothing to show: say why, and what to do about it. */
export function TableEmpty({ title, hint, action, filtered = false }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; filtered?: boolean }) {
  return (
    <div className="dt-state" role="status">
      <Inbox size={22} className="text-muted" aria-hidden />
      <p className="font-semibold">{title}</p>
      {hint && <p className="text-sm text-muted max-w-xl">{hint}</p>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
      {filtered && <span className="sr-only">Filters are hiding rows.</span>}
    </div>
  );
}

export { TableSkeleton } from "@/components/TableSkeleton";

/** Something failed: say so plainly and offer the retry. */
export function ErrorState({ title = "This page could not load", detail, onRetry }: { title?: string; detail?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="dt-state" role="alert">
      <AlertTriangle size={22} className="text-bad-fg" aria-hidden />
      <p className="font-semibold">{title}</p>
      {detail && <p className="text-sm text-muted max-w-xl">{detail}</p>}
      {onRetry && (
        <button type="button" className="btn btn-sm btn-secondary mt-1" onClick={onRetry}>
          <RotateCw size={14} aria-hidden />Try again
        </button>
      )}
    </div>
  );
}
