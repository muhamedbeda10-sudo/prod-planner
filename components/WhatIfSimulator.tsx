"use client";

import { formatDate, formatDateTime, formatDayShort } from "@/lib/domain/format";
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
import { deptLabel, STAGE_COLOR, type Item } from "@/lib/domain/constants";
import { ITEM_PRODUCT, productColor } from "@/lib/domain/productColors";
import { SearchBox, FilterSelect } from "@/components/FilterControls";
import { TableEmpty, TableFrame, Th, useAsk, useConfirm } from "@/components/DataTable";
import { Tooltip } from "@/components/Tooltip";
import { Check, FilterX, Minus, Pin, Plus, RotateCcw, Save, Trash2, Wrench, Zap } from "lucide-react";

/* The control room: turn the knobs — workers per stage, working Fridays, a
   hand-reordered (drag & drop) queue, split quantities, or one click of the
   optimizer — and the KPIs, the station timeline and every ETA respond
   instantly, with the SAME arithmetic the live pages use. The queue schedules
   JOBS (one component of one order), so the TC of an order can jump ahead
   while its TN waits, and a job can split into a rushed batch + the rest.
   Pin a scenario as "A" to compare against it. Nothing here is saved. */

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");
const dd = (iso: string | null) => formatDate(iso);
const ddShort = (iso: string) => formatDayShort(iso);
/** A component's colour: the product it is (TN → Tank's), the same on every page. */
const itemTint = (item: string) => productColor(ITEM_PRODUCT[item as Item]);

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
    <div className="kpi">
      <div className="filter-label">{label}</div>
      <div className="kpi-value mt-1" style={{ color }}>{value}</div>
      {pinned !== undefined && <div className="text-xs font-semibold tabnum mt-0.5" style={{ color: "var(--accent)" }}>📌 A: {pinned}</div>}
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
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

  const LABEL_W = 184;
  const ROW_H = 28;
  const axisDays = Math.max(1, Math.ceil(Math.max(result.makespan, ...rows.map((o) => o.dueOffset ?? 0))) + 1);
  const PX = Math.max(18, Math.floor((avail - LABEL_W - 90) / axisDays));
  const tickEvery = Math.max(1, Math.ceil(64 / PX));
  const width = axisDays * PX + 90;

  return (
    <section className="bg-surface border rounded-[10px] overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 pb-2 border-b">
        <h2 className="!mb-0">Station timeline</h2>
        <span className="text-xs text-muted">one row per component job · each bar is one station holding it · the axis counts working days</span>
        <span className="flex flex-wrap items-center gap-3 ms-auto text-xs text-muted">
          {Object.entries(SEG_LABEL).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-2.5 rounded-sm" style={{ background: SEG_COLOR[k] }} aria-hidden />{label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="text-bad-fg font-bold" aria-hidden>▼</span>due</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-1 rounded-full bg-muted/50" aria-hidden />today&apos;s plan</span>
        </span>
      </div>
      {/* the rows scroll inside the card: the job names stay on the left,
          the dates stay on top */}
      <div ref={scrollRef} className="overflow-auto max-h-[70vh] overscroll-contain">
        <div className="relative" style={{ width: LABEL_W + width }}>
          {/* the date axis */}
          <div className="sticky top-0 z-20 flex h-7 bg-surface-2 border-b">
            <div className="sticky left-0 z-30 shrink-0 bg-surface-2 border-r px-3 flex items-center filter-label" style={{ width: LABEL_W }}>Job</div>
            <div className="relative" style={{ width }}>
              {Array.from({ length: axisDays }, (_, i) => i % tickEvery === 0 && (
                <span key={i} className="absolute top-1.5 ps-1 text-[11px] text-muted tabnum whitespace-nowrap" style={{ left: i * PX }}>
                  {ddShort(dateForOffsetISO(i + 1, inputs.todayISO, holidays, workFridays))}
                </span>
              ))}
            </div>
          </div>
          <div className="flex">
            {/* the job names */}
            <div className="sticky left-0 z-10 shrink-0 bg-surface border-r" style={{ width: LABEL_W }}>
              {rows.map((o) => (
                <div key={o.id} className="flex items-center gap-1.5 px-3 whitespace-nowrap overflow-hidden border-b border-[var(--border)]/50" style={{ height: ROW_H }} title={`${o.mo} · ${o.bom} ${o.item} ×${o.qty}`}>
                  <span className="inline-block w-1 h-3.5 rounded-sm shrink-0" style={{ background: itemTint(o.item) }} aria-hidden />
                  <span className="text-xs font-semibold truncate">{o.bom}</span>
                  <span className="text-[11px] font-bold shrink-0">{o.item}</span>
                  <span className="text-[11px] text-muted tabnum shrink-0">×{o.qty}{o.batch !== null && ` b${o.batch}`}</span>
                </div>
              ))}
            </div>
            {/* the bars */}
            <div className="relative" style={{ width, height: rows.length * ROW_H }}>
              {Array.from({ length: axisDays + 1 }, (_, i) => (
                <div key={i} className="absolute top-0 bottom-0 border-l" style={{ left: i * PX, borderColor: "var(--border)", opacity: i % tickEvery ? 0.3 : 0.8 }} />
              ))}
              {rows.map((o, r) => (
                <div key={`z${o.id}`} className="absolute inset-x-0 border-b border-[var(--border)]/50" style={{ top: r * ROW_H, height: ROW_H }} />
              ))}
              {/* station stoppages — the shaded strips nothing can run through */}
              {(Object.entries(blackouts) as [EtaStage, StageBlackout[]][]).flatMap(([stage, bls]) =>
                (bls ?? []).map((b, i) => (
                  <div
                    key={`bl-${stage}-${i}`}
                    className="absolute top-0 bottom-0 rounded"
                    style={{ left: b.start * PX, width: Math.max(2, (b.end - b.start) * PX), background: SEG_COLOR[stage], opacity: 0.13, border: `1px dashed ${SEG_COLOR[stage]}` }}
                    title={`${SEG_LABEL[stage]} stopped`}
                  />
                ))
              )}
              {rows.map((o, r) => {
                const top = r * ROW_H;
                const end = o.segments[o.segments.length - 1].end;
                const bEnd = baseEnd.get(o.id) ?? baseEnd.get(o.baseId);
                return (
                  <div key={o.id}>
                    {bEnd !== null && bEnd !== undefined && Math.abs(bEnd - end) > 0.05 && (
                      <div
                        className="absolute h-1 rounded-full opacity-40"
                        style={{ top: top + 21, left: 0, width: bEnd * PX, background: "var(--muted)" }}
                        title={`today's plan: clears in ${fmt(bEnd)} working days`}
                      />
                    )}
                    {o.segments.map((sg, i) => (
                      <div
                        key={i}
                        className="absolute h-3.5 rounded-[3px]"
                        style={{ top: top + 6, left: sg.start * PX, width: Math.max(3, (sg.end - sg.start) * PX - 1), background: SEG_COLOR[sg.stage] }}
                        title={`${o.bom} ${o.item}: ${SEG_LABEL[sg.stage]} day ${fmt(sg.start)} → ${fmt(sg.end)}`}
                      />
                    ))}
                    <span
                      className="absolute text-[11px] font-semibold tabnum whitespace-nowrap"
                      style={{ top: top + 5, left: end * PX + 5, color: o.late ? "var(--bad-fg)" : "var(--muted)" }}
                    >
                      {o.late && "⚠ "}{dd(o.etaISO)}
                    </span>
                    {o.dueOffset !== null && o.dueOffset > 0 && (
                      <span className="absolute text-bad-fg font-bold text-[10px] leading-none" style={{ top: top + 1, left: o.dueOffset * PX - 4 }} title={`due ${dd(o.dueISO)}`}>
                        ▼
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
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
  const [ask, askDialog] = useAsk();
  const [confirmIt, confirmDialog] = useConfirm();
  const setHold = async (row: ResultJob) => {
    const cur = scenario.holds[row.baseId];
    const v = await ask({
      title: `Material hold — ${row.bom} ${row.item}`,
      body: "The job cannot start before its material or parts arrive.",
      fields: [{ name: "day", label: "Arrives on", type: "date", defaultValue: cur ?? "", min: inputs.todayISO, hint: cur ? "Clear the date to remove the hold." : undefined }],
      confirmLabel: cur ? "Save hold" : "Set hold",
    });
    if (!v) return;
    const iso = v.day;
    setScenario((sc) => {
      const holds = { ...sc.holds };
      if (!iso) delete holds[row.baseId];
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return sc;
        holds[row.baseId] = iso;
      }
      return { ...sc, holds };
    });
  };

  const addDowntime = async (stage: WiStage) => {
    const es: EtaStage = stage === "Cut" ? "cut" : stage === "Welding" ? "weld" : "finish";
    const v = await ask({
      title: `${deptLabel(stage)} stoppage`,
      body: "Maintenance or a breakdown: nothing runs through this station on these days.",
      fields: [
        { name: "from", label: "From", type: "date", required: true, defaultValue: inputs.todayISO },
        { name: "to", label: "Until (inclusive)", type: "date", required: true, defaultValue: inputs.todayISO },
      ],
      confirmLabel: "Add stoppage",
    });
    if (!v) return;
    const { from, to } = v;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
      return setActionMsg("The stoppage's end is before its start — nothing added.");
    }
    setScenario((sc) => ({ ...sc, downtimes: [...sc.downtimes, { stage: es, fromISO: from, toISO: to }] }));
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

  const saveCurrent = async () => {
    const v = await ask({
      title: "Save this scenario",
      body: describeScenario(scenario, inputs),
      fields: [{ name: "name", label: "Name", type: "text", required: true, defaultValue: describeScenario(scenario, inputs).slice(0, 40) }],
      confirmLabel: "Save",
    });
    const name = v?.name;
    if (!name) return;
    const fd = new FormData();
    fd.set("name", name);
    fd.set("data", JSON.stringify(scenario));
    runAction(() => saveScenario(fd), `saved "${name}"`);
  };

  const deleteSaved = async () => {
    const v = await ask({
      title: "Delete a saved scenario",
      fields: [{ name: "name", label: "Scenario", type: "select", required: true, options: savedScenarios.map((x) => ({ value: x.name, label: x.savedBy ? `${x.name} — ${x.savedBy}` : x.name })) }],
      confirmLabel: "Delete scenario",
      danger: true,
    });
    const name = v?.name;
    if (!name) return;
    const fd = new FormData();
    fd.set("name", name);
    runAction(() => deleteScenario(fd), `deleted "${name}"`);
  };

  // commit the CURRENT queue (as simulated) as the factory's run order
  const applyCurrent = async () => {
    const open = result.jobs.filter((j) => !j.done);
    const entries = open.map((j) => ({ mo: j.mo, item: j.item, batchQty: j.batch !== null ? j.qty : null, batchNo: j.batch }));
    if (entries.length === 0) return setActionMsg("Nothing open to commit.");
    const ok = await confirmIt({
      title: `Make this the run order — ${entries.length} jobs?`,
      body: <>Every department worklist will show its slice of this sequence, replacing {appliedRunOrder ? "the run order that is live now" : "the plain due-date order"}. In order:</>,
      items: open.map((j, i) => `${i + 1}. ${j.bom} ${j.item} ×${j.qty}${j.batch !== null ? ` (batch ${j.batch})` : ""} — ${j.mo}`),
      confirmLabel: `Apply ${entries.length} jobs`,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("entries", JSON.stringify(entries));
    runAction(() => applyRunOrder(fd), "run order is live on the worklists");
  };

  const clearApplied = async () => {
    const ok = await confirmIt({
      title: "Remove the run order?",
      body: <>Every worklist goes back to its plain due-date order. The run order set {appliedRunOrder ? formatDateTime(appliedRunOrder.atISO) : ""}{appliedRunOrder?.by ? ` by ${appliedRunOrder.by}` : ""} is dropped.</>,
      confirmLabel: "Remove run order",
      danger: true,
    });
    if (!ok) return;
    runAction(() => clearRunOrder(), "run order cleared");
  };

  // split an unsplit job: the FIRST batch takes the most-advanced pieces
  const splitJob = async (row: ResultJob) => {
    const v = await ask({
      title: `Split ${row.bom} ${row.item} ×${row.qty}`,
      body: "Rush part of the quantity ahead; the rushed batch takes the pieces closest to done.",
      fields: [{ name: "q", label: `Pieces to rush (1–${row.qty - 1})`, type: "number", required: true, min: "1", max: String(row.qty - 1), step: "1" }],
      confirmLabel: "Split",
    });
    if (!v) return;
    const q = Math.floor(Number(v.q));
    if (!Number.isFinite(q) || q < 1 || q >= row.qty) return;
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

      {askDialog}
      {confirmDialog}
      {/* ================= KPI strip ================= */}
      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
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
                return early && late && early !== late ? <> · likely {ddShort(early)} – {ddShort(late)}</> : null;
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

      {/* ================= the knobs: the scenario's settings, then capacity per station ================= */}
      <section className="bg-surface border rounded-[10px] overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b">
          <h2 className="!mb-0">Scenario</h2>
          <span className="text-xs text-muted min-w-0 truncate">{describeScenario(scenario, inputs)}</span>
          <span className="ms-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={runOptimizer} className="btn btn-primary btn-sm" title="reorder the queue to rescue as many due dates as this scenario's speed allows">
              <Zap size={14} aria-hidden />Optimize queue
            </button>
            <button type="button" onClick={() => setPinned(scenario)} className="btn btn-secondary btn-sm" title="freeze the current scenario as A and compare everything you try next against it">
              <Pin size={14} aria-hidden />Pin as A
            </button>
            <button type="button" onClick={() => setScenario(defaultScenario(inputs))} disabled={!touched} className="btn btn-ghost btn-sm disabled:opacity-40">
              <RotateCcw size={14} aria-hidden />Reset to reality
            </button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 border-b bg-surface-2">
          <label className="inline-flex items-center gap-2">
            <span className="filter-label">Hours / worker / day</span>
            <input
              type="number" min={1} max={24} step="0.5"
              value={scenario.shiftHours}
              onChange={(e) => setScenario((sc) => ({ ...sc, shiftHours: Math.max(1, Number(e.target.value) || 1) }))}
              className="ctl w-16 text-center tabnum"
            />
          </label>
          <button
            type="button" className="chip-toggle" aria-pressed={scenario.workFridays}
            onClick={() => setScenario((sc) => ({ ...sc, workFridays: !sc.workFridays }))}
          >
            Work Fridays
          </button>
          <span className="toolbar-sep" aria-hidden />
          <span className="inline-flex items-center gap-1.5">
            <select
              value=""
              onChange={(e) => {
                const sv = savedScenarios.find((x) => x.name === e.target.value);
                if (sv) setScenario(sanitize(sv.data));
              }}
              className="ctl w-56"
              disabled={pending || savedScenarios.length === 0}
              aria-label="Load a saved scenario"
            >
              <option value="">{savedScenarios.length ? "Load a saved scenario…" : "No saved scenarios yet"}</option>
              {savedScenarios.map((sv) => <option key={sv.name} value={sv.name}>{sv.name}</option>)}
            </select>
            <button type="button" onClick={saveCurrent} disabled={pending} className="icon-btn" aria-label="Save this scenario" title="save the current scenario under a name"><Save size={15} /></button>
            {savedScenarios.length > 0 && (
              <button type="button" onClick={deleteSaved} disabled={pending} className="icon-btn icon-btn-danger" aria-label="Delete a saved scenario" title="delete a saved scenario"><Trash2 size={15} /></button>
            )}
          </span>
          {isAdmin && (
            <button
              type="button" onClick={applyCurrent} disabled={pending} className="btn btn-primary btn-sm"
              title="commit this queue as THE run order — every department worklist will show its slice of it"
            >
              <Check size={14} aria-hidden />Apply as the run order
            </button>
          )}
          {appliedRunOrder && (
            <span className="text-xs text-muted">
              Run order live since {formatDateTime(appliedRunOrder.atISO)}{appliedRunOrder.by ? ` · ${appliedRunOrder.by}` : ""}
              {isAdmin && (
                <button type="button" onClick={clearApplied} disabled={pending} className="text-bad-fg font-semibold hover:underline ms-1.5">Remove</button>
              )}
            </span>
          )}
          {actionMsg && <span className={`text-xs font-semibold ${actionMsg.startsWith("✓") ? "text-ok-fg" : "text-bad-fg"}`} role="status">{actionMsg}</span>}
          {inputs.plan && (
            <span className="text-xs text-muted ms-auto">
              Weekly plan {inputs.plan.planNo} · <b className="text-foreground tabnum">{result.planWorkingDays}</b> working day{result.planWorkingDays === 1 ? "" : "s"} under this scenario
            </span>
          )}
        </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-px bg-[var(--border)]">
            {WI_STAGES.map((st) => {
              const delta = scenario.workersDelta[st];
              const base = inputs.capacity[st];
              const now = base !== undefined ? Math.max(0, base + delta * scenario.shiftHours) : undefined;
              const load = result.stages.find((x) => x.dept === st);
              const tone = load ? loadTone(load.load) : null;
              const changed = load && load.available !== load.baselineAvailable;
              return (
                <div key={st} className="bg-surface px-4 py-3 space-y-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: STAGE_COLOR[st === "ShotBlast" ? "Painting" : st] }} aria-hidden />
                    <span className="font-bold truncate">{deptLabel(st)}</span>
                    <span className="ms-auto text-xs text-muted tabnum whitespace-nowrap">
                      {base === undefined ? "no capacity set" : delta === 0 ? `${fmt(base)} h/day` : <><s className="opacity-60">{fmt(base)}</s> <b style={{ color: delta > 0 ? "var(--ok-fg)" : "var(--bad-fg)" }}>{fmt(now!)}</b> h/day</>}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="filter-label">Workers</span>
                    <span className="inline-flex items-center border border-[var(--border-strong)] rounded-md overflow-hidden h-[30px]">
                      <button type="button" onClick={() => bumpWorkers(st, -1)} className="w-8 h-full grid place-items-center hover:bg-surface-2" aria-label={`One ${deptLabel(st)} worker fewer`} title="one worker fewer"><Minus size={14} /></button>
                      <span className={`min-w-10 px-1 text-center font-extrabold tabnum ${delta > 0 ? "text-ok-fg" : delta < 0 ? "text-bad-fg" : "text-muted"}`} aria-live="polite">
                        {delta > 0 ? `+${delta}` : delta}
                      </span>
                      <button type="button" onClick={() => bumpWorkers(st, +1)} className="w-8 h-full grid place-items-center hover:bg-surface-2" aria-label={`One ${deptLabel(st)} worker more`} title="one worker more"><Plus size={14} /></button>
                    </span>
                    <button type="button" onClick={() => addDowntime(st)} className="btn btn-sm btn-ghost ms-auto" title="Declare a stoppage (maintenance) at this station">
                      <Wrench size={13} aria-hidden />Stoppage
                    </button>
                  </div>
                  {load && load.required > 0 && (
                    <div
                      className="flex items-center gap-2 text-xs"
                      title={`${deptLabel(st)}: the weekly plan needs ${fmt(load.required)} std hours; this scenario offers ${load.available === null ? "no figure" : fmt(load.available) + " hours"} over its window`}
                    >
                      <span className="text-muted">Plan</span>
                      <span className="tabnum"><b>{fmt(load.required)}</b> / {load.available === null ? "—" : fmt(load.available)} h</span>
                      {changed && load.baselineAvailable !== null && <span className="text-muted tabnum">(was {fmt(load.baselineAvailable)})</span>}
                      {tone && <span className="pill tabnum ms-auto" style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* stoppages declared in this scenario */}
          {scenario.downtimes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-t text-xs">
              <span className="filter-label">Stoppages</span>
              {scenario.downtimes.map((dwn, i) => (
                <span key={i} className="pill pill-warn tabnum !h-6 gap-1.5">
                  <Wrench size={12} aria-hidden />
                  <span>{SEG_LABEL[dwn.stage]} · {ddShort(dwn.fromISO)}{dwn.toISO !== dwn.fromISO && ` – ${ddShort(dwn.toISO)}`}</span>
                  <button type="button" onClick={() => removeDowntime(i)} className="font-bold hover:opacity-70 ms-0.5" aria-label={`Remove the ${SEG_LABEL[dwn.stage]} stoppage`} title="remove">✕</button>
                </span>
              ))}
            </div>
          )}
      </section>

      {/* ================= view filters ================= */}
      <div className="toolbar toolbar-row no-print !mb-0">
        <SearchBox value={fq} onChange={setFq} placeholder="Search code…" />
        <FilterSelect label="Item" value={fItem} onChange={setFItem} options={[...new Set(inputs.jobs.map((j) => j.item))].map((it) => ({ value: it, label: it }))} />
        <FilterSelect
          label="Station" title="show jobs that still have work at this station" value={fStage} onChange={setFStage}
          options={Object.entries(SEG_LABEL).map(([key, label]) => ({ value: key, label: `needs ${label}` }))}
        />
        <button type="button" onClick={() => setFLate((v) => !v)} className="chip-toggle" aria-pressed={fLate} title="only jobs forecast to miss their due date">
          ⚠ Late only
        </button>
        {filterActive && (
          <button type="button" onClick={resetFilters} className="btn btn-sm btn-ghost text-bad-fg"><FilterX size={13} aria-hidden />Reset filters</button>
        )}
        <span className="ms-auto inline-flex items-center gap-2 text-xs text-muted tabnum">
          <span><b className="text-foreground">{shownJobs.length}</b> of {result.jobs.length} jobs</span>
          <Tooltip content="Filters change what is SHOWN — every job still holds its place in the queue, so the dates stay honest.">
            <span className="dt-hint cursor-help" tabIndex={0} aria-label="About the filters">?</span>
          </Tooltip>
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
      <section className="bg-surface border rounded-[10px] overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2 border-b">
          <h2 className="!mb-0">Queue</h2>
          <span className="text-xs text-muted">one row per component job · drag (or ↑ ↓) to reorder · split rushes part of a quantity ahead</span>
          <button type="button" className="chip-toggle ms-auto no-print" aria-pressed={grouped} onClick={() => setGrouped((v) => !v)}>Group by order</button>
        </div>
        {result.jobs.length === 0 ? (
          <TableEmpty title="No open jobs to simulate" hint="Every planned job is done, or nothing is planned yet." />
        ) : shownJobs.length === 0 ? (
          <TableEmpty
            title="No jobs match the filters"
            action={<button type="button" className="btn btn-sm btn-secondary" onClick={resetFilters}><FilterX size={13} aria-hidden />Reset filters</button>}
            filtered
          />
        ) : (
        <TableFrame>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <Th label="Queue" className="w-28" />
              <Th label="BOM" />
              <Th label="Job" hint="The component and its quantity; hover for the MO" />
              <Th label="Due" center />
              <Th label="ETA now" hint="Today's reality, no knobs turned" center />
              {pinned && <Th label="ETA A 📌" full="ETA under pinned scenario A" center />}
              <Th label="ETA if…" hint="Under the scenario on screen" center />
              <Th label="Shift" hint="How far the scenario moves this job's ETA" center />
              <th className="p-2 no-print"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row) => {
              if ("moHeader" in row) {
                const worstIso = row.jobs.reduce<string | null>((m, j) => (j.etaISO && (!m || j.etaISO > m) ? j.etaISO : m), null);
                const anyLate = row.jobs.some((j) => j.late);
                return (
                  <Fragment key={`g-${row.moHeader}`}>
                    <tr className="bg-surface-2">
                      <td colSpan={pinned ? 9 : 8} className="px-3 py-1.5 text-xs">
                        <b title={row.moHeader}>{row.bom}</b>
                        <span className="ms-3 text-muted">order clears</span>{" "}
                        <b className="tabnum" style={{ color: anyLate ? "var(--bad-fg)" : undefined }}>{anyLate && "⚠ "}{dd(worstIso)}</b>
                        <span className="ms-3 text-muted">({row.jobs.length} jobs — switch off grouping to reorder)</span>
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
        </TableFrame>
        )}
      </section>

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
        <td className="px-2 whitespace-nowrap">
          {draggable ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="text-muted select-none me-1" title="drag to reorder" aria-hidden>⠿</span>
              <button type="button" onClick={() => moveJob(o.id, -1)} disabled={queueIndex === 0} className="icon-btn !w-6 !h-6" aria-label={`Work ${o.bom} ${o.item} sooner`} title="work it sooner">↑</button>
              <span className="tabnum text-xs text-muted w-7 text-center">{queueIndex + 1}</span>
              <button type="button" onClick={() => moveJob(o.id, +1)} disabled={queueIndex === result.jobs.length - 1} className="icon-btn !w-6 !h-6" aria-label={`Work ${o.bom} ${o.item} later`} title="work it later">↓</button>
            </span>
          ) : (
            <span className="ps-4 text-xs text-muted tabnum">#{result.jobs.findIndex((x) => x.id === o.id) + 1}</span>
          )}
        </td>
        <td className="p-2 font-bold whitespace-nowrap">{o.bom}</td>
        <td className="p-2 whitespace-nowrap" title={o.mo}>
          <span className="inline-block w-1 h-3.5 rounded-sm align-middle me-1.5" style={{ background: itemTint(o.item) }} aria-hidden />
          <b>{o.item}</b>
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
        <td className="px-2 text-end no-print whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
          {!o.done && o.batch === null && o.qty > 1 && (
            <button type="button" onClick={() => splitJob(o)} className="btn btn-sm btn-ghost" title="rush part of this quantity ahead">✂ Split</button>
          )}
          {o.batch !== null && (
            <button type="button" onClick={() => unsplitJob(o.baseId)} className="btn btn-sm btn-ghost" title="merge the batches back into one job">Merge</button>
          )}
          {!o.done && (
            scenario.holds[o.baseId] ? (
              <button type="button" onClick={() => setHold(o)} className="pill pill-warn tabnum" title="material hold — click to change or remove">
                ⏳ {ddShort(scenario.holds[o.baseId])}
              </button>
            ) : (
              <button type="button" onClick={() => setHold(o)} className="btn btn-sm btn-ghost text-muted" title="waiting for material/parts? set the day it arrives">⏳ Hold</button>
            )
          )}
          </span>
        </td>
      </tr>
    );
  }
}
