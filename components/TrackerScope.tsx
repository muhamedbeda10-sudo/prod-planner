"use client";

import { X } from "lucide-react";

export interface TrackerFilter {
  key: string;
  label: string;
  value: string;
  onClear: () => void;
}

/** The scope stays visible even when a phone's filter controls are folded. */
export function TrackerScope({ count, total, basis, filters, onReset }: {
  count: number;
  total: number;
  basis: string;
  filters: TrackerFilter[];
  onReset: () => void;
}) {
  return (
    <div className="tracker-scope mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-xs text-muted" aria-live="polite" aria-atomic="true">
        Progress for <strong className="text-foreground tabnum">{count.toLocaleString("en-US")}</strong>
        {count !== total && <> of {total.toLocaleString("en-US")}</>} orders
        <span className="mx-1.5" aria-hidden>·</span>{basis}
      </p>
      {filters.length > 0 && (
        <div role="group" aria-label="Active tracker filters" className="no-print flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          {filters.map((filter) => (
            <button
              key={filter.key} type="button" className="tracker-filter"
              onClick={filter.onClear} aria-label={`Clear ${filter.label}: ${filter.value}`}
              title={`${filter.label}: ${filter.value} — click to clear`}
            >
              <span className="truncate"><span className="font-normal">{filter.label}:</span> {filter.value}</span>
              <X size={12} className="shrink-0" aria-hidden />
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Clear all</button>
        </div>
      )}
    </div>
  );
}
