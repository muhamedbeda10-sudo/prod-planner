"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, Columns3 } from "lucide-react";
import { saveUserPref } from "@/app/prefs/actions";
import type { UserPrefKey } from "@/lib/domain/userPrefs";
import { ODOO_EXACT_FROM_LABEL } from "@/lib/domain/trackerOdoo";

// The pieces both Plan Trackers (transformers and LV panels) read a sheet
// with: the columns each person keeps on their account, the header arrows
// that fold a run of columns, the frozen identifiers and the stage cells'
// quiet states. Display only — no figure is computed here.

/** A frozen column's place: its left edge and width (see .stick in globals.css). */
export const stickAt = (left: number, w: number) => ({ "--stick-left": `${left}rem`, "--stick-w": `${w}rem` }) as React.CSSProperties;

/** One of the person's view settings, kept on their ACCOUNT (UserPref) — so
 *  it follows them to any computer, and two people sharing one keep their
 *  own. The page hands the saved value in; a change shows at once and is
 *  saved behind it. A setting this account never saved but this browser
 *  still holds (from before settings moved to the account) is carried over
 *  once, so nobody loses their sheet. */
export function useAccountPref(key: UserPrefKey, initial: string | null | undefined): [string | null, (v: string) => void] {
  const [value, setValue] = useState<string | null>(initial ?? null);
  // saves go out one after another, so a quick run of clicks lands in order
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (v: string) => {
    setValue(v);
    queue.current = queue.current.then(() => saveUserPref(key, v)).catch(() => undefined);
  };
  useEffect(() => {
    if (initial !== null && initial !== undefined) return;
    let local: string | null = null;
    try { local = localStorage.getItem(key); } catch { /* storage blocked */ }
    if (!local) return;
    const carried = local;
    void saveUserPref(key, carried).then((r) => {
      if (!r.ok) return;
      setValue(carried);
      try { localStorage.removeItem(key); } catch { /* storage blocked */ }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, save];
}

/** A set of keys kept on the account (folded or hidden components, hidden stages). */
export function useAccountSet(key: UserPrefKey, initial: string | null | undefined): [Set<string>, (k: string) => void] {
  const [raw, save] = useAccountPref(key, initial);
  const set = useMemo(() => new Set((raw ?? "").split(",").filter(Boolean)), [raw]);
  const toggle = (k: string) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k); else next.add(k);
    save([...next].join(","));
  };
  return [set, toggle];
}

/** The columns a saved value shows ("v<version>|key,key"): none saved, the
 *  defaults; saved before a version that brought columns, those as well. */
export function shownColumns(raw: string | null, defaults: readonly string[], added: readonly (readonly string[])[] = []): Set<string> {
  const m = raw ? /^v(\d+)\|(.*)$/.exec(raw) : null;
  if (!m) return new Set(defaults);
  const set = new Set(m[2].split(",").filter(Boolean));
  for (const keys of added.slice(Math.max(0, Number(m[1]) - 1))) for (const k of keys) set.add(k);
  return set;
}

/** The columns shown, kept on the account — each person's own sheet. Nothing
 *  saved yet reads as the defaults. `added` are the columns a later version
 *  of the sheet brought, one list per version after the first: a value saved
 *  before them shows them too, so a new column is never hidden from whoever
 *  had picked their columns already. */
export function useColumns<K extends string>(key: UserPrefKey, initial: string | null | undefined, defaults: readonly K[], added: readonly (readonly K[])[] = []) {
  const [raw, saveRaw] = useAccountPref(key, initial);
  const version = added.length + 1;
  const shown = useMemo(() => shownColumns(raw, defaults, added), [raw, defaults, added]);
  const save = (next: Set<string>) => saveRaw(`v${version}|${[...next].join(",")}`);
  const isOn = (k: K) => shown.has(k);
  const setOn = (keys: K[], on: boolean) => {
    const next = new Set(shown);
    for (const k of keys) { if (on) next.add(k); else next.delete(k); }
    save(next);
  };
  const reset = () => save(new Set(defaults));
  // the header arrows open and close a run of columns at once
  const anyOn = (g: K[]) => g.some(isOn);
  const toggle = (g: K[]) => setOn(g, !anyOn(g));
  return { isOn, setOn, reset, anyOn, toggle };
}
export type Columns<K extends string> = ReturnType<typeof useColumns<K>>;

/** A header that folds the columns beside it: its label, then › (folded) or
 *  ‹ (open). `back` points the arrow the other way, for a group that opens
 *  to the label's left. */
export function FoldButton({ open, onClick, label, title, back = false }: { open: boolean; onClick: () => void; label: string; title: string; back?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="print-as-text inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase hover:bg-surface-3"
      title={title}
    >
      {back && <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "" : "rotate-180"}`} aria-hidden />}
      {label}
      {!back && <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />}
    </button>
  );
}

/** Columns ▾ — every column, each one on or off; `children` adds the
 *  sheet's own section below (components, stages). `fixed` is the column
 *  that always shows — what the row is. */
export function ColumnMenu<K extends string>({ cols, list, fixed, fixedTitle, children }: {
  cols: Columns<K>;
  list: readonly { key: K; label: string }[];
  fixed: string;
  fixedTitle: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // the panel opens toward the room it has: from the button's right edge
  // when the button sits on the right of the bar, from its left otherwise
  const [fromEnd, setFromEnd] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    if (r) setFromEnd(r.left > window.innerWidth / 2);
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  const shownCount = list.filter((c) => cols.isOn(c.key)).length + 1;
  return (
    <div ref={box} className="relative no-print">
      <button type="button" className="chip-toggle inline-flex items-center gap-1.5" aria-expanded={open} aria-haspopup="true" onClick={toggle} title="Pick the columns you want — kept on your account">
        <Columns3 size={13} aria-hidden />Columns
      </button>
      {open && (
        <div className={`absolute z-30 mt-1 ${fromEnd ? "end-0" : "start-0"} w-[22rem] rounded-[10px] border bg-surface shadow-xl p-3 space-y-3 text-sm`}>
          <div>
            <div className="flex items-center mb-1.5">
              <span className="filter-label">Columns · {shownCount} of {list.length + 1}</span>
              <button type="button" className="ms-auto text-xs font-semibold text-brand-ink hover:underline" onClick={cols.reset}>Defaults</button>
            </div>
            <div className="grid grid-cols-2 gap-x-3">
              <label className="flex items-center gap-2 py-0.5 opacity-60" title={fixedTitle}>
                <input type="checkbox" checked disabled />{fixed}
              </label>
              {list.map((c) => (
                <label key={c.key} className="flex items-center gap-2 py-0.5 cursor-pointer">
                  <input type="checkbox" checked={cols.isOn(c.key)} onChange={() => cols.setOn([c.key], !cols.isOn(c.key))} />{c.label}
                </label>
              ))}
            </div>
          </div>
          {children}
          <p className="text-[11px] text-muted">Kept on your account — the same on any computer you sign in on.</p>
        </div>
      )}
    </div>
  );
}

/** Where a stage cell stands against what the order needs of it — the class
 *  that gives it its quiet wash. */
export function stageState(value: number, target: number, held: boolean): string {
  if (held || value <= 0) return "stage-idle"; // nothing yet: an empty cell
  if (target > 0 && value >= target) return "stage-done"; // quiet, in the success ink
  return "stage-part"; // started, not finished: the warning ink, what is left in the tooltip
}

/** A hairline of how far an unfinished stage is — under the number, never
 *  instead of it. Drawn as the cell's own background (see .stage-meter in
 *  globals.css), so nothing positioned can slide over the frozen columns. */
export function meterStyle(value: number, target: number): React.CSSProperties | undefined {
  if (target <= 0 || value <= 0 || value >= target) return undefined;
  return { "--meter": Math.min(1, value / target) } as React.CSSProperties;
}

/** A stage cell's words: how far it is, for its tooltip. */
export function stageWords(value: number, target: number): string {
  const left = Math.max(0, target - value);
  return value <= 0 ? `nothing yet of ${target}` : left > 0 ? `${value} of ${target} — ${left} left` : `all ${target} done`;
}

/** Achievement: the figure in its status colour — no filled cell. */
export function AchCell({ ach }: { ach: number | null }) {
  const color = ach === null ? "var(--muted)" : ach >= 1 ? "var(--ok-fg)" : ach >= 0.5 ? "var(--foreground)" : "var(--warn-fg)";
  return (
    <td className="p-2 text-center font-semibold tabnum" style={{ color }}>
      {ach === null ? "—" : `${(ach * 100).toFixed(0)}%`}
    </td>
  );
}

/** An Odoo column's cell, read-only, in Odoo's plum (.odoo-col): what Odoo
 *  closed of `of`, a hairline under it, empty at 0; with `href`, a link to
 *  the order's On Odoo records. The trackers' three Odoo columns — monthly,
 *  LV, weekly — all draw it here. */
export function OdooCell({ value, of, label, href, className = "" }: { value: number; of: number; label: string; href?: string; className?: string }) {
  const meter = meterStyle(value, of);
  const over = value > of ? ` — ${value - of} more than the plan` : "";
  const words = `Closed in Odoo · ${label}: ${stageWords(value, of)}${over}`;
  return (
    <td className={`stage-cell odoo-col ${of > 0 && value >= of ? "odoo-full" : ""} ${meter ? "stage-meter" : ""} text-center tabnum ${className}`} style={meter} title={words}>
      {value <= 0 ? "" : href ? (
        <Link href={href} onClick={(e) => e.stopPropagation()} className="print-as-text hover:underline" aria-label={words}>{value}</Link>
      ) : value}
    </td>
  );
}

/** An Odoo cell for orders whose closings are not counted (planned before ODOO_EXACT_FROM). */
export function OdooNotCounted({ why = `Planned before ${ODOO_EXACT_FROM_LABEL} — Odoo closings are not counted here`, className = "" }: { why?: string; className?: string }) {
  return (
    <td className={`odoo-col text-center ${className}`} title={why}>
      <span aria-hidden className="opacity-60">—</span><span className="sr-only">Odoo not counted</span>
    </td>
  );
}
