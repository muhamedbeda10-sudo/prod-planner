"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useLineKey } from "@/components/LineContext";
import { Search, X, FilterX } from "lucide-react";

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
    <div className="relative col-span-2 sm:col-span-1">
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
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-1.5">
      <span className="filter-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`ctl w-full min-w-0 sm:w-auto sm:max-w-[13rem] ${value ? "!border-brand" : ""}`}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
}) {
  const countText = (
    <span className="text-xs text-muted tabnum whitespace-nowrap" aria-live="polite">
      {count === total ? `${total.toLocaleString("en-US")} rows` : <><b className="text-foreground font-semibold">{count.toLocaleString("en-US")}</b> of {total.toLocaleString("en-US")} rows</>}
    </span>
  );
  const reset = hasActive && (
    <button type="button" onClick={onReset} className="btn btn-ghost btn-sm text-bad-fg justify-self-start">
      <FilterX size={13} />
      Reset filters
    </button>
  );
  if (head || actions) {
    // two rows in one surface: what you are looking at (view, search, the
    // count and the page's actions), then how it is narrowed
    return (
      <div className="no-print toolbar">
        <div className="toolbar-row">
          {head}
          <span className="sm:ml-auto flex flex-wrap items-center gap-2">
            {showCount && countText}
            {actions}
          </span>
        </div>
        <div className="toolbar-row grid grid-cols-2 items-end sm:flex sm:items-center">
          {children}
          {reset}
        </div>
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
