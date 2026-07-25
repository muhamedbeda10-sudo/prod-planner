// PLAN vs ACTUAL — for the work DUE on a day, how much of it is actually done.
// Pure: the server feeds it rows.
//
// The weekly plan stores ONE dated promise per BOM/MO/item — the oven-loading
// date and its quantity. Each department's own due date is DERIVED from it by
// its lead time (Fabrication `oven − leadCut`, Welding `oven − leadWeld`,
// finishing on the oven date itself), exactly how the worklists schedule the
// floor. Delivery carries no plan date and is out of scope here.
//
// Two different questions, two different columns:
//   • DUE    — what the plan promised for that stage on that day.
//   • DONE   — how much OF THAT PROMISE is covered. Output is credited to the
//              promises FIFO (oldest date first), exactly like the Fabrication
//              worklist consumes its tranches, measured as of the END of the
//              reported period. So a day reads 100% once its own promise is
//              covered, whether the work happened that day or was caught up.
//   • OUTPUT — what was actually recorded in the period, promise or not (extra
//              or unplanned work shows here and never inflates DONE).
//
// Only the NEWEST plan's tranches count for a line: a re-import re-promises the
// remaining work under new dates, so superseded dates stop counting (the same
// rule the Fabrication worklist applies). Everything is grouped by BOM + item —
// the level the report and the worklists both read at.

import { dayNumber } from "./dates";
import { ITEMS, isPaintExempt } from "./constants";

/** Stages the comparison covers, in pipeline order. Delivery is excluded: the
 *  plan never dates it, so there is nothing to compare it against. */
export const PVA_STAGES = ["Cut", "Welding", "Painting"] as const;
export type PvaStage = (typeof PVA_STAGES)[number];

/** The ledger departments whose output counts towards a stage — the core's
 *  Shot Blast IS its finishing, so it lands under Painting. */
export function deptsOfStage(stage: PvaStage): readonly string[] {
  return stage === "Painting" ? ["Painting", "ShotBlast"] : [stage];
}

/** Which stage a ledger entry counts under (null = outside the comparison). */
export function stageOfEntry(dept: string, item: string): PvaStage | null {
  if (dept === "Cut") return "Cut";
  if (dept === "Welding") return "Welding";
  if (dept === "Painting") return "Painting";
  if (dept === "ShotBlast") return isPaintExempt(item) ? "Painting" : null;
  return null; // Delivered and anything else
}

export interface PvaScheduleRow {
  planNo: number;
  bom: string;
  mo: string;
  item: string;
  ovenDate: Date;
  qty: number;
}
export interface PvaEntryRow {
  date: Date;
  dept: string;
  bom: string;
  item: string;
  qty: number;
}
/** All-time ledger totals per BOM × item × dept, up to the period end — the
 *  credit the promises are filled from. */
export interface PvaCumulativeRow {
  bom: string;
  item: string;
  dept: string;
  qty: number;
}

export interface PvaCell {
  due: number; // pcs the plan promised for that stage on that day
  done: number; // how much OF THAT PROMISE is covered (FIFO, at period end)
  output: number; // pcs actually recorded in the period (promised or not)
}
/** One component's figures inside a day or a project. */
export interface PvaItem {
  item: string;
  perStage: Record<string, PvaCell>;
  due: number;
  done: number;
  output: number;
}
export interface PvaDay {
  iso: string;
  label: string; // "Sat 11/07"
  isOff: boolean; // Friday or a factory-calendar day off
  offName: string | null;
  perStage: Record<string, PvaCell>;
  items: PvaItem[]; // only the components with a promise or output that day
  due: number;
  done: number;
  output: number;
}
export interface PvaProject {
  bom: string;
  perStage: Record<string, PvaCell>;
  items: PvaItem[];
  due: number;
  done: number;
  output: number;
}
export interface PlanVsActual {
  days: PvaDay[];
  projects: PvaProject[];
  totals: Record<string, PvaCell>;
  due: number;
  done: number;
  output: number;
  leadCut: number;
  leadWeld: number;
}

const WEEKDAY = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const dowOf = (d: number) => ((d % 7) + 7) % 7;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const cell = (): PvaCell => ({ due: 0, done: 0, output: 0 });

export function computePlanVsActual(opts: {
  schedules: PvaScheduleRow[]; // EVERY plan — supersession needs the older ones
  entries: PvaEntryRow[]; // ledger rows INSIDE the period (drives `output`)
  cumulative: PvaCumulativeRow[]; // ledger totals up to the period END (fills the promises)
  fromDay: number;
  toDay: number; // inclusive
  isoOf: (day: number) => string;
  holidays: Map<number, string>;
  leadCut: number;
  leadWeld: number;
  stages?: readonly string[]; // the report's Dept filter
}): PlanVsActual {
  const { schedules, entries, cumulative, fromDay, toDay, isoOf, holidays, leadCut, leadWeld } = opts;
  const shown = PVA_STAGES.filter((s) => (opts.stages ?? PVA_STAGES).includes(s));
  const leadOf = (s: PvaStage) => (s === "Cut" ? leadCut : s === "Welding" ? leadWeld : 0);

  // ---- 1. the live promises: newest plan per line, grouped by BOM + item ----
  const maxPlan = new Map<string, number>();
  for (const s of schedules) {
    const k = `${s.bom}|${s.mo}|${s.item}`;
    const cur = maxPlan.get(k);
    if (cur === undefined || s.planNo > cur) maxPlan.set(k, s.planNo);
  }
  type Line = { tranches: { ovenD: number; qty: number; filled: number }[]; oldQty: number };
  const lines = new Map<string, Line>(); // "bom|item"
  const lineOf = (bom: string, item: string) => {
    let l = lines.get(`${bom}|${item}`);
    if (!l) {
      l = { tranches: [], oldQty: 0 };
      lines.set(`${bom}|${item}`, l);
    }
    return l;
  };
  for (const s of schedules) {
    if (!s.qty) continue;
    const l = lineOf(s.bom, s.item);
    // a superseded promise is dead, but the output that already covered it must
    // not be re-spent on the live tranches — park it as credit to burn first
    if (s.planNo !== maxPlan.get(`${s.bom}|${s.mo}|${s.item}`)) l.oldQty += s.qty;
    else l.tranches.push({ ovenD: dayNumber(s.ovenDate), qty: s.qty, filled: 0 });
  }
  for (const l of lines.values()) l.tranches.sort((a, b) => a.ovenD - b.ovenD);

  // ---- 2. fill the promises FIFO from the all-time output, per stage ----
  // (each stage has its own ledger total, so each gets its own fill pass)
  const doneOf = new Map<string, number>(); // "bom|item|dept" -> all-time qty
  for (const c of cumulative) doneOf.set(`${c.bom}|${c.item}|${c.dept}`, (doneOf.get(`${c.bom}|${c.item}|${c.dept}`) ?? 0) + c.qty);
  /** How many pcs of each tranche this stage has covered, oldest promise first. */
  const fillFor = (stage: PvaStage, bom: string, item: string, l: Line): number[] => {
    let credit = deptsOfStage(stage).reduce((s, d) => s + (doneOf.get(`${bom}|${item}|${d}`) ?? 0), 0);
    credit = Math.max(0, credit - l.oldQty); // superseded promises are paid first
    return l.tranches.map((t) => {
      const used = Math.min(Math.max(0, credit), t.qty);
      credit -= used;
      return used;
    });
  };

  // ---- 3. the rows ----
  const days = new Map<number, PvaDay>();
  for (let d = fromDay; d <= toDay; d++) {
    const iso = isoOf(d);
    const holiday = holidays.get(d);
    days.set(d, {
      iso,
      label: `${WEEKDAY[dowOf(d)]} ${ddmm(iso)}`,
      isOff: dowOf(d) === 1 || holiday !== undefined, // dowOf 1 = Friday
      offName: holiday ?? null,
      perStage: Object.fromEntries(shown.map((s) => [s, cell()])),
      items: [],
      due: 0,
      done: 0,
      output: 0,
    });
  }

  const projects = new Map<string, PvaProject>();
  const projectOf = (bom: string) => {
    let p = projects.get(bom);
    if (!p) {
      p = { bom, perStage: Object.fromEntries(shown.map((s) => [s, cell()])), items: [], due: 0, done: 0, output: 0 };
      projects.set(bom, p);
    }
    return p;
  };
  const totals: Record<string, PvaCell> = Object.fromEntries(shown.map((s) => [s, cell()]));

  // per-component buckets: "<dayNumber>|<item>" and "<bom>|<item>"
  const dayItems = new Map<string, Record<string, PvaCell>>();
  const projItems = new Map<string, Record<string, PvaCell>>();
  const bucket = (m: Map<string, Record<string, PvaCell>>, key: string) => {
    let b = m.get(key);
    if (!b) {
      b = Object.fromEntries(shown.map((s) => [s, cell()]));
      m.set(key, b);
    }
    return b;
  };

  /** Add a figure everywhere it belongs: the day row, the project row, the two
   *  component buckets and the stage total — one place, so they can't drift. */
  const add = (field: keyof PvaCell, d: number | null, bom: string, item: string, stage: PvaStage, qty: number) => {
    if (!qty) return;
    if (d !== null) {
      const row = days.get(d);
      if (!row) return;
      row.perStage[stage][field] += qty;
      row[field] += qty;
      bucket(dayItems, `${d}|${item}`)[stage][field] += qty;
    }
    const p = projectOf(bom);
    p.perStage[stage][field] += qty;
    p[field] += qty;
    bucket(projItems, `${bom}|${item}`)[stage][field] += qty;
    totals[stage][field] += qty;
  };

  // DUE + DONE — every live promise whose stage-day falls inside the period
  for (const [key, l] of lines) {
    const sep = key.lastIndexOf("|");
    const bom = key.slice(0, sep);
    const item = key.slice(sep + 1);
    for (const stage of shown) {
      const filled = fillFor(stage, bom, item, l);
      l.tranches.forEach((t, i) => {
        const d = t.ovenD - leadOf(stage);
        if (d < fromDay || d > toDay) return;
        add("due", d, bom, item, stage, t.qty);
        add("done", d, bom, item, stage, filled[i]);
      });
    }
  }

  // OUTPUT — what was actually recorded inside the period
  for (const e of entries) {
    const stage = stageOfEntry(e.dept, e.item);
    if (!stage || !shown.includes(stage)) continue;
    add("output", dayNumber(e.date), e.bom, e.item, stage, e.qty);
  }

  // ---- 4. attach the component breakdowns ----
  const itemOrder = (a: string, b: string) => {
    const ia = (ITEMS as readonly string[]).indexOf(a);
    const ib = (ITEMS as readonly string[]).indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  };
  const collect = (m: Map<string, Record<string, PvaCell>>, prefix: string): PvaItem[] =>
    [...m.entries()]
      .filter(([k]) => k.startsWith(`${prefix}|`))
      .map(([k, perStage]) => {
        const item = k.slice(prefix.length + 1);
        const sum = (f: keyof PvaCell) => shown.reduce((s, st) => s + perStage[st][f], 0);
        return { item, perStage, due: sum("due"), done: sum("done"), output: sum("output") };
      })
      .filter((r) => r.due !== 0 || r.output !== 0)
      .sort((a, b) => itemOrder(a.item, b.item));
  for (const [d, row] of days) row.items = collect(dayItems, String(d));
  for (const p of projects.values()) p.items = collect(projItems, p.bom);

  return {
    days: [...days.values()],
    // biggest promise first, then the busiest — the rows worth reading on top
    projects: [...projects.values()]
      .filter((p) => p.due !== 0 || p.output !== 0)
      .sort((a, b) => b.due - a.due || b.output - a.output),
    totals,
    due: shown.reduce((s, st) => s + totals[st].due, 0),
    done: shown.reduce((s, st) => s + totals[st].done, 0),
    output: shown.reduce((s, st) => s + totals[st].output, 0),
    leadCut,
    leadWeld,
  };
}
