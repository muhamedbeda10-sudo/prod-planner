"use client";

import { Search, X, FilterX } from "lucide-react";

/** Small consistent filter controls used by the filterable tables. */

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
    <div className="relative">
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-7 py-1.5 text-sm w-56 max-w-full [&::-webkit-search-cancel-button]:hidden"
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
    <label className="inline-flex items-center gap-1.5 text-sm">
      <span className="text-muted text-[11px] font-bold uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1.5 text-sm font-semibold"
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
}: {
  children: React.ReactNode;
  count: number;
  total: number;
  onReset: () => void;
  hasActive: boolean;
}) {
  return (
    <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-2 bg-surface border rounded-xl px-3.5 py-2.5 mb-4">
      {children}
      <span className="text-xs text-muted mr-auto tabnum">
        {count === total ? `${total} rows` : `${count} of ${total} rows`}
      </span>
      {hasActive && (
        <button type="button" onClick={onReset} className="btn btn-ghost btn-sm text-bad-fg">
          <FilterX size={13} />
          Reset filters
        </button>
      )}
    </div>
  );
}
