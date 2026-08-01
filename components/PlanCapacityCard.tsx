import type { PlanCapacityCheck } from "@/lib/server/planCapacity";
import { deptLabel, STAGE_COLOR } from "@/lib/domain/constants";

/* The weekly plan's feasibility, before anyone promises it to the floor:
   standard hours the plan requires per stage vs the stage's capacity over the
   plan's own working days. Server-rendered above the weekly table. */

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");

function loadTone(load: number | null): { bg: string; fg: string; label: string } {
  if (load === null) return { bg: "var(--surface-2)", fg: "var(--muted)", label: "no capacity set" };
  const pct = `${Math.round(load * 100)}%`;
  if (load > 1) return { bg: "var(--bad-bg)", fg: "var(--bad-fg)", label: pct };
  if (load > 0.9) return { bg: "var(--warn-bg)", fg: "var(--warn-fg)", label: pct };
  return { bg: "var(--ok-bg)", fg: "var(--ok-fg)", label: pct };
}

export function PlanCapacityCard({ check }: { check: PlanCapacityCheck | null }) {
  if (!check || check.totalPcs === 0) return null;
  const overloaded = check.stages.filter((s) => (s.load ?? 0) > 1);

  return (
    <div className="print-keep bg-surface border rounded-xl px-3.5 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
          Capacity check
          <span className="block normal-case font-normal text-[10px]">
            std hours vs capacity · {check.workingDays} working day{check.workingDays === 1 ? "" : "s"}
          </span>
        </div>
        {check.stages.map((s) => {
          const tone = loadTone(s.load);
          return (
            <div key={s.dept} className="flex items-center gap-1.5" title={`${deptLabel(s.dept)}: the plan needs ${fmt(s.required)} standard hours; capacity over this plan's window is ${s.available === null ? "not set (Admin → Standard Times)" : fmt(s.available) + " hours"}`}>
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLOR[s.dept === "ShotBlast" ? "Painting" : s.dept] }} />
              <span className="text-sm font-semibold text-muted">{deptLabel(s.dept)}</span>
              <span className="text-sm font-extrabold tabnum">{fmt(s.required)}</span>
              <span className="text-[10px] text-muted tabnum">/ {s.available === null ? "—" : fmt(s.available)} h</span>
              <span className="pill tabnum" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
            </div>
          );
        })}
      </div>
      {check.pace && (
        <p
          className="mt-1.5 text-[11px] font-semibold tabnum"
          style={{ color: check.pace.projectedCoverage >= 1 ? "var(--ok-fg)" : check.pace.projectedCoverage >= 0.9 ? "var(--warn-fg)" : "var(--bad-fg)" }}
          title="Projection: the plan's earned standard hours so far, extended over the remaining working days at the same daily rate"
        >
          ⏱ Pace after {check.pace.elapsedWd} of {check.workingDays} working days: at this rate the week closes at {Math.round(check.pace.projectedCoverage * 100)}%
          {check.pace.worstStage && check.pace.worstStage.coverage < 1 && (
            <> — {deptLabel(check.pace.worstStage.dept)} at {Math.round(check.pace.worstStage.coverage * 100)}%</>
          )}
        </p>
      )}
      {overloaded.length > 0 && (
        <p className="mt-1.5 text-[11px] font-semibold text-bad-fg">
          ⚠ Over capacity: {overloaded.map((s) => `${deptLabel(s.dept)} needs ${fmt(s.required - (s.available ?? 0))} h more than the window holds`).join(" · ")}
        </p>
      )}
      {check.uncoveredPcs > 0 && (
        <p className="mt-1 text-[11px] text-warn-fg">
          ⚠ {check.uncoveredPcs} of {check.totalPcs} pcs have no standard time (order missing FG code / KVA) — the required figures UNDERCOUNT the plan.
        </p>
      )}
    </div>
  );
}
