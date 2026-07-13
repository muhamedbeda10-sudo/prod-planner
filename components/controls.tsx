"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(params.toString());
      if (value) p.set(key, value);
      else p.delete(key);
      router.push(`${pathname}?${p.toString()}`);
    },
    [router, pathname, params]
  );
}

export function PlanPicker({ plans, value }: { plans: number[]; value: number }) {
  const set = useSetParam();
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold">
      Plan:
      <select
        className="border rounded-md px-2 py-1.5 bg-surface font-bold"
        value={value}
        onChange={(e) => set("plan", e.target.value)}
      >
        {plans.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Dashboard period picker: free From/To range (clears the week param). */
export function PeriodFilter({ from, to, active }: { from: string; to: string; active: boolean }) {
  const router = useRouter();
  const pathname = usePathname();

  function apply(f: string, t: string) {
    const p = new URLSearchParams();
    if (f && t) {
      p.set("from", f);
      p.set("to", t);
    }
    router.push(`${pathname}?${p.toString()}`);
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        apply(String(fd.get("from") ?? ""), String(fd.get("to") ?? ""));
      }}
    >
      <span className="text-muted text-xs font-semibold uppercase tracking-wide">Period</span>
      <input name="from" type="date" defaultValue={active ? from : ""} className="border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold" required />
      <span className="text-muted text-xs">→</span>
      <input name="to" type="date" defaultValue={active ? to : ""} className="border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold" required />
      <button type="submit" className="bg-brand hover:bg-brand-dark text-white rounded-md px-3 py-1.5 text-sm font-bold transition-colors">
        Apply
      </button>
      {active && (
        <button type="button" onClick={() => apply("", "")} className="text-xs font-bold text-bad-fg hover:underline">
          Back to weekly ✕
        </button>
      )}
    </form>
  );
}

/** Dashboard filter bar: week (plan) + from/to days. Empty values reset to defaults. */
export function DashboardFilters({
  plans,
  week,
  from,
  to,
}: {
  plans: number[];
  week: "all" | number;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setMany(patch: Record<string, string>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.push(`${pathname}?${p.toString()}`);
  }

  const hasActive = params.get("week") || params.get("from") || params.get("to");

  return (
    <div className="no-print flex flex-wrap items-center gap-3 bg-surface border rounded-xl px-3 py-2.5">
      <label className="inline-flex items-center gap-1.5 text-sm">
        <span className="text-muted text-xs font-semibold uppercase tracking-wide">Week</span>
        <select
          value={week === "all" ? "" : String(week)}
          onChange={(e) => setMany({ week: e.target.value })}
          className="border rounded-md px-2 py-1.5 text-sm bg-surface font-bold"
        >
          <option value="">All weeks (cumulative)</option>
          {[...plans].reverse().map((p) => (
            <option key={p} value={p}>Plan {p}</option>
          ))}
        </select>
      </label>
      <label className="inline-flex items-center gap-1.5 text-sm">
        <span className="text-muted text-xs font-semibold uppercase tracking-wide">From</span>
        <input type="date" value={from} onChange={(e) => setMany({ from: e.target.value })} className="border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold" />
      </label>
      <label className="inline-flex items-center gap-1.5 text-sm">
        <span className="text-muted text-xs font-semibold uppercase tracking-wide">To</span>
        <input type="date" value={to} onChange={(e) => setMany({ to: e.target.value })} className="border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold" />
      </label>
      {hasActive && (
        <button type="button" onClick={() => setMany({ week: "", from: "", to: "" })} className="text-xs font-bold text-bad-fg hover:underline">
          Reset ✕
        </button>
      )}
    </div>
  );
}

export function DayPicker({ value, label = "Day:" }: { value: string; label?: string }) {
  const set = useSetParam();
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold">
      {label}
      <input
        type="date"
        className="border rounded-md px-2 py-1.5 bg-surface font-bold"
        value={value}
        onChange={(e) => set("day", e.target.value)}
      />
    </label>
  );
}
