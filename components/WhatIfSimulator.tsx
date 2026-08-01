"use client";

import { useMemo, useRef, useState } from "react";
import {
  simulate, defaultScenario, dateForOffsetISO, WI_STAGES,
  type WhatIfInputs, type Scenario, type WiStage, type WhatIfResult,
} from "@/lib/domain/whatif";
import { deptLabel, STAGE_COLOR } from "@/lib/domain/constants";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";

/* The control room: turn the knobs — workers per stage, working Fridays, a
   hand-reordered (drag & drop) queue — and the KPIs, the station timeline and
   every ETA respond instantly, with the SAME arithmetic the live pages use.
   Nothing here is saved; it answers "what should I do today?" before anyone
   commits to anything. */

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");
const dd = (iso: string | null) => (iso ? toDisplayDate(parseISODate(iso)!) : "—");
const ddShort = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const SEG_COLOR: Record<string, string> = {
  cut: STAGE_COLOR.Cut,
  weld: STAGE_COLOR.Welding,
  finish: STAGE_COLOR.Painting,
};
const SEG_LABEL: Record<string, string> = { cut: "Fabrication", weld: "Welding", finish: "Paint & Shot Blast" };

function loadTone(load: number | null): { bg: string; fg: string; label: string } {
  if (load === null) return { bg: "var(--surface-2)", fg: "var(--muted)", label: "—" };
  const pct = `${Math.round(load * 100)}%`;
  if (load > 1) return { bg: "var(--bad-bg)", fg: "var(--bad-fg)", label: pct };
  if (load > 0.9) return { bg: "var(--warn-bg)", fg: "var(--warn-fg)", label: pct };
  return { bg: "var(--ok-bg)", fg: "var(--ok-fg)", label: pct };
}

/* ================================ KPI strip ================================ */

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "ok" ? "var(--ok-fg)" : tone === "warn" ? "var(--warn-fg)" : tone === "bad" ? "var(--bad-fg)" : undefined;
  return (
    <div className="flex-1 min-w-40 bg-surface border rounded-xl px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className="text-2xl font-extrabold tabnum leading-tight" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* ================================ timeline ================================ */

function Timeline({ result, baseline, inputs, workFridays }: {
  result: WhatIfResult;
  baseline: WhatIfResult;
  inputs: WhatIfInputs;
  workFridays: boolean;
}) {
  const holidays = useMemo(() => new Set(inputs.holidayISOs), [inputs.holidayISOs]);
  const rows = result.orders.filter((o) => o.segments.length > 0);
  const baseEnd = new Map(baseline.orders.map((o) => [o.id, o.segments.length ? o.segments[o.segments.length - 1].end : null]));
  if (rows.length === 0) return null;

  const PX = 34; // px per working day
  const axisDays = Math.max(1, Math.ceil(Math.max(result.makespan, ...rows.map((o) => o.dueOffset ?? 0))) + 1);
  const tickEvery = axisDays <= 16 ? 1 : Math.ceil(axisDays / 14);
  const width = axisDays * PX;

  return (
    <section className="bg-surface border rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 pb-1.5">
        <h2 className="text-sm">Station timeline</h2>
        <span className="text-[10px] text-muted">each bar = one station holding the order · the axis counts WORKING days</span>
        <span className="flex items-center gap-3 ml-auto text-[10px] text-muted">
          {Object.entries(SEG_LABEL).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SEG_COLOR[k] }} />{label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1"><span className="text-bad-fg font-bold">▼</span>due</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="relative ml-44" style={{ width, minHeight: rows.length * 30 + 34 }}>
          {/* day grid + date ticks */}
          {Array.from({ length: axisDays + 1 }, (_, i) => (
            <div key={i} className="absolute top-0 bottom-0 border-l" style={{ left: i * PX, borderColor: "var(--border)", opacity: i % tickEvery ? 0.25 : 0.7 }}>
              {i % tickEvery === 0 && i < axisDays && (
                <span className="absolute top-0.5 left-1 text-[9px] text-muted tabnum whitespace-nowrap">
                  {ddShort(dateForOffsetISO(i + 1, inputs.todayISO, holidays, workFridays))}
                </span>
              )}
            </div>
          ))}
          {/* order rows */}
          {rows.map((o, r) => {
            const top = 24 + r * 30;
            const end = o.segments[o.segments.length - 1].end;
            const bEnd = baseEnd.get(o.id);
            return (
              <div key={o.id}>
                {/* label (escapes the scroll area into the reserved left margin) */}
                <div className="absolute -ml-44 w-40 pr-2 text-right whitespace-nowrap overflow-hidden text-ellipsis" style={{ top: top + 2 }}>
                  <span className="text-xs font-bold">{o.bom}</span>
                  <span className="text-[9px] text-muted ml-1">{o.id}</span>
                </div>
                {/* baseline ghost — where this order ends TODAY, before the knobs */}
                {bEnd !== null && bEnd !== undefined && Math.abs(bEnd - end) > 0.05 && (
                  <div
                    className="absolute h-1 rounded-full opacity-40"
                    style={{ top: top + 19, left: 0, width: bEnd * PX, background: "var(--muted)" }}
                    title={`baseline: clears in ${fmt(bEnd)} working days`}
                  />
                )}
                {o.segments.map((s, i) => (
                  <div
                    key={i}
                    className="absolute h-4 rounded"
                    style={{ top: top + 3, left: s.start * PX, width: Math.max(2, (s.end - s.start) * PX), background: SEG_COLOR[s.stage] }}
                    title={`${SEG_LABEL[s.stage]}: day ${fmt(s.start)} → ${fmt(s.end)} (${fmt(s.end - s.start)} wd)`}
                  />
                ))}
                {/* the finish flag */}
                <span
                  className="absolute text-[9px] font-bold tabnum whitespace-nowrap"
                  style={{ top: top + 4, left: end * PX + 4, color: o.late ? "var(--bad-fg)" : "var(--muted)" }}
                >
                  {o.late && "⚠ "}{dd(o.etaISO)}
                </span>
                {/* due marker */}
                {o.dueOffset !== null && o.dueOffset > 0 && (
                  <span className="absolute text-bad-fg font-bold text-[10px]" style={{ top: top - 1, left: o.dueOffset * PX - 4 }} title={`due ${dd(o.dueISO)}`}>
                    ▼
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ================================ the page ================================ */

export function WhatIfSimulator({ inputs }: { inputs: WhatIfInputs }) {
  const [scenario, setScenario] = useState<Scenario>(() => defaultScenario(inputs));
  const result = useMemo(() => simulate(inputs, scenario), [inputs, scenario]);
  const baseline = useMemo(() => simulate(inputs, defaultScenario(inputs)), [inputs]);

  const touched =
    scenario.workFridays ||
    scenario.shiftHours !== 11 ||
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

  // ---- drag & drop on the queue ----
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const dropOn = (targetId: string) => {
    const src = dragId.current;
    dragId.current = null;
    setDragOver(null);
    if (!src || src === targetId) return;
    setScenario((sc) => {
      const q = sc.queue.filter((x) => x !== src);
      q.splice(q.indexOf(targetId), 0, src);
      return { ...sc, queue: q };
    });
  };

  // ---- KPIs ----
  const active = result.orders.filter((o) => !o.done && !o.blockedBy);
  const lateNow = active.filter((o) => o.late).length;
  const lateBase = baseline.orders.filter((o) => !o.done && !o.blockedBy && o.baselineISO && o.dueISO && o.baselineISO > o.dueISO).length;
  const onTime = active.length - lateNow;
  const lastEta = active.reduce<string | null>((m, o) => (o.etaISO && (!m || o.etaISO > m) ? o.etaISO : m), null);
  const lastBase = baseline.orders.reduce<string | null>((m, o) => (o.baselineISO && (!m || o.baselineISO > m) ? o.baselineISO : m), null);
  const clearDelta = lastEta && lastBase ? Math.round((Date.parse(lastEta) - Date.parse(lastBase)) / 86400000) : 0;
  const worst = result.stages.filter((s) => s.required > 0 && s.load !== null).reduce<(typeof result.stages)[number] | null>(
    (w, s) => (!w || s.load! > w.load! ? s : w), null);
  const addedMh = WI_STAGES.reduce((a, s) => a + scenario.workersDelta[s] * scenario.shiftHours, 0);

  return (
    <div className="space-y-4">
      {/* ================= KPI strip ================= */}
      <div className="flex flex-wrap gap-3">
        <Kpi
          label="Orders on time"
          value={`${onTime} / ${active.length}`}
          tone={lateNow === 0 ? "ok" : lateNow > lateBase ? "bad" : lateNow < lateBase ? "ok" : "warn"}
          sub={lateNow === lateBase ? `${lateNow} late — same as today` : lateNow < lateBase ? `▲ ${lateBase - lateNow} rescued vs today` : `▼ ${lateNow - lateBase} MORE late than today`}
        />
        <Kpi
          label="All orders clear by"
          value={lastEta ? dd(lastEta) : "—"}
          tone={clearDelta < 0 ? "ok" : clearDelta > 0 ? "bad" : undefined}
          sub={clearDelta === 0 ? "same as today" : clearDelta < 0 ? `▲ ${-clearDelta} calendar days earlier` : `▼ ${clearDelta} calendar days later`}
        />
        <Kpi
          label="Worst station load"
          value={worst?.load != null ? `${Math.round(worst.load * 100)}%` : "—"}
          tone={worst?.load != null ? (worst.load > 1 ? "bad" : worst.load > 0.9 ? "warn" : "ok") : undefined}
          sub={worst ? `${deptLabel(worst.dept)} · weekly plan ${inputs.plan?.planNo ?? ""}` : "no weekly plan"}
        />
        <Kpi
          label="Scenario cost"
          value={addedMh === 0 ? "±0" : `${addedMh > 0 ? "+" : ""}${fmt(addedMh)} mh/day`}
          tone={addedMh > 0 ? "warn" : undefined}
          sub={touched ? "scenario active — nothing is saved" : "reality — no knobs turned"}
        />
      </div>

      {/* ================= control panel ================= */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {WI_STAGES.map((s) => {
          const delta = scenario.workersDelta[s];
          const base = inputs.capacity[s];
          const now = base !== undefined ? Math.max(0, base + delta * scenario.shiftHours) : undefined;
          return (
            <div key={s} className="bg-surface border rounded-xl overflow-hidden">
              <div className="h-1" style={{ background: STAGE_COLOR[s === "ShotBlast" ? "Painting" : s] }} />
              <div className="px-3.5 py-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-bold">{deptLabel(s)}</span>
                  <span className="text-[10px] text-muted tabnum">
                    {base === undefined ? "no capacity set" : delta === 0 ? `${fmt(base)} h/day` : <><s className="opacity-60">{fmt(base)}</s> <b style={{ color: delta > 0 ? "var(--ok-fg)" : "var(--bad-fg)" }}>{fmt(now!)}</b> h/day</>}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Workers</span>
                  <span className="inline-flex items-center border rounded-lg overflow-hidden">
                    <button onClick={() => bumpWorkers(s, -1)} className="px-3 py-1 text-sm font-bold hover:bg-surface-2 active:bg-surface-2" title="one worker fewer">−</button>
                    <span className={`px-1.5 py-1 text-sm font-extrabold tabnum min-w-10 text-center ${delta > 0 ? "text-ok-fg" : delta < 0 ? "text-bad-fg" : "text-muted"}`}>
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                    <button onClick={() => bumpWorkers(s, +1)} className="px-3 py-1 text-sm font-bold hover:bg-surface-2 active:bg-surface-2" title="one worker more">+</button>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {/* the settings card */}
        <div className="bg-surface border rounded-xl overflow-hidden">
          <div className="h-1 bg-brand" />
          <div className="px-3.5 py-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Hours / worker / day</span>
              <input
                type="number" min={1} max={24} step="0.5"
                value={scenario.shiftHours}
                onChange={(e) => setScenario((sc) => ({ ...sc, shiftHours: Math.max(1, Number(e.target.value) || 1) }))}
                className="w-16 border rounded-md px-2 py-0.5 text-center tabnum bg-surface text-sm"
              />
            </div>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Work Fridays</span>
              <input
                type="checkbox"
                checked={scenario.workFridays}
                onChange={(e) => setScenario((sc) => ({ ...sc, workFridays: e.target.checked }))}
                className="accent-[var(--brand)] w-4 h-4"
              />
            </label>
            <button
              onClick={() => setScenario(defaultScenario(inputs))}
              disabled={!touched}
              className="btn btn-secondary btn-sm w-full disabled:opacity-40"
            >
              ↺ Reset to reality
            </button>
          </div>
        </div>
      </div>

      {/* ================= weekly plan load ================= */}
      {inputs.plan && (
        <div className="bg-surface border rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
            Weekly plan {inputs.plan.planNo}
            <span className="block normal-case font-normal text-[10px]">{result.planWorkingDays} working day{result.planWorkingDays === 1 ? "" : "s"} under this scenario</span>
          </div>
          {result.stages.map((s) => {
            const tone = loadTone(s.load);
            const changed = s.available !== s.baselineAvailable;
            return (
              <div key={s.dept} className="flex items-center gap-1.5" title={`${deptLabel(s.dept)}: the plan needs ${fmt(s.required)} std hours; this scenario offers ${s.available === null ? "no figure" : fmt(s.available) + " hours"} over the window`}>
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLOR[s.dept === "ShotBlast" ? "Painting" : s.dept] }} />
                <span className="text-sm font-semibold text-muted">{deptLabel(s.dept)}</span>
                <span className="text-sm font-extrabold tabnum">{fmt(s.required)}</span>
                <span className="text-[10px] text-muted tabnum">/ {s.available === null ? "—" : fmt(s.available)} h{changed && s.baselineAvailable !== null && <> (was {fmt(s.baselineAvailable)})</>}</span>
                <span className="pill tabnum" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ================= timeline ================= */}
      <Timeline result={result} baseline={baseline} inputs={inputs} workFridays={scenario.workFridays} />

      {/* ================= queue ================= */}
      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-center">
              <th className="p-2 w-24 text-left" title="drag rows (or use the arrows) to change who gets worked first">Queue</th>
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
              <tr
                key={o.id}
                draggable
                onDragStart={(e) => { dragId.current = o.id; e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOver !== o.id) setDragOver(o.id); }}
                onDragLeave={() => dragOver === o.id && setDragOver(null)}
                onDrop={(e) => { e.preventDefault(); dropOn(o.id); }}
                onDragEnd={() => { dragId.current = null; setDragOver(null); }}
                className={`${i % 2 ? "bg-zebra" : ""} cursor-grab active:cursor-grabbing`}
                style={dragOver === o.id ? { boxShadow: "inset 0 2px 0 var(--brand)" } : undefined}
              >
                <td className="p-1.5 whitespace-nowrap">
                  <span className="text-muted select-none mr-1" title="drag to reorder">⠿</span>
                  <button onClick={() => moveOrder(o.id, -1)} disabled={i === 0} className="px-1 text-accent font-bold disabled:opacity-20" title="work it sooner">↑</button>
                  <span className="tabnum text-xs text-muted">{i + 1}</span>
                  <button onClick={() => moveOrder(o.id, +1)} disabled={i === result.orders.length - 1} className="px-1 text-accent font-bold disabled:opacity-20" title="work it later">↓</button>
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
