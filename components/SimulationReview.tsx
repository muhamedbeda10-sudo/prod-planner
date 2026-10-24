"use client";

import { useMemo, useState } from "react";
import { compareSimulations, simulationReadiness, stressSimulations, stressStage, type NamedSimulation, type StressCase } from "@/lib/domain/simulationReview";
import { WI_STAGES, type Scenario, type WhatIfInputs, type WiStage } from "@/lib/domain/whatif";
import type { EtaStage } from "@/lib/domain/eta";
import { isDayISO } from "@/lib/domain/whatifScenario";

const n = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
export function SimulationReview({ inputs, scenario, onLoad }: { inputs: WhatIfInputs; scenario: Scenario; onLoad: (s: Scenario) => void }) {
  const [kept, setKept] = useState<NamedSimulation[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [kind, setKind] = useState("downtime");
  const [stage, setStage] = useState<EtaStage>("cut");
  const [dept, setDept] = useState<WiStage>("Welding");
  const [workers, setWorkers] = useState(1);
  const [from, setFrom] = useState(inputs.todayISO);
  const [until, setUntil] = useState(inputs.todayISO);
  const [job, setJob] = useState("");
  const [stresses, setStresses] = useState<StressCase[]>([]);
  const variants = useMemo(() => [...kept, { label: "Current scenario", scenario }], [kept, scenario]);
  const comparison = useMemo(() => compareSimulations(inputs, variants), [inputs, variants]);
  const readiness = useMemo(() => simulationReadiness(inputs, scenario), [inputs, scenario]);
  const stress = useMemo(() => stresses.length ? stressSimulations(inputs, variants, stresses) : null, [inputs, variants, stresses]);
  const keep = () => {
    const name = label.trim();
    if (!name || ["plant baseline", "current scenario", ...kept.map((v) => v.label.toLowerCase())].includes(name.toLowerCase())) { setError("Give this alternative a distinct name."); return; }
    if (kept.length >= 3) { setError("Keep up to three alternatives; remove one to add another."); return; }
    setKept([...kept, { label: name, scenario: structuredClone(scenario) }]); setLabel(""); setError("");
  };
  const addStress = () => {
    if (stresses.length >= 3) { setError("Compare up to three independent stress cases; remove one first."); return; }
    let next: StressCase;
    if (kind === "workers") {
      if (!Number.isInteger(workers) || workers < 1 || workers > 500) { setError("Enter 1–500 workers to remove."); return; }
      next = { label: `${workers} fewer ${dept} workers`, workersDelta: { [dept]: -workers } };
    } else {
      if (!isDayISO(until) || (kind === "downtime" && (!isDayISO(from) || until < from))) { setError("Enter real dates; a stoppage cannot end before it starts."); return; }
      if (kind === "downtime") next = stressStage(stage, from, until);
      else {
        if (!inputs.jobs.some((j) => j.id === job && j.left.finish > 0)) { setError("Choose an active job for the material delay."); return; }
        next = { label: `${job} material available ${until}`, holds: [{ job, untilISO: until }] };
      }
    }
    if (stresses.some((s) => s.label === next.label)) { setError("This stress case is already listed."); return; }
    setStresses([...stresses, next]); setError("");
  };
  const metrics = [{ label: "Plant baseline", metrics: comparison.baseline }, ...comparison.variants];
  return (
    <section className="bg-surface border rounded-xl overflow-hidden" aria-label="Planning decision review">
      <div className="px-4 py-3 border-b">
        <h2 className="!mb-1">Compare alternatives & test disruptions</h2>
        <p className="text-xs text-muted">TR model · one shared data snapshot · local previews. Department crew changes are hypothetical; extra hours apply to added workers. Nothing here applies a run order.</p>
      </div>
      <div className="p-4 space-y-4">
        <details className="border rounded-lg p-3" open={readiness.status === "blocked"}>
          <summary className="cursor-pointer font-semibold text-sm">Forecast readiness: {readiness.status === "blocked" ? "Incomplete — resolve blocking data" : readiness.status === "review" ? "Review data gaps" : "Usable with assumptions"} · {readiness.issues.length} checks</summary>
          <p className="text-xs text-muted mt-2">{readiness.activeOrders} priced active orders · {inputs.coverage ? `${inputs.coverage.openOrders} open orders in registry · ${inputs.coverage.heldOrders} on hold · ${inputs.coverage.missingTimes.length} components missing times` : "Registry coverage unavailable"}</p>
          <ul className="text-sm space-y-1 mt-2">{readiness.issues.map((issue) => <li key={issue.code}><b>{issue.severity === "blocking" ? "Blocking" : "Review"}:</b> {issue.message}{issue.count !== undefined && ` (${issue.count})`}{issue.records?.length ? <div className="text-xs text-muted break-words">{issue.records.join(", ")}{issue.count! > issue.records.length ? " …" : ""}</div> : null}</li>)}</ul>
          <ul className="mt-3 text-xs text-muted space-y-1">{readiness.assumptions.map((text) => <li key={text}>{text}</li>)}</ul>
        </details>
        <div className="flex flex-wrap gap-2 items-center">
          <input aria-label="Alternative name" maxLength={80} placeholder="Name the current alternative…" value={label} onChange={(e) => setLabel(e.target.value)} className="text-sm px-2 py-1.5 max-w-full" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={keep} disabled={kept.length >= 3}>Keep current alternative</button>
          <span className="text-xs text-muted">Then adjust the controls below to compare another option. Kept alternatives stay in this page only.</span>
        </div>
        {!!kept.length && <div className="flex flex-wrap gap-2">{kept.map((v) => <span key={v.label} className="inline-flex items-center border rounded-lg px-2 py-1 gap-2 text-xs"><b>{v.label}</b><button type="button" className="text-brand-ink underline" onClick={() => onLoad(structuredClone(v.scenario))}>Load</button><button type="button" onClick={() => setKept(kept.filter((s) => s.label !== v.label))} aria-label={`Remove alternative ${v.label}`}>×</button></span>)}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm"><caption className="text-start text-xs text-muted mb-2">All counts cover MOs in the priced queue, with split batches/components folded together. Undated orders are outside on-time/late counts.</caption><thead><tr>{["Alternative", "Late", "On time", "Blocked", "No due date", "Late calendar days", "Priced queue clears", "Extra mh/workday"].map((s) => <th key={s} className="text-start whitespace-nowrap p-2">{s}</th>)}</tr></thead><tbody>{metrics.map(({ label: name, metrics: m }) => <tr key={name}><th className="text-start p-2">{name}</th><td className="p-2">{m.lateOrders}</td><td className="p-2">{m.onTimeOrders}</td><td className="p-2">{m.blockedOrders}</td><td className="p-2">{m.undatedOrders}</td><td className="p-2">{m.totalLateCalendarDays}</td><td className="p-2 whitespace-nowrap">{m.allClearISO ?? "Unresolved"}</td><td className="p-2">{n(m.addedManHoursPerWorkingDay)}</td></tr>)}</tbody></table>
        </div>
        {comparison.variants.some((v) => v.changedOrdersCount > 0) && <details className="border rounded-lg p-3"><summary className="cursor-pointer text-sm font-semibold">Orders changed by the alternatives</summary><div className="space-y-2 mt-2">{comparison.variants.filter((v) => v.changedOrdersCount > 0).map((v) => <div key={v.label}><b className="text-sm">{v.label} · {v.changedOrdersCount} changed orders</b><ul className="text-xs space-y-1 mt-1">{v.changedOrders.map((r) => <li key={r.mo}><a href={`/trace?mo=${encodeURIComponent(r.mo)}&line=TR`} className="underline text-brand-ink">{r.mo}</a>: {r.beforeISO ?? "Unresolved"} → {r.afterISO ?? "Unresolved"}{r.deltaCalendarDays !== null ? ` (${r.deltaCalendarDays > 0 ? "+" : ""}${r.deltaCalendarDays} calendar days)` : ""}</li>)}</ul>{v.changedOrdersCount > v.changedOrders.length && <p className="text-xs text-muted">Showing the first {v.changedOrders.length}; totals cover every matching order.</p>}</div>)}</div></details>}
        <details className="border rounded-lg p-3">
          <summary className="cursor-pointer font-semibold text-sm">Stress tests · {stresses.length} independent cases</summary>
          <p className="text-xs text-muted my-2">Cases run separately against each alternative. A station outage stops the entire modeled station; it does not represent one named machine. Existing holds and stoppages remain in force.</p>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label>Disruption<select aria-label="Disruption type" value={kind} onChange={(e) => setKind(e.target.value)} className="block"><option value="downtime">Whole-station outage</option><option value="workers">Fewer workers (whole horizon)</option><option value="material">Material arrives later</option></select></label>
            {kind === "downtime" && <><label>Station<select aria-label="Outage station" value={stage} onChange={(e) => setStage(e.target.value as EtaStage)} className="block"><option value="cut">Fabrication</option><option value="weld">Welding</option><option value="finish">Shot blast / Painting</option></select></label><label>From<input aria-label="Outage starts" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block" /></label></>}
            {kind === "workers" && <><label>Department<select aria-label="Reduced department" value={dept} onChange={(e) => setDept(e.target.value as WiStage)} className="block">{WI_STAGES.map((s) => <option key={s}>{s}</option>)}</select></label><label>Workers removed<input aria-label="Workers removed" type="number" min={1} max={500} value={workers} onChange={(e) => setWorkers(Number(e.target.value))} className="block w-24" /></label></>}
            {kind === "material" && <label>Job<select aria-label="Material job" value={job} onChange={(e) => setJob(e.target.value)} className="block max-w-full"><option value="">Choose a job…</option>{inputs.jobs.filter((j) => j.left.finish > 0).map((j) => <option key={j.id} value={j.id}>{j.id}</option>)}</select></label>}
            {kind !== "workers" && <label>{kind === "downtime" ? "Through (inclusive)" : "Available on"}<input aria-label="Disruption end or arrival" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="block" /></label>}
            <button type="button" className="btn btn-secondary btn-sm" onClick={addStress}>Add stress case</button>
          </div>
          <div className="my-3 space-y-1">{stresses.map((s) => <div key={s.label} className="text-xs flex gap-2 items-center"><span>{s.label}</span><button type="button" onClick={() => setStresses(stresses.filter((x) => x !== s))} aria-label={`Remove stress ${s.label}`} className="underline">Remove</button></div>)}</div>
          {stress && <><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-start p-2">Alternative</th>{stresses.map((s) => <th key={s.label} className="text-start p-2 min-w-44">{s.label}</th>)}</tr></thead><tbody>{stress.rows.map((r) => <tr key={r.label}><th className="text-start p-2">{r.label}</th>{r.trials.map((t) => <td key={t.label} className="p-2">{t.metrics ? <>{t.metrics.lateOrders} late · {t.metrics.blockedOrders} blocked<br /><span className="text-xs text-muted">{t.delayedOrdersCount} orders worsened · {t.metrics.totalLateCalendarDays} late calendar days</span>{!!t.delayedOrders.length && <details><summary className="text-xs cursor-pointer">Affected orders</summary><ul className="text-xs">{t.delayedOrders.map((j) => <li key={j.mo}><a href={`/trace?mo=${encodeURIComponent(j.mo)}&line=TR`} className="underline text-brand-ink">{j.mo}</a>: {j.blocked ? "blocked" : `+${j.deltaCalendarDays} days`}</li>)}</ul></details>}</> : <span className="text-bad-fg">{t.error}</span>}</td>)}</tr>)}</tbody></table></div><p className="text-xs text-muted mt-2">{stress.ranking.length ? `Provisional order: ${stress.ranking.join(" → ")}. Fewer worst blocked orders, then late orders, then late days, then extra man-hours; ties retain table order.` : "Ranking withheld: resolve coverage, capacity, due dates, blocking data or invalid cases first."}</p><p className="text-xs text-muted mt-1">Each worst metric can come from a different case. No probability or combined-event estimate.</p></>}
        </details>
        {error && <p className="text-sm text-bad-fg" role="alert">{error}</p>}
      </div>
    </section>
  );
}
