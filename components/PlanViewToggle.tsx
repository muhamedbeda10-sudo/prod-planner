"use client";

import { useRouter, useSearchParams } from "next/navigation";

/** Monthly ↔ Weekly switch for the Plan Tracker, living in the filter bar.
 *  Monthly = the order registry (one row per MO, capped at the order qty);
 *  Weekly = one weekly plan laid out day by day with cumulative progress. */
export function PlanViewToggle({ value }: { value: "monthly" | "weekly" }) {
  const router = useRouter();
  const sp = useSearchParams();

  const go = (v: "monthly" | "weekly") => {
    if (v === value) return;
    const next = new URLSearchParams(sp.toString());
    if (v === "weekly") next.set("view", "weekly");
    else {
      next.delete("view");
      next.delete("plan"); // the plan picker is meaningless on the monthly view
    }
    const qs = next.toString();
    router.push(qs ? `/tracker?${qs}` : "/tracker");
  };

  return (
    <div className="seg" role="group" aria-label="Plan">
      {(["monthly", "weekly"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => go(v)}
          aria-pressed={v === value}
          className={`capitalize ${v === value ? "on" : ""}`}
          title={
            v === "monthly"
              ? "Monthly plan — every order, progress capped at the order quantity"
              : "Weekly plan — one week's promises day by day, cumulative progress"
          }
        >
          {v}
        </button>
      ))}
    </div>
  );
}

/** Which weekly plan to show — newest first, defaulting to the latest. */
export function WeekPlanPicker({ plans, value }: { plans: number[]; value: number | null }) {
  const router = useRouter();
  const sp = useSearchParams();

  return (
    <label className="col-span-2 flex min-w-0 flex-col gap-1 text-sm sm:col-span-1 sm:flex-row sm:items-center sm:gap-1.5">
      <span className="filter-label">Week</span>
      <select
        className="ctl min-w-0 flex-1"
        value={value ?? ""}
        onChange={(e) => {
          const next = new URLSearchParams(sp.toString());
          next.set("view", "weekly");
          next.set("plan", e.target.value);
          router.push(`/tracker?${next.toString()}`);
        }}
      >
        {plans.length === 0 && <option value="">No weekly plans</option>}
        {plans.map((p, i) => (
          <option key={p} value={p}>
            Plan {p}{i === 0 ? " (latest)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
