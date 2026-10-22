"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useLineKey } from "@/components/LineContext";
import { Search, X, FilterX, SlidersHorizontal } from "lucide-react";

/** Small consistent filter controls used by the filterable tables. */

// tiny store over sessionStorage so filter state survives navigation
const filterListeners = new Set<() => void>();
const subscribeFilters = (cb: () => void) => {
  filterListeners.add(cb);
  return () => {
    filterListeners.delete(cb);
  };
};

/** useState that survives navigation: the value is mirrored to
 *  sessionStorage, so leaving a page and coming back restores the search /
 *  filters exactly as they were (per browser tab; a new tab starts clean).
 *  useSyncExternalStore keeps hydration safe — the server snapshot is the
 *  default, and the stored value applies right after hydration. */
export function useSavedFilter(rawKey: string, initial = "") {
  // each product line keeps its own filters: "CF" or "Cut" means nothing on
  // the panels, and a value carried over the toggle empties the screen with
  // no control on it to explain why
  const key = useLineKey(rawKey);
  const value = useSyncExternalStore(
    subscribeFilters,
    () => {
      try {
        return sessionStorage.getItem(`flt:${key}`) ?? initial;
      } catch {
        return initial;
      }
    },
    () => initial
  );
  const set = useCallback(
    (next: string) => {
      try {
        sessionStorage.setItem(`flt:${key}`, next);
      } catch {}
      filterListeners.forEach((l) => l());
    },
    [key]
  );
  return [value, set] as const;
}

export function SearchBox({
  value,
  onChange,
  placeholder = "Search BOM / MO / KVA…",
  wide = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** The page's main search, in a toolbar's first row — room for its hint. */
  wide?: boolean;
}) {
  return (
    <div className="relative col-span-2 sm:col-span-1 max-sm:w-full max-sm:basis-full">
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`ctl pl-8 pr-7 w-full ${wide ? "sm:w-80" : "sm:w-60"} [&::-webkit-search-cancel-button]:hidden`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground rounded p-0.5 transition-colors"
          title="Clear"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * The one filter control: a select whose label sits INSIDE it ("Status: All"),
 * so a row of filters reads as a sentence and takes no extra width for
 * captions. When it is narrowing the rows it turns into an active chip with a
 * ✕ that puts it back to "All".
 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  emptyValue = "",
  allLabel = "All",
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** The value that means "no filter" ("" by default; some filters use "all"). */
  emptyValue?: string;
  allLabel?: string;
  title?: string;
}) {
  const active = value !== emptyValue;
  return (
    <span className={`filter-chip ${active ? "filter-chip-on" : ""}`} title={title}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="ctl">
        {!options.some((o) => o.value === emptyValue) && <option value={emptyValue}>{label}: {allLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {label}: {o.label}
          </option>
        ))}
      </select>
      {active && (
        <button type="button" className="filter-chip-x" onClick={() => onChange(emptyValue)} aria-label={`Clear ${label}`} title={`Clear ${label}`}>
          <X size={13} />
        </button>
      )}
    </span>
  );
}

/** A filter of the shared bar — the same control under its older name. */
export function SelectFilter({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return <FilterSelect label={label} value={value} onChange={onChange} options={options} />;
}

/** On a phone, filters fold behind one "Filters" chip so the search and the
 *  table stay in sight; from a small tablet up they show inline as before. */
export function PhoneFold({ active, children }: { active: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="chip-toggle sm:hidden inline-flex items-center gap-1.5"
        aria-expanded={open}
        aria-pressed={open || active}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={13} aria-hidden />Filters{active ? " · on" : ""}
      </button>
      <div className={open ? "contents" : "max-sm:hidden sm:contents"}>{children}</div>
    </>
  );
}

export function FilterBar({
  children,
  head,
  actions,
  count,
  total,
  onReset,
  hasActive,
  showCount = true,
  showReset = true,
}: {
  children: React.ReactNode;
  /** An optional first row above the filters: the view switch and search. */
  head?: React.ReactNode;
  /** The page's actions (export, print), at the end of the first row. */
  actions?: React.ReactNode;
  count: number;
  total: number;
  onReset: () => void;
  hasActive: boolean;
  showCount?: boolean; // worklists hide the row count — the bar stays lean
  showReset?: boolean;
}) {
  const countText = (
    <span className="text-xs text-muted tabnum whitespace-nowrap" aria-live="polite">
      {count === total ? `${total.toLocaleString("en-US")} rows` : <><b className="text-foreground font-semibold">{count.toLocaleString("en-US")}</b> of {total.toLocaleString("en-US")} rows</>}
    </span>
  );
  const reset = showReset && hasActive && (
    <button type="button" onClick={onReset} className="btn btn-ghost btn-sm text-bad-fg justify-self-start">
      <FilterX size={13} />
      Reset filters
    </button>
  );
  if (head || actions) {
    // ONE row: what you are looking at (the view, the search), how it is
    // narrowed, and on the right the count and any action. A phone keeps the
    // view and the search in sight and folds the rest behind "Filters".
    return (
      <div className="no-print toolbar toolbar-row">
        {head}
        <PhoneFold active={hasActive}>
          {children}
          {reset}
        </PhoneFold>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {showCount && countText}
          {actions}
        </span>
      </div>
    );
  }
  return (
    // phones get a tidy 2-column grid (search spans the row, filters line up
    // in equal halves); ≥sm it flows as the usual inline bar
    <div className="no-print toolbar toolbar-row grid grid-cols-2 items-end sm:flex sm:items-center">
      {children}
      {showCount && <span className="col-span-2 sm:col-span-1 sm:mr-auto">{countText}</span>}
      {hasActive && <span className={showCount ? "" : "sm:ml-auto"}>{reset}</span>}
    </div>
  );
}
