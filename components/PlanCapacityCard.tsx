import type { PlanCapacityCheck } from "@/lib/server/planCapacity";
import { deptLabel, STAGE_COLOR } from "@/lib/domain/constants";
import { ChartAbout } from "@/components/ChartAbout";
import { Meter } from "@/components/Meter";

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
  // the pace and the warnings are the assistant's to tell ("Ask AI" on the
  // card): the card keeps one row of chips
  const about = [
    "Standard hours the weekly plan needs per stage against the stage's capacity over the plan's own working days.",
    check.pace &&
      `Pace after ${check.pace.elapsedWd} of ${check.workingDays} working days: at the rate so far (earned standard hours extended over the days left) the week closes at ${Math.round(check.pace.projectedCoverage * 100)}%` +
        (check.pace.worstStage && check.pace.worstStage.coverage < 1 ? `, ${deptLabel(check.pace.worstStage.dept)} at ${Math.round(check.pace.worstStage.coverage * 100)}%.` : "."),
    overloaded.length > 0 && `Over capacity: ${overloaded.map((s) => `${deptLabel(s.dept)} needs ${fmt(s.required - (s.available ?? 0))} h more than the window holds`).join("; ")}.`,
    check.uncoveredPcs > 0 && `${check.uncoveredPcs} of ${check.totalPcs} pcs have no standard time (no FG code or KVA), so the required figures undercount the plan.`,
  ].filter(Boolean).join(" ");

  // one row: the title, then one compact chip per stage (needed / capacity,
  // a bar, the load)
  return (
    <div className="print-keep bg-surface border rounded-[10px] px-3 py-2" data-ai-title="Capacity check" data-ai-about={about}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="leading-tight basis-full sm:basis-auto">
          <h2 className="!mb-0"><ChartAbout title="Capacity check" about={about} /></h2>
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
                  <span className="ms-auto pill tabnum !h-[18px] text-[11px]" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
                </div>
                <Meter value={f} color={tone.fg} size="sm" className="mt-1" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
