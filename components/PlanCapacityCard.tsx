import type { PlanCapacityCheck } from "@/lib/server/planCapacity";
import { deptLabel, STAGE_COLOR } from "@/lib/domain/constants";

/* The weekly plan's feasibility, before anyone promises it to the floor:
   standard hours the plan requires per stage vs the stage's capacity over the
   plan's own working days. Server-rendered above the weekly table. */

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");

function loadTone(load: number | null): { bg: string; fg: string; label: string } {
  if (load === null) return { bg: "var(--surface-2)", fg: "var(--muted)", label: "no capacity set" };
  // 0 h/day with hours owed: over capacity, not a percentage
  if (!Number.isFinite(load)) return { bg: "var(--bad-bg)", fg: "var(--bad-fg)", label: "no hours — over capacity" };
  const pct = `${Math.round(load * 100)}%`;
  if (load > 1) return { bg: "var(--bad-bg)", fg: "var(--bad-fg)", label: pct };
  if (load > 0.9) return { bg: "var(--warn-bg)", fg: "var(--warn-fg)", label: pct };
  return { bg: "var(--ok-bg)", fg: "var(--ok-fg)", label: pct };
}

export function PlanCapacityCard({ check }: { check: PlanCapacityCheck | null }) {
  if (!check || check.totalPcs === 0) return null;
  const overloaded = check.stages.filter((s) => (s.load ?? 0) > 1);

  // one row: the title, then one compact chip per stage (needed / capacity,
  // a bar, the load); the pace and the warnings on one quiet line under it
  return (
    <div className="print-keep bg-surface border rounded-[10px] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="leading-tight basis-full sm:basis-auto" title="Standard hours the plan needs vs the stage's capacity over the plan's working days">
          <h2 className="!mb-0">Capacity check</h2>
          <span className="text-[11px] text-muted">{check.workingDays} working day{check.workingDays === 1 ? "" : "s"}</span>
        </div>
        <div className="flex-1 min-w-0 grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))]">
          {check.stages.map((s) => {
            const tone = loadTone(s.load);
            const f = s.load === null ? 0 : Math.min(1, s.load);
            return (
              <div
                key={s.dept}
                className="min-w-0"
                title={`${deptLabel(s.dept)}: the plan needs ${fmt(s.required)} standard hours; capacity over this plan's window is ${s.available === null ? "not set (Admin → Standard Times)" : fmt(s.available) + " hours"}`}
              >
                <div className="flex items-center gap-1.5 text-xs min-w-0">
                  <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: STAGE_COLOR[s.dept === "ShotBlast" ? "Painting" : s.dept] }} aria-hidden />
                  <span className="font-bold truncate">{deptLabel(s.dept)}</span>
                  <span className="tabnum text-muted whitespace-nowrap"><b className="text-foreground">{fmt(s.required)}</b> / {s.available === null ? "—" : fmt(s.available)} h</span>
                  <span className="ms-auto pill tabnum !h-[18px] text-[10px]" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
                </div>
                <div className="mt-1 h-1 rounded-full bg-surface-3 overflow-hidden" aria-hidden>
                  <div className="h-full rounded-full" style={{ width: `${f * 100}%`, background: tone.fg }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {(check.pace || overloaded.length > 0 || check.uncoveredPcs > 0) && (
        <p className="mt-1.5 text-[11px] font-semibold tabnum flex flex-wrap gap-x-4 gap-y-0.5">
          {check.pace && (
            <span
              style={{ color: check.pace.projectedCoverage >= 1 ? "var(--ok-fg)" : check.pace.projectedCoverage >= 0.9 ? "var(--warn-fg)" : "var(--bad-fg)" }}
              title="Projection: the plan's earned standard hours so far, extended over the remaining working days at the same daily rate"
            >
              ⏱ Pace after {check.pace.elapsedWd} of {check.workingDays} working days: at this rate the week closes at {Math.round(check.pace.projectedCoverage * 100)}%
              {check.pace.worstStage && check.pace.worstStage.coverage < 1 && (
                <> — {deptLabel(check.pace.worstStage.dept)} at {Math.round(check.pace.worstStage.coverage * 100)}%</>
              )}
            </span>
          )}
          {overloaded.length > 0 && (
            <span className="text-bad-fg">
              ⚠ Over capacity: {overloaded.map((s) => `${deptLabel(s.dept)} needs ${fmt(s.required - (s.available ?? 0))} h more than the window holds`).join(" · ")}
            </span>
          )}
          {check.uncoveredPcs > 0 && (
            <span className="text-warn-fg font-normal" title="Orders missing an FG code or KVA have no standard time — the required figures undercount the plan">
              ⚠ {check.uncoveredPcs} of {check.totalPcs} pcs have no standard time — the required figures undercount the plan
            </span>
          )}
        </p>
      )}
    </div>
  );
}
