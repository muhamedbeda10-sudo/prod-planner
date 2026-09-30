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
    <div className="print-keep bg-surface border rounded-xl p-3 shadow-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 mb-2">
        <h2 className="text-xs font-extrabold uppercase tracking-wide">Capacity check</h2>
        <span className="text-[11px] text-muted">
          standard hours the plan needs vs the stage&apos;s capacity · {check.workingDays} working day{check.workingDays === 1 ? "" : "s"}
        </span>
      </div>
      {/* one tile per stage, the load as a bar against its capacity */}
      <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {check.stages.map((s) => {
          const tone = loadTone(s.load);
          const f = s.load === null ? 0 : Math.min(1, s.load);
          return (
            <div
              key={s.dept}
              className="rounded-lg border bg-surface-2/60 px-2.5 py-2"
              title={`${deptLabel(s.dept)}: the plan needs ${fmt(s.required)} standard hours; capacity over this plan's window is ${s.available === null ? "not set (Admin → Standard Times)" : fmt(s.available) + " hours"}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLOR[s.dept === "ShotBlast" ? "Painting" : s.dept] }} />
                <span className="text-xs font-bold">{deptLabel(s.dept)}</span>
                <span className="ms-auto pill tabnum text-[10px]" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
              </div>
              <div className="mt-1 tabnum">
                <span className="text-lg font-extrabold">{fmt(s.required)}</span>
                <span className="text-[11px] text-muted font-semibold"> / {s.available === null ? "—" : fmt(s.available)} h</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface overflow-hidden border" aria-hidden>
                <div className="h-full rounded-full" style={{ width: `${f * 100}%`, background: tone.fg }} />
              </div>
            </div>
          );
        })}
      </div>
      {check.pace && (
        <p
          className="mt-2 text-[11px] font-semibold tabnum"
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
