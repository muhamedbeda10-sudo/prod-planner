"use client";

import { useCallback, useSyncExternalStore } from "react";
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
export function useSavedFilter(key: string, initial = "") {
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative col-span-2 sm:col-span-1">
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-7 py-1.5 text-sm w-full sm:w-56 [&::-webkit-search-cancel-button]:hidden"
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
      <span className="text-muted text-[10px] sm:text-[11px] font-bold uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 px-2 py-1.5 text-sm font-semibold sm:w-auto"
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
  count,
  total,
  onReset,
  hasActive,
  showCount = true,
}: {
  children: React.ReactNode;
  count: number;
  total: number;
  onReset: () => void;
  hasActive: boolean;
  showCount?: boolean; // worklists hide the row count — the bar stays lean
}) {
  return (
    // phones get a tidy 2-column grid (search spans the row, filters line up
    // in equal halves); ≥sm it flows as the usual inline bar
    <div className="no-print grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2 bg-surface border rounded-xl px-3.5 py-2.5 mb-4">
      {children}
      {showCount && (
        <span className="text-xs text-muted tabnum col-span-2 sm:col-span-1 sm:mr-auto">
          {count === total ? `${total} rows` : `${count} of ${total} rows`}
        </span>
      )}
      {hasActive && (
        <button type="button" onClick={onReset} className={`btn btn-ghost btn-sm text-bad-fg justify-self-start ${showCount ? "" : "sm:ml-auto"}`}>
          <FilterX size={13} />
          Reset filters
        </button>
      )}
    </div>
  );
}
