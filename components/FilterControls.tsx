"use client";

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
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="border rounded-md pl-7 pr-2 py-1.5 text-sm bg-surface w-52 focus:outline-none focus:border-brand"
      />
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-xs">🔍</span>
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground text-xs px-1"
          title="Clear"
        >
          ✕
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
      <span className="text-muted text-xs font-semibold">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold focus:outline-none focus:border-brand"
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
    <div className="no-print flex flex-wrap items-center gap-3 bg-surface border rounded-xl px-3 py-2.5 mb-3">
      {children}
      <span className="text-xs text-muted mr-auto tabnum">
        {count === total ? `${total} rows` : `${count} of ${total} rows`}
      </span>
      {hasActive && (
        <button
          type="button"
          onClick={onReset}
          className="text-xs font-bold text-bad-fg hover:underline"
        >
          Reset filters ✕
        </button>
      )}
    </div>
  );
}
