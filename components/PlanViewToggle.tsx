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

/** Which weekly plan to show — newest first, defaulting to the latest. On
 *  the Plan Tracker by default; `basePath` keeps another page (the
 *  fabrication worklist) on itself with only ?plan= changed. */
export function WeekPlanPicker({ plans, value, basePath }: { plans: number[]; value: number | null; basePath?: string }) {
  const router = useRouter();
  const sp = useSearchParams();

  return (
    <span className="filter-chip">
      <select
        aria-label="Week"
        className="ctl"
        value={value ?? ""}
        onChange={(e) => {
          const next = new URLSearchParams(sp.toString());
          next.set("plan", e.target.value);
          if (basePath) {
            router.push(`${basePath}?${next.toString()}`);
            return;
          }
          next.set("view", "weekly");
          router.push(`/tracker?${next.toString()}`);
        }}
      >
        {plans.length === 0 && <option value="">Week: No weekly plans</option>}
        {plans.map((p, i) => (
          <option key={p} value={p}>Week: Plan {p}{i === 0 ? " (latest)" : ""}
          </option>
        ))}
      </select>
    </span>
  );
}
