"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Narrow the dashboard to ONE monthly plan: the plan's completion, the pace,
 * the orders that need a hand, the backlog, the pipeline, the promises and
 * the load read only that plan's orders (closed ones included, as on the
 * tracker's month view). "All plans" is every order, with the completion of
 * the current month's plan.
 */
export function PlanMonthPicker({ plan, months }: { plan: string | null; months: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v === "") p.delete("plan"); else p.set("plan", v);
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  if (months.length === 0) return null;
  return (
    <label className="inline-flex items-center gap-1.5 text-sm" title="Read the dashboard over one monthly plan's orders">
      <span className="text-xs font-bold text-muted uppercase tracking-wide">Plan</span>
      <select
        value={plan ?? ""}
        onChange={(e) => go(e.target.value)}
        aria-label="Monthly plan"
        className={`border rounded-md px-2 py-1.5 bg-surface font-bold text-sm ${plan ? "border-brand text-brand" : ""}`}
      >
        <option value="">All plans</option>
        {months.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}
