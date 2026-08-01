"use client";

import { useMemo, useState } from "react";
import {
  simulate, defaultScenario, WI_STAGES,
  type WhatIfInputs, type Scenario, type WiStage,
} from "@/lib/domain/whatif";
import { deptLabel, STAGE_COLOR } from "@/lib/domain/constants";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";

/* The sandbox: turn the knobs — extra workers per stage, working Fridays,
   a hand-reordered queue — and watch the week's load and every order's ETA
   move, instantly, with the SAME arithmetic the live pages use. Nothing here
   is saved; it answers "what should I do today?" before anyone commits. */

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");
const dd = (iso: string | null) => (iso ? toDisplayDate(parseISODate(iso)!) : "—");

function loadTone(load: number | null): { bg: string; fg: string; label: string } {
  if (load === null) return { bg: "var(--surface-2)", fg: "var(--muted)", label: "no capacity" };
  const pct = `${Math.round(load * 100)}%`;
  if (load > 1) return { bg: "var(--bad-bg)", fg: "var(--bad-fg)", label: pct };
  if (load > 0.9) return { bg: "var(--warn-bg)", fg: "var(--warn-fg)", label: pct };
  return { bg: "var(--ok-bg)", fg: "var(--ok-fg)", label: pct };
}

export function WhatIfSimulator({ inputs }: { inputs: WhatIfInputs }) {
  const [scenario, setScenario] = useState<Scenario>(() => defaultScenario(inputs));
  const result = useMemo(() => simulate(inputs, scenario), [inputs, scenario]);

  const touched =
    scenario.workFridays ||
    WI_STAGES.some((s) => scenario.workersDelta[s] !== 0) ||
    scenario.queue.some((id, i) => inputs.orders[i]?.id !== id);

  const bumpWorkers = (s: WiStage, d: number) =>
    setScenario((sc) => ({ ...sc, workersDelta: { ...sc.workersDelta, [s]: sc.workersDelta[s] + d } }));

  const moveOrder = (id: string, dir: -1 | 1) =>
    setScenario((sc) => {
      const q = [...sc.queue];
      const i = q.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= q.length) return sc;
      [q[i], q[j]] = [q[j], q[i]];
      return { ...sc, queue: q };
    });

  return (
    <div className="space-y-4">
      {/* ================= the knobs ================= */}
      <div className="bg-surface border rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {WI_STAGES.map((s) => {
            const delta = scenario.workersDelta[s];
            const base = inputs.capacity[s];
            const now = base !== undefined ? Math.max(0, base + delta * scenario.shiftHours) : undefined;
            return (
              <div key={s} className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLOR[s === "ShotBlast" ? "Painting" : s] }} />
                <span className="text-sm font-bold">{deptLabel(s)}</span>
                <span className="inline-flex items-center border rounded-lg overflow-hidden">
                  <button onClick={() => bumpWorkers(s, -1)} className="px-2.5 py-1 text-sm font-bold hover:bg-surface-2" title="one worker fewer">−</button>
                  <span className={`px-2 py-1 text-sm font-extrabold tabnum min-w-11 text-center ${delta > 0 ? "text-ok-fg" : delta < 0 ? "text-bad-fg" : "text-muted"}`}>
                    {delta > 0 ? `+${delta}` : delta} <span className="font-normal text-[10px]">wkr</span>
                  </span>
                  <button onClick={() => bumpWorkers(s, +1)} className="px-2.5 py-1 text-sm font-bold hover:bg-surface-2" title="one worker more">+</button>
                </span>
                {base !== undefined && (
                  <span className="text-[10px] text-muted tabnum whitespace-nowrap">
                    {fmt(base)}{delta !== 0 && <> → <b className={delta > 0 ? "text-ok-fg" : "text-bad-fg"}>{fmt(now!)}</b></>} h/day
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 pt-2.5 border-t">
          <label className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <span className="text-muted text-[11px] font-bold uppercase tracking-wide">Hours / worker / day</span>
            <input
              type="number" min={1} max={24} step="0.5"
              value={scenario.shiftHours}
              onChange={(e) => setScenario((sc) => ({ ...sc, shiftHours: Math.max(1, Number(e.target.value) || 1) }))}
              className="w-16 border rounded-md px-2 py-1 text-center tabnum bg-surface"
            />
          </label>
          <label className="inline-flex items-center gap-1.5 text-sm font-semibold cursor-pointer">
            <input
              type="checkbox"
              checked={scenario.workFridays}
              onChange={(e) => setScenario((sc) => ({ ...sc, workFridays: e.target.checked }))}
              className="accent-[var(--brand)]"
            />
            Work Fridays
          </label>
          {touched && (
            <button onClick={() => setScenario(defaultScenario(inputs))} className="btn btn-ghost btn-sm ml-auto">
              ↺ Reset to reality
            </button>
          )}
        </div>
      </div>

      {/* ================= the week under this scenario ================= */}
      {inputs.plan && (
        <div className="bg-surface border rounded-xl px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Weekly plan {inputs.plan.planNo}
              <span className="block normal-case font-normal text-[10px]">
                {result.planWorkingDays} working day{result.planWorkingDays === 1 ? "" : "s"} under this scenario
              </span>
            </div>
            {result.stages.map((s) => {
              const tone = loadTone(s.load);
              const changed = s.available !== s.baselineAvailable;
              return (
                <div key={s.dept} className="flex items-center gap-1.5" title={`${deptLabel(s.dept)}: the plan needs ${fmt(s.required)} std hours; this scenario offers ${s.available === null ? "no figure" : fmt(s.available) + " hours"} over the window`}>
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLOR[s.dept === "ShotBlast" ? "Painting" : s.dept] }} />
                  <span className="text-sm font-semibold text-muted">{deptLabel(s.dept)}</span>
                  <span className="text-sm font-extrabold tabnum">{fmt(s.required)}</span>
                  <span className="text-[10px] text-muted tabnum">
                    / {s.available === null ? "—" : fmt(s.available)} h{changed && s.baselineAvailable !== null && <> (was {fmt(s.baselineAvailable)})</>}
                  </span>
                  <span className="pill tabnum" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ================= every order under this scenario ================= */}
      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-center">
              <th className="p-2 w-20">Queue</th>
              <th className="p-2 text-left">BOM</th>
              <th className="p-2 text-left">MO</th>
              <th className="p-2">Due</th>
              <th className="p-2">ETA now</th>
              <th className="p-2">ETA if…</th>
              <th className="p-2">Shift</th>
            </tr>
          </thead>
          <tbody>
            {result.orders.length === 0 && (
              <tr><td colSpan={7} className="p-4 text-center text-muted">No open orders to simulate.</td></tr>
            )}
            {result.orders.map((o, i) => (
              <tr key={o.id} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-1.5 text-center whitespace-nowrap">
                  <button onClick={() => moveOrder(o.id, -1)} disabled={i === 0} className="px-1.5 text-accent font-bold disabled:opacity-20" title="work it sooner">↑</button>
                  <span className="tabnum text-xs text-muted">{i + 1}</span>
                  <button onClick={() => moveOrder(o.id, +1)} disabled={i === result.orders.length - 1} className="px-1.5 text-accent font-bold disabled:opacity-20" title="work it later">↓</button>
                </td>
                <td className="p-2 font-bold whitespace-nowrap">{o.bom}</td>
                <td className="p-2 text-xs text-muted whitespace-nowrap">{o.id}</td>
                <td className="p-2 text-center tabnum whitespace-nowrap">{dd(o.dueISO)}</td>
                <td className="p-2 text-center tabnum whitespace-nowrap">
                  {o.done ? <span className="text-ok-fg font-bold">✓ done</span> : o.baselineISO ? dd(o.baselineISO) : <span title="a stage this order needs has no recent history">?</span>}
                </td>
                <td className="p-2 text-center tabnum whitespace-nowrap font-bold">
                  {o.done ? (
                    <span className="text-ok-fg">✓</span>
                  ) : o.blockedBy ? (
                    <span className="text-muted" title="a stage this order needs has no recent history">?</span>
                  ) : (
                    <span style={{ color: o.late ? "var(--bad-fg)" : o.deltaDays < 0 ? "var(--ok-fg)" : undefined }}>
                      {o.late && "⚠ "}{dd(o.etaISO)}
                    </span>
                  )}
                </td>
                <td className="p-2 text-center whitespace-nowrap">
                  {!o.done && !o.blockedBy && o.deltaDays !== 0 && (
                    <span className="pill tabnum" style={o.deltaDays < 0 ? { background: "var(--ok-bg)", color: "var(--ok-fg)" } : { background: "var(--bad-bg)", color: "var(--bad-fg)" }}>
                      {o.deltaDays < 0 ? `${-o.deltaDays}d sooner` : `${o.deltaDays}d later`}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted">
        A sandbox — nothing here is saved or promised. Rates come from what the plant actually produced over the last {inputs.rateWindowDays} working
        days; adding workers scales a stage&apos;s speed in proportion to its capacity figure (Admin → Standard Times). ETAs assume the queue is worked
        top-down: moving an order up pushes everything it overtakes back.
      </p>
    </div>
  );
}
