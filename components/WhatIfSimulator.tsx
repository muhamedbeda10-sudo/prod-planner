"use client";

import { DateSlicer } from "@/components/DateSlicer";
import { addDaysISO, slicerPresets } from "@/lib/domain/dateSlicer";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  simulate, defaultScenario, optimizeQueue, dateForOffsetISO, blackoutsOf, WI_STAGES,
  type WhatIfInputs, type Scenario, type WiStage, type WhatIfResult,
} from "@/lib/domain/whatif";
import type { EtaStage, StageBlackout } from "@/lib/domain/eta";
import { saveScenario, deleteScenario, applyRunOrder, clearRunOrder } from "@/app/simulate/actions";
import { deptLabel, STAGE_COLOR } from "@/lib/domain/constants";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";

/* The control room: turn the knobs — workers per stage, working Fridays, a
   hand-reordered (drag & drop) queue, split quantities, or one click of the
   optimizer — and the KPIs, the station timeline and every ETA respond
   instantly, with the SAME arithmetic the live pages use. The queue schedules
   JOBS (one component of one order), so the TC of an order can jump ahead
   while its TN waits, and a job can split into a rushed batch + the rest.
   Pin a scenario as "A" to compare against it. Nothing here is saved. */

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

type ResultJob = WhatIfResult["jobs"][number];

/** MO-level readings: an ORDER is on time only when every job in it is. */
function kpisOf(result: WhatIfResult) {
  const byMo = new Map<string, { late: boolean; blocked: boolean; anyActive: boolean }>();
  for (const j of result.jobs) {
    const cur = byMo.get(j.mo) ?? { late: false, blocked: false, anyActive: false };
    if (j.blockedBy) cur.blocked = true;
    else if (!j.done) {
      cur.anyActive = true;
      if (j.late) cur.late = true;
    }
    byMo.set(j.mo, cur);
  }
  const active = [...byMo.values()].filter((m) => m.anyActive && !m.blocked);
  const late = active.filter((m) => m.late).length;
  const activeJobs = result.jobs.filter((j) => !j.done && !j.blockedBy);
  const lastEta = activeJobs.reduce<string | null>((m, j) => (j.etaISO && (!m || j.etaISO > m) ? j.etaISO : m), null);
  const worst = result.stages
    .filter((s) => s.required > 0 && s.load !== null)
    .reduce<(typeof result.stages)[number] | null>((w, s) => (!w || s.load! > w.load! ? s : w), null);
  return { active: active.length, late, onTime: active.length - late, lastEta, worst };
}

const scenarioCost = (sc: Scenario) => WI_STAGES.reduce((a, s) => a + sc.workersDelta[s] * sc.shiftHours, 0);

/** One line that names a scenario: "+2 Welding · Fridays · queue edited · 1 split". */
function describeScenario(sc: Scenario, inputs: WhatIfInputs): string {
  const parts: string[] = [];
  for (const s of WI_STAGES) if (sc.workersDelta[s] !== 0) parts.push(`${sc.workersDelta[s] > 0 ? "+" : ""}${sc.workersDelta[s]} ${deptLabel(s)}`);
  if (sc.shiftHours !== 11) parts.push(`${sc.shiftHours}h shifts`);
  if (sc.workFridays) parts.push("Fridays on");
  if (sc.queue.some((id, i) => inputs.jobs[i]?.id !== id)) parts.push("queue edited");
  const splits = Object.keys(sc.splits).length;
  if (splits) parts.push(`${splits} split${splits === 1 ? "" : "s"}`);
  const holds = Object.keys(sc.holds).length;
  if (holds) parts.push(`${holds} hold${holds === 1 ? "" : "s"}`);
  if (sc.downtimes.length) parts.push(`${sc.downtimes.length} stoppage${sc.downtimes.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "reality as-is";
}

/* ================================ KPI strip ================================ */

function Kpi({ label, value, sub, pinned, tone }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  pinned?: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
}) {
  const color = tone === "ok" ? "var(--ok-fg)" : tone === "warn" ? "var(--warn-fg)" : tone === "bad" ? "var(--bad-fg)" : undefined;
  return (
    <div className="flex-1 min-w-40 bg-surface border rounded-xl px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className="text-2xl font-extrabold tabnum leading-tight" style={{ color }}>{value}</div>
      {pinned !== undefined && <div className="text-[11px] font-semibold tabnum" style={{ color: "var(--accent)" }}>📌 A: {pinned}</div>}
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* ================================ timeline ================================ */

function Timeline({ result, baseline, inputs, workFridays, shownIds, blackouts }: {
  result: WhatIfResult;
  baseline: WhatIfResult;
  inputs: WhatIfInputs;
  workFridays: boolean;
  shownIds: Set<string>;
  blackouts: Partial<Record<EtaStage, StageBlackout[]>>;
}) {
  const holidays = useMemo(() => new Set(inputs.holidayISOs), [inputs.holidayISOs]);
  const rows = result.jobs.filter((o) => o.segments.length > 0 && shownIds.has(o.id));
  const baseEnd = new Map(baseline.jobs.map((o) => [o.id, o.segments.length ? o.segments[o.segments.length - 1].end : null]));

  // the axis stretches to whatever width the card actually has
  const scrollRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1200);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (rows.length === 0) return null;

  const LABEL_W = 176;
  const axisDays = Math.max(1, Math.ceil(Math.max(result.makespan, ...rows.map((o) => o.dueOffset ?? 0))) + 1);
  const PX = Math.max(18, Math.floor((avail - LABEL_W - 90) / axisDays));
  const tickEvery = Math.max(1, Math.ceil(56 / PX));
  const width = axisDays * PX + 90;

  return (
    <section className="bg-surface border rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 pb-1.5">
        <h2 className="text-sm">Station timeline</h2>
        <span className="text-[10px] text-muted">one row per component job · each bar = one station holding it · the axis counts WORKING days</span>
        <span className="flex items-center gap-3 ml-auto text-[10px] text-muted">
          {Object.entries(SEG_LABEL).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SEG_COLOR[k] }} />{label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1"><span className="text-bad-fg font-bold">▼</span>due</span>
        </span>
      </div>
      <div ref={scrollRef} className="overflow-x-auto">
        <div className="relative ml-44" style={{ width, minHeight: rows.length * 30 + 34 }}>
          {Array.from({ length: axisDays + 1 }, (_, i) => (
            <div key={i} className="absolute top-0 bottom-0 border-l" style={{ left: i * PX, borderColor: "var(--border)", opacity: i % tickEvery ? 0.25 : 0.7 }}>
              {i % tickEvery === 0 && i < axisDays && (
                <span className="absolute top-0.5 left-1 text-[9px] text-muted tabnum whitespace-nowrap">
                  {ddShort(dateForOffsetISO(i + 1, inputs.todayISO, holidays, workFridays))}
                </span>
              )}
            </div>
          ))}
          {/* station stoppages — the shaded strips nothing can run through */}
          {(Object.entries(blackouts) as [EtaStage, StageBlackout[]][]).flatMap(([stage, bls]) =>
            (bls ?? []).map((b, i) => (
              <div
                key={`bl-${stage}-${i}`}
                className="absolute top-4 bottom-0 rounded"
                style={{ left: b.start * PX, width: Math.max(2, (b.end - b.start) * PX), background: SEG_COLOR[stage], opacity: 0.13, border: `1px dashed ${SEG_COLOR[stage]}` }}
                title={`${SEG_LABEL[stage]} stopped`}
              />
            ))
          )}
          {rows.map((o, r) => {
            const top = 24 + r * 30;
            const end = o.segments[o.segments.length - 1].end;
            const bEnd = baseEnd.get(o.id) ?? baseEnd.get(o.baseId);
            return (
              <div key={o.id}>
                <div className="absolute -ml-44 w-40 pr-2 text-right whitespace-nowrap overflow-hidden text-ellipsis" style={{ top: top + 2 }}>
                  <span className="text-xs font-bold">{o.bom}</span>
                  <span className="text-[10px] font-bold ml-1" style={{ color: "var(--accent)" }}>{o.item}</span>
                  <span className="text-[9px] text-muted tabnum ml-0.5">×{o.qty}{o.batch !== null && ` b${o.batch}`}</span>
                </div>
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
                    title={`${o.bom} ${o.item}: ${SEG_LABEL[s.stage]} day ${fmt(s.start)} → ${fmt(s.end)}`}
                  />
                ))}
                <span
                  className="absolute text-[9px] font-bold tabnum whitespace-nowrap"
                  style={{ top: top + 4, left: end * PX + 4, color: o.late ? "var(--bad-fg)" : "var(--muted)" }}
                >
                  {o.late && "⚠ "}{dd(o.etaISO)}
                </span>
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

const AUTOSAVE_KEY = "atc.sim.scenario";

export interface SavedScenarioDTO {
  name: string;
  data: unknown;
  savedBy: string | null;
}

export function WhatIfSimulator({ inputs, isAdmin = false, savedScenarios = [], appliedRunOrder = null }: {
  inputs: WhatIfInputs;
  isAdmin?: boolean;
  savedScenarios?: SavedScenarioDTO[];
  appliedRunOrder?: { atISO: string; by: string | null } | null;
}) {
  // anything unknown in a restored/loaded scenario falls back to reality —
  // simulate() itself is defensive about stale job ids
  const sanitize = (raw: unknown): Scenario => {
    const d = defaultScenario(inputs);
    if (!raw || typeof raw !== "object") return d;
    const r = raw as Partial<Scenario>;
    return {
      workersDelta: { ...d.workersDelta, ...(typeof r.workersDelta === "object" ? r.workersDelta : {}) },
      shiftHours: typeof r.shiftHours === "number" && r.shiftHours >= 1 ? r.shiftHours : d.shiftHours,
      workFridays: !!r.workFridays,
      queue: Array.isArray(r.queue) && r.queue.length ? r.queue.filter((x): x is string => typeof x === "string") : d.queue,
      splits: r.splits && typeof r.splits === "object" ? (r.splits as Scenario["splits"]) : {},
      holds: r.holds && typeof r.holds === "object" ? (r.holds as Scenario["holds"]) : {},
      downtimes: Array.isArray(r.downtimes) ? (r.downtimes as Scenario["downtimes"]) : [],
    };
  };

  // the work in progress survives a refresh — restored from this browser
  const [scenario, setScenario] = useState<Scenario>(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(AUTOSAVE_KEY);
        if (raw) return sanitize(JSON.parse(raw));
      } catch { /* fall through to reality */ }
    }
    return defaultScenario(inputs);
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(scenario));
    } catch { /* storage full/blocked — the sandbox still works */ }
  }, [scenario]);

  const [pinned, setPinned] = useState<Scenario | null>(null);
  const [grouped, setGrouped] = useState(false);
  const result = useMemo(() => simulate(inputs, scenario), [inputs, scenario]);
  const baseline = useMemo(() => simulate(inputs, defaultScenario(inputs)), [inputs]);
  const pinnedResult = useMemo(() => (pinned ? simulate(inputs, pinned) : null), [inputs, pinned]);

  const touched =
    scenario.workFridays ||
    scenario.shiftHours !== 11 ||
    Object.keys(scenario.splits).length > 0 ||
    WI_STAGES.some((s) => scenario.workersDelta[s] !== 0) ||
    scenario.queue.some((id, i) => inputs.jobs[i]?.id !== id);

  const bumpWorkers = (s: WiStage, d: number) =>
    setScenario((sc) => ({ ...sc, workersDelta: { ...sc.workersDelta, [s]: sc.workersDelta[s] + d } }));

  const moveJob = (id: string, dir: -1 | 1) =>
    setScenario((sc) => {
      const q = [...sc.queue];
      const i = q.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= q.length) return sc;
      [q[i], q[j]] = [q[j], q[i]];
      return { ...sc, queue: q };
    });

  const runOptimizer = () => setScenario((sc) => ({ ...sc, queue: optimizeQueue(inputs, sc) }));

  // ---- confidence band: the same scenario at the plant's fast and slow days ----
  // pessimistic rates are clamped away from zero so a volatile stage degrades
  // the forecast instead of blocking it outright
  const bandInputs = (dir: 1 | -1): WhatIfInputs => ({
    ...inputs,
    rates: {
      cut: inputs.rates.cut > 0 ? Math.max(inputs.rates.cut * 0.25, inputs.rates.cut + dir * inputs.rateSigma.cut) : 0,
      weld: inputs.rates.weld > 0 ? Math.max(inputs.rates.weld * 0.25, inputs.rates.weld + dir * inputs.rateSigma.weld) : 0,
      finish: inputs.rates.finish > 0 ? Math.max(inputs.rates.finish * 0.25, inputs.rates.finish + dir * inputs.rateSigma.finish) : 0,
    },
  });
  const fast = useMemo(() => simulate(bandInputs(1), scenario), [inputs, scenario]); // eslint-disable-line react-hooks/exhaustive-deps
  const slow = useMemo(() => simulate(bandInputs(-1), scenario), [inputs, scenario]); // eslint-disable-line react-hooks/exhaustive-deps
  const bandById = useMemo(() => {
    const m = new Map<string, { early: string | null; late: string | null }>();
    const fastById = new Map(fast.jobs.map((j) => [j.id, j.etaISO]));
    for (const j of slow.jobs) m.set(j.id, { early: fastById.get(j.id) ?? null, late: j.etaISO });
    return m;
  }, [fast, slow]);
  const blackouts = useMemo(
    () => blackoutsOf(scenario, inputs.todayISO, new Set(inputs.holidayISOs)),
    [scenario, inputs.todayISO, inputs.holidayISOs]
  );

  // ---- material holds & station stoppages ----
  const setHold = (row: ResultJob) => {
    const cur = scenario.holds[row.baseId];
    const raw = prompt(
      `${row.bom} ${row.item}: material/parts arrive on which day? (YYYY-MM-DD, empty removes the hold)`,
      cur ?? ""
    );
    if (raw === null) return;
    const iso = raw.trim();
    setScenario((sc) => {
      const holds = { ...sc.holds };
      if (!iso) delete holds[row.baseId];
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) { alert("Use the YYYY-MM-DD format."); return sc; }
        holds[row.baseId] = iso;
      }
      return { ...sc, holds };
    });
  };

  const addDowntime = (stage: WiStage) => {
    const es: EtaStage = stage === "Cut" ? "cut" : stage === "Welding" ? "weld" : "finish";
    const from = prompt(`${deptLabel(stage)} stopped FROM which day? (YYYY-MM-DD)`);
    if (!from?.trim()) return;
    const to = prompt(`…until which day (inclusive)? (YYYY-MM-DD)`, from.trim());
    if (!to?.trim()) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from.trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(to.trim()) || to.trim() < from.trim()) {
      return alert("Use YYYY-MM-DD dates, with the end not before the start.");
    }
    setScenario((sc) => ({ ...sc, downtimes: [...sc.downtimes, { stage: es, fromISO: from.trim(), toISO: to.trim() }] }));
  };

  const removeDowntime = (i: number) =>
    setScenario((sc) => ({ ...sc, downtimes: sc.downtimes.filter((_, x) => x !== i) }));

  // ---- persistence & commit ----
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [actionMsg, setActionMsg] = useState("");
  const runAction = (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setActionMsg("");
    startTransition(async () => {
      const res = await fn();
      setActionMsg(res.ok ? `✓ ${okMsg}` : res.error ?? "Failed");
      if (res.ok) router.refresh();
    });
  };

  const saveCurrent = () => {
    const name = prompt("Scenario name:", describeScenario(scenario, inputs).slice(0, 40));
    if (!name?.trim()) return;
    const fd = new FormData();
    fd.set("name", name.trim());
    fd.set("data", JSON.stringify(scenario));
    runAction(() => saveScenario(fd), `saved "${name.trim()}"`);
  };

  const deleteSaved = () => {
    const name = prompt(`Delete which scenario?\n${savedScenarios.map((s) => `· ${s.name}`).join("\n")}`);
    if (!name?.trim()) return;
    const fd = new FormData();
    fd.set("name", name.trim());
    runAction(() => deleteScenario(fd), `deleted "${name.trim()}"`);
  };

  // commit the CURRENT queue (as simulated) as the factory's run order
  const applyCurrent = () => {
    const entries = result.jobs
      .filter((j) => !j.done)
      .map((j) => ({ mo: j.mo, item: j.item, batchQty: j.batch !== null ? j.qty : null, batchNo: j.batch }));
    if (entries.length === 0) return setActionMsg("Nothing open to commit.");
    if (!confirm(`Commit this sequence of ${entries.length} jobs as THE run order? Every department worklist will show its slice of it, replacing any previous run order.`)) return;
    const fd = new FormData();
    fd.set("entries", JSON.stringify(entries));
    runAction(() => applyRunOrder(fd), "run order is live on the worklists");
  };

  const clearApplied = () => {
    if (!confirm("Remove the run order from all worklists?")) return;
    runAction(() => clearRunOrder(), "run order cleared");
  };

  // split an unsplit job: the FIRST batch takes the most-advanced pieces
  const splitJob = (row: ResultJob) => {
    const raw = prompt(`Rush how many of ${row.bom} ${row.item}'s ${row.qty} pcs ahead? (1–${row.qty - 1})`);
    if (raw === null) return;
    const q = Math.floor(Number(raw));
    if (!Number.isFinite(q) || q < 1 || q >= row.qty) return alert(`Enter a number between 1 and ${row.qty - 1}.`);
    setScenario((sc) => {
      const queue = [...sc.queue];
      const at = queue.indexOf(row.id);
      if (at >= 0) queue.splice(at, 1, `${row.id}#1`, `${row.id}#2`);
      return { ...sc, splits: { ...sc.splits, [row.id]: [q, row.qty - q] }, queue };
    });
  };

  // remove a split: its batches collapse back to the base job where batch 1 sat
  const unsplitJob = (baseId: string) =>
    setScenario((sc) => {
      const splits = { ...sc.splits };
      const n = splits[baseId]?.length ?? 0;
      delete splits[baseId];
      const batchIds = Array.from({ length: n }, (_, i) => `${baseId}#${i + 1}`);
      const queue = sc.queue.filter((id) => !batchIds.includes(id) || id === batchIds[0]);
      return { ...sc, splits, queue: queue.map((id) => (id === batchIds[0] ? baseId : id)) };
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
  const k = kpisOf(result);
  const kBase = kpisOf(baseline);
  const kPin = pinnedResult ? kpisOf(pinnedResult) : null;
  const clearDelta = k.lastEta && kBase.lastEta ? Math.round((Date.parse(k.lastEta) - Date.parse(kBase.lastEta)) / 86400000) : 0;
  const addedMh = scenarioCost(scenario);
  const pinById = pinnedResult ? new Map(pinnedResult.jobs.map((o) => [o.id, o])) : null;

  // ---- view filters: they narrow what's SHOWN in the timeline and the
  // queue, never what's computed — a hidden job still occupies its station,
  // so every date on screen stays honest ----
  const [fq, setFq] = useState("");
  const [fItem, setFItem] = useState("");
  const [fStage, setFStage] = useState(""); // a station the job still has to visit
  const [fFrom, setFFrom] = useState(""); // due-date range
  const [fTo, setFTo] = useState("");
  // the due dates the queue holds — the Due slicer's strip and its dots
  const dueDays = useMemo(() => [...new Set(inputs.jobs.map((j) => j.dueISO).filter((d): d is string => !!d))].sort(), [inputs.jobs]);
  const dueMin = [dueDays[0] ?? inputs.todayISO, inputs.todayISO].sort()[0];
  const dueMax = [dueDays[dueDays.length - 1] ?? inputs.todayISO, addDaysISO(inputs.todayISO, 7)].sort().reverse()[0];
  const [fLate, setFLate] = useState(false);
  const filterActive = !!(fq || fItem || fStage || fFrom || fTo || fLate);
  const resetFilters = () => { setFq(""); setFItem(""); setFStage(""); setFFrom(""); setFTo(""); setFLate(false); };
  const visible = (j: ResultJob): boolean => {
    const needle = fq.trim().toUpperCase();
    if (needle && !j.bom.toUpperCase().includes(needle)) return false;
    if (fItem && j.item !== fItem) return false;
    if (fStage && !j.segments.some((s) => s.stage === fStage)) return false;
    if ((fFrom || fTo) && !j.dueISO) return false;
    if (fFrom && j.dueISO! < fFrom) return false;
    if (fTo && j.dueISO! > fTo) return false;
    if (fLate && !j.late) return false;
    return true;
  };
  const shownJobs = useMemo(() => result.jobs.filter(visible), [result.jobs, fq, fItem, fStage, fFrom, fTo, fLate]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownIds = useMemo(() => new Set(shownJobs.map((j) => j.id)), [shownJobs]);
  const queueIndexOf = useMemo(() => new Map(result.jobs.map((j, i) => [j.id, i])), [result.jobs]);

  // the table's rows: queue order, or grouped read-only by order
  const tableRows: (ResultJob | { moHeader: string; bom: string; jobs: ResultJob[] })[] = useMemo(() => {
    if (!grouped) return shownJobs;
    const seen = new Map<string, ResultJob[]>();
    for (const j of shownJobs) {
      if (!seen.has(j.mo)) seen.set(j.mo, []);
      seen.get(j.mo)!.push(j);
    }
    return [...seen.entries()].map(([mo, jobs]) => ({ moHeader: mo, bom: jobs[0].bom, jobs }));
  }, [grouped, shownJobs]);

  return (
    <div className="space-y-4">
      {/* ================= pinned banner ================= */}
      {pinned && (
        <div className="flex flex-wrap items-center gap-2 border rounded-xl px-3.5 py-2 text-sm" style={{ background: "var(--brand-light)", borderColor: "color-mix(in srgb, var(--brand) 35%, transparent)" }}>
          <span className="font-bold">📌 Scenario A pinned:</span>
          <span className="text-muted">{describeScenario(pinned, inputs)}</span>
          <span className="text-[11px] text-muted">— the tiles and the ETA A column compare everything you do now against it</span>
          <span className="ml-auto flex gap-1.5">
            <button onClick={() => setScenario(pinned)} className="btn btn-ghost btn-sm" title="load A back into the knobs">Restore A</button>
            <button onClick={() => setPinned(null)} className="btn btn-ghost btn-sm">✕ Unpin</button>
          </span>
        </div>
      )}

      {/* ================= KPI strip ================= */}
      <div className="flex flex-wrap gap-3">
        <Kpi
          label="Orders on time"
          value={`${k.onTime} / ${k.active}`}
          tone={k.late === 0 ? "ok" : k.late > kBase.late ? "bad" : k.late < kBase.late ? "ok" : "warn"}
          pinned={kPin ? `${kPin.onTime} / ${kPin.active}` : undefined}
          sub={k.late === kBase.late ? `${k.late} late — same as today` : k.late < kBase.late ? `▲ ${kBase.late - k.late} rescued vs today` : `▼ ${k.late - kBase.late} MORE late than today`}
        />
        <Kpi
          label="All orders clear by"
          value={k.lastEta ? dd(k.lastEta) : "—"}
          tone={clearDelta < 0 ? "ok" : clearDelta > 0 ? "bad" : undefined}
          pinned={kPin ? dd(kPin.lastEta) : undefined}
          sub={
            <>
              {clearDelta === 0 ? "same as today" : clearDelta < 0 ? `▲ ${-clearDelta} calendar days earlier` : `▼ ${clearDelta} calendar days later`}
              {(() => {
                const early = kpisOf(fast).lastEta;
                const late = kpisOf(slow).lastEta;
                return early && late && early !== late ? <> · likely {ddShort(early)}–{ddShort(late)}</> : null;
              })()}
            </>
          }
        />
        <Kpi
          label="Worst station load"
          value={k.worst?.load != null ? `${Math.round(k.worst.load * 100)}%` : "—"}
          tone={k.worst?.load != null ? (k.worst.load > 1 ? "bad" : k.worst.load > 0.9 ? "warn" : "ok") : undefined}
          pinned={kPin?.worst?.load != null ? `${Math.round(kPin.worst.load * 100)}% (${deptLabel(kPin.worst.dept)})` : undefined}
          sub={k.worst ? `${deptLabel(k.worst.dept)} · weekly plan ${inputs.plan?.planNo ?? ""}` : "no weekly plan"}
        />
        <Kpi
          label="Scenario cost"
          value={addedMh === 0 ? "±0" : `${addedMh > 0 ? "+" : ""}${fmt(addedMh)} mh/day`}
          tone={addedMh > 0 ? "warn" : undefined}
          pinned={pinned ? (scenarioCost(pinned) === 0 ? "±0" : `${scenarioCost(pinned) > 0 ? "+" : ""}${fmt(scenarioCost(pinned))} mh/day`) : undefined}
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
                  <span className="text-[10px] font-bold uppercase tracking-wide text-muted">
                    Workers
                    <button onClick={() => addDowntime(s)} className="ml-1.5 opacity-60 hover:opacity-100" title="declare a stoppage (maintenance) at this station">🔧</button>
                  </span>
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
        {/* the settings & actions card */}
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
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={runOptimizer}
                className="btn btn-primary btn-sm"
                title="reorder the queue to rescue as many due dates as this scenario's speed allows"
              >
                ⚡ Optimize queue
              </button>
              <button
                onClick={() => setPinned(scenario)}
                className="btn btn-secondary btn-sm"
                title="freeze the current scenario as A and compare everything you try next against it"
              >
                📌 Pin as A
              </button>
              <button
                onClick={() => setScenario(defaultScenario(inputs))}
                disabled={!touched}
                className="btn btn-secondary btn-sm col-span-2 disabled:opacity-40"
              >
                ↺ Reset to reality
              </button>
            </div>
          </div>
        </div>
        {/* scenarios & commit card */}
        <div className="bg-surface border rounded-xl overflow-hidden">
          <div className="h-1" style={{ background: "var(--accent)" }} />
          <div className="px-3.5 py-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <select
                value=""
                onChange={(e) => {
                  const s = savedScenarios.find((x) => x.name === e.target.value);
                  if (s) setScenario(sanitize(s.data));
                }}
                className="flex-1 min-w-0 border rounded-md px-2 py-1 text-sm bg-surface"
                disabled={pending}
              >
                <option value="">{savedScenarios.length ? "Load a saved scenario…" : "No saved scenarios yet"}</option>
                {savedScenarios.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <button onClick={saveCurrent} disabled={pending} className="btn btn-secondary btn-sm" title="save the current scenario under a name">💾</button>
              {savedScenarios.length > 0 && (
                <button onClick={deleteSaved} disabled={pending} className="btn btn-ghost btn-sm" title="delete a saved scenario">🗑</button>
              )}
            </div>
            {isAdmin && (
              <button
                onClick={applyCurrent}
                disabled={pending}
                className="btn btn-primary btn-sm w-full"
                title="commit this queue as THE run order — every department worklist will show its slice of it"
              >
                ✅ Apply as the run order
              </button>
            )}
            {appliedRunOrder && (
              <p className="text-[10px] text-muted leading-snug">
                🎯 A run order is live on the worklists (set {dd(appliedRunOrder.atISO.slice(0, 10))}
                {appliedRunOrder.by ? ` by ${appliedRunOrder.by}` : ""}).
                {isAdmin && (
                  <button onClick={clearApplied} disabled={pending} className="text-bad-fg font-semibold hover:underline ml-1">Clear it</button>
                )}
              </p>
            )}
            {actionMsg && <p className={`text-[11px] font-semibold ${actionMsg.startsWith("✓") ? "text-ok-fg" : "text-bad-fg"}`}>{actionMsg}</p>}
          </div>
        </div>
      </div>

      {/* ================= stoppage chips ================= */}
      {scenario.downtimes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted">🔧 Stoppages</span>
          {scenario.downtimes.map((dwn, i) => (
            <span key={i} className="pill pill-warn tabnum">
              {SEG_LABEL[dwn.stage]} {ddShort(dwn.fromISO)}{dwn.toISO !== dwn.fromISO && `–${ddShort(dwn.toISO)}`}
              <button onClick={() => removeDowntime(i)} className="ml-1 font-bold hover:opacity-70" title="remove">✕</button>
            </span>
          ))}
        </div>
      )}

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

      {/* ================= view filters ================= */}
      <div className="bg-surface border rounded-xl px-3.5 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 no-print">
        <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Filter view</span>
        <input
          value={fq}
          onChange={(e) => setFq(e.target.value)}
          placeholder="Search code…"
          className="w-36 border rounded-md px-2.5 py-1.5 text-sm bg-surface"
        />
        <select value={fItem} onChange={(e) => setFItem(e.target.value)} className="border rounded-md px-2 py-1.5 text-sm bg-surface">
          <option value="">All items</option>
          {[...new Set(inputs.jobs.map((j) => j.item))].map((it) => <option key={it} value={it}>{it}</option>)}
        </select>
        <select value={fStage} onChange={(e) => setFStage(e.target.value)} className="border rounded-md px-2 py-1.5 text-sm bg-surface" title="show jobs that still have work at this station">
          <option value="">All stations</option>
          {Object.entries(SEG_LABEL).map(([k, label]) => <option key={k} value={k}>needs {label}</option>)}
        </select>
        <button
          onClick={() => setFLate((v) => !v)}
          className={`btn btn-sm ${fLate ? "btn-primary" : "btn-secondary"}`}
          title="only jobs forecast to miss their due date"
        >
          ⚠ Late only
        </button>
        <span className="text-xs text-muted tabnum">{shownJobs.length} of {result.jobs.length} jobs</span>
        {filterActive && (
          <button onClick={resetFilters} className="btn btn-ghost btn-sm">✕ Clear</button>
        )}
        <span className="text-[10px] text-muted ml-auto">
          filters change what&apos;s SHOWN — every job still holds its place in the queue, so the dates stay honest
        </span>
      </div>
      {dueDays.length > 0 && (
        <DateSlicer
          mode="range" label="Due" from={fFrom || null} to={fTo || null} min={dueMin} max={dueMax}
          presets={slicerPresets(["overdue", "next7", "next30"], inputs.todayISO, dueMin).filter((p) => p.from <= p.to && p.to >= dueMin && p.from <= dueMax)}
          allLabel="Any due date" marks={dueDays} onChange={(f, t) => { setFFrom(f ?? ""); setFTo(t ?? ""); }}
        />
      )}

      {/* ================= timeline ================= */}
      <Timeline result={result} baseline={baseline} inputs={inputs} workFridays={scenario.workFridays} shownIds={shownIds} blackouts={blackouts} />

      {/* ================= queue ================= */}
      <div className="bg-surface border rounded-xl overflow-x-auto">
        <div className="flex items-center gap-3 px-4 pt-2.5 pb-1.5">
          <h2 className="text-sm">Queue — one row per component job</h2>
          <span className="text-[10px] text-muted">drag to reorder · ✂ rushes part of a quantity ahead</span>
          <label className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer no-print">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="accent-[var(--brand)]" />
            Group by order
          </label>
        </div>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-center">
              <th className="p-2 w-24 text-left">Queue</th>
              <th className="p-2 text-left">BOM</th>
              <th className="p-2 text-left">Job</th>
              <th className="p-2">Due</th>
              <th className="p-2">ETA now</th>
              {pinned && <th className="p-2">ETA A 📌</th>}
              <th className="p-2">ETA if…</th>
              <th className="p-2">Shift</th>
              <th className="p-2 w-16 no-print"></th>
            </tr>
          </thead>
          <tbody>
            {result.jobs.length === 0 && (
              <tr><td colSpan={pinned ? 9 : 8} className="p-4 text-center text-muted">No open jobs to simulate.</td></tr>
            )}
            {result.jobs.length > 0 && shownJobs.length === 0 && (
              <tr><td colSpan={pinned ? 9 : 8} className="p-4 text-center text-muted">No jobs match the filters.</td></tr>
            )}
            {tableRows.map((row) => {
              if ("moHeader" in row) {
                const worstIso = row.jobs.reduce<string | null>((m, j) => (j.etaISO && (!m || j.etaISO > m) ? j.etaISO : m), null);
                const anyLate = row.jobs.some((j) => j.late);
                return (
                  <Fragment key={`g-${row.moHeader}`}>
                    <tr className="bg-surface-2/60">
                      <td colSpan={pinned ? 9 : 8} className="px-3 py-1.5 text-xs">
                        <b title={row.moHeader}>{row.bom}</b>
                        <span className="ml-3 text-muted">order clears</span>{" "}
                        <b className="tabnum" style={{ color: anyLate ? "var(--bad-fg)" : undefined }}>{anyLate && "⚠ "}{dd(worstIso)}</b>
                        <span className="ml-3 text-[10px] text-muted">({row.jobs.length} jobs — switch off grouping to reorder)</span>
                      </td>
                    </tr>
                    {row.jobs.map((j) => jobRow(j, -1))}
                  </Fragment>
                );
              }
              return jobRow(row, queueIndexOf.get(row.id) ?? -1);
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted">
        A sandbox — nothing here is saved or promised. Rates come from what the plant actually produced over the last {inputs.rateWindowDays} working
        days; adding workers scales a stage&apos;s speed in proportion to its capacity figure (Admin → Standard Times). The queue schedules component
        jobs top-down; ✂ splitting hands the rushed batch the pieces closest to done. ⚡ Optimize reorders to miss as few due dates as this scenario&apos;s
        speed allows (then least total delay, then earliest finish).
      </p>
    </div>
  );

  function bandTitle(id: string): string | undefined {
    const b = bandById.get(id);
    if (!b?.early || !b.late || b.early === b.late) return undefined;
    return `on the plant's fast/slow days: ${dd(b.early)} – ${dd(b.late)}`;
  }

  function jobRow(o: ResultJob, queueIndex: number) {
    const pin = pinById ? pinById.get(o.id) ?? pinById.get(o.baseId) : null;
    const draggable = queueIndex >= 0;
    return (
      <tr
        key={o.id}
        draggable={draggable}
        onDragStart={(e) => { if (!draggable) return; dragId.current = o.id; e.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(e) => { if (!draggable) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOver !== o.id) setDragOver(o.id); }}
        onDragLeave={() => dragOver === o.id && setDragOver(null)}
        onDrop={(e) => { if (!draggable) return; e.preventDefault(); dropOn(o.id); }}
        onDragEnd={() => { dragId.current = null; setDragOver(null); }}
        className={`${queueIndex % 2 ? "bg-zebra" : ""} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
        style={dragOver === o.id ? { boxShadow: "inset 0 2px 0 var(--brand)" } : undefined}
      >
        <td className="p-1.5 whitespace-nowrap">
          {draggable ? (
            <>
              <span className="text-muted select-none mr-1" title="drag to reorder">⠿</span>
              <button onClick={() => moveJob(o.id, -1)} disabled={queueIndex === 0} className="px-1 text-accent font-bold disabled:opacity-20" title="work it sooner">↑</button>
              <span className="tabnum text-xs text-muted">{queueIndex + 1}</span>
              <button onClick={() => moveJob(o.id, +1)} disabled={queueIndex === result.jobs.length - 1} className="px-1 text-accent font-bold disabled:opacity-20" title="work it later">↓</button>
            </>
          ) : (
            <span className="pl-4 text-[10px] text-muted tabnum">#{result.jobs.findIndex((x) => x.id === o.id) + 1}</span>
          )}
        </td>
        <td className="p-2 font-bold whitespace-nowrap">{o.bom}</td>
        <td className="p-2 whitespace-nowrap" title={o.mo}>
          <b style={{ color: "var(--accent)" }}>{o.item}</b>
          <span className="tabnum text-xs"> ×{o.qty}</span>
          {o.batch !== null && <span className="pill pill-muted ml-1 tabnum" title="batch of a split quantity">b{o.batch}</span>}
        </td>
        <td className="p-2 text-center tabnum whitespace-nowrap">{dd(o.dueISO)}</td>
        <td className="p-2 text-center tabnum whitespace-nowrap">
          {o.done ? <span className="text-ok-fg font-bold">✓ done</span> : o.baselineISO ? dd(o.baselineISO) : <span title="a stage this job needs has no recent history">?</span>}
        </td>
        {pinned && (
          <td className="p-2 text-center tabnum whitespace-nowrap">
            {!pin || pin.done ? (
              <span className="text-ok-fg">✓</span>
            ) : pin.blockedBy ? (
              "?"
            ) : (
              <span style={{ color: pin.late ? "var(--bad-fg)" : undefined }}>{pin.late && "⚠ "}{dd(pin.etaISO)}</span>
            )}
          </td>
        )}
        <td className="p-2 text-center tabnum whitespace-nowrap font-bold">
          {o.done ? (
            <span className="text-ok-fg">✓</span>
          ) : o.blockedBy ? (
            <span className="text-muted" title="a stage this job needs has no recent history">?</span>
          ) : (
            <span
              style={{ color: o.late ? "var(--bad-fg)" : o.deltaDays < 0 ? "var(--ok-fg)" : undefined }}
              title={bandTitle(o.id)}
            >
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
        <td className="p-1.5 text-center no-print whitespace-nowrap">
          {!o.done && o.batch === null && o.qty > 1 && (
            <button onClick={() => splitJob(o)} className="text-accent text-xs font-semibold px-1 hover:underline" title="rush part of this quantity ahead">✂ split</button>
          )}
          {o.batch !== null && (
            <button onClick={() => unsplitJob(o.baseId)} className="text-muted text-xs font-semibold px-1 hover:underline" title="merge the batches back into one job">merge</button>
          )}
          {!o.done && (
            scenario.holds[o.baseId] ? (
              <button onClick={() => setHold(o)} className="pill pill-warn tabnum ml-0.5" title="material hold — click to change or remove">
                ⏳ {ddShort(scenario.holds[o.baseId])}
              </button>
            ) : (
              <button onClick={() => setHold(o)} className="text-muted text-xs px-1 hover:underline opacity-60 hover:opacity-100" title="waiting for material/parts? set the day it arrives">⏳</button>
            )
          )}
        </td>
      </tr>
    );
  }
}
