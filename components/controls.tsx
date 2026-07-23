"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/** Remembers the dashboard's From→To range across sessions (localStorage, so
 *  it survives closing the browser). Opening the dashboard bare restores the
 *  last range; "Back to weekly ✕" (or any switch out of range mode) forgets
 *  it. Renders nothing. */
export function DashboardPeriodMemory() {
  const router = useRouter();
  const sp = useSearchParams();
  const didInit = useRef(false);
  useEffect(() => {
    const from = sp.get("from");
    const to = sp.get("to");
    const cur = from && to ? `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "";
    try {
      if (!didInit.current) {
        // entry: a bare dashboard gets the remembered range; an explicit URL
        // (?w=… or ?from=…) is respected as-is
        didInit.current = true;
        if (cur) {
          localStorage.setItem("dash.period", cur);
        } else if (!sp.get("w")) {
          const saved = localStorage.getItem("dash.period");
          if (saved) router.replace(`/?${saved}`);
        }
        return;
      }
      // in-app change: keep the latest range, forget it when leaving range mode
      if (cur) localStorage.setItem("dash.period", cur);
      else localStorage.removeItem("dash.period");
    } catch {}
  }, [sp, router]);
  return null;
}

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
    // phones: label on its own line, then from → to · Apply in ONE aligned row
    // (equal-width date fields); ≥sm it flows inline as before
    <form
      className="grid w-full grid-cols-[1fr_auto_1fr_auto] items-center gap-2 sm:flex sm:w-auto sm:flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        apply(String(fd.get("from") ?? ""), String(fd.get("to") ?? ""));
      }}
    >
      <span className="col-span-4 sm:col-span-1 text-muted text-[10px] sm:text-xs font-bold sm:font-semibold uppercase tracking-wide">Period</span>
      <input name="from" type="date" defaultValue={active ? from : ""} className="w-full min-w-0 border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold sm:w-auto" required />
      <span className="text-muted text-xs">→</span>
      <input name="to" type="date" defaultValue={active ? to : ""} className="w-full min-w-0 border rounded-md px-2 py-1.5 text-sm bg-surface font-semibold sm:w-auto" required />
      <button type="submit" className="btn btn-primary btn-sm">
        Apply
      </button>
      {active && (
        <button type="button" onClick={() => apply("", "")} className="col-span-4 sm:col-span-1 justify-self-start text-xs font-bold text-bad-fg hover:underline">
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

/** Report department filter: MULTI-select toggle pills — scope every report
 *  section to any combination of stages (Painting includes the core's Shot
 *  Blast). No selection = all stages. The picked set is stored as a CSV in
 *  ?dept= (pipeline order, whatever the click order). */
const DEPT_OPTS = [
  { value: "Cut", label: "Fabrication" },
  { value: "Welding", label: "Welding" },
  { value: "Painting", label: "Painting" },
  { value: "Delivered", label: "Delivered" },
] as const;

export function DeptPicker({ value }: { value: string }) {
  const set = useSetParam();
  const selected = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    set("dept", DEPT_OPTS.map((o) => o.value).filter((x) => next.has(x)).join(","));
  };
  return (
    <div className="inline-flex items-center gap-2 text-sm font-semibold">
      <span>Dept:</span>
      <div className="flex flex-wrap gap-1">
        {DEPT_OPTS.map((o) => {
          const on = selected.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className={`rounded-md border px-2.5 py-1.5 text-xs font-bold transition-colors ${on ? "bg-brand text-white border-brand" : "bg-surface text-muted hover:text-foreground hover:border-brand/60"}`}
              title={`${o.label}${o.value === "Painting" ? " (includes Shot Blast)" : ""} — pick one or more; the whole report scopes to them`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Report table switcher: full plan (default) or one week's snapshot. */
export function WeekSnapshotPicker({ plans, value }: { plans: number[]; value: string }) {
  const set = useSetParam();
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold">
      Table:
      <select
        className="border rounded-md px-2 py-1.5 bg-surface font-bold"
        value={value}
        onChange={(e) => set("week", e.target.value)}
      >
        <option value="">Full plan (all orders)</option>
        {[...plans].reverse().map((p) => (
          <option key={p} value={String(p)}>
            Week snapshot — Plan {p}
          </option>
        ))}
      </select>
    </label>
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
