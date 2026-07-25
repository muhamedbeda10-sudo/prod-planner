// PLAN vs ACTUAL — the weekly plan's promise for each day against what the
// departments actually recorded that day. Pure: the server feeds it rows.
//
// The weekly plan stores ONE dated promise per BOM/MO/item — the oven-loading
// date and its quantity. Each department's own due date is DERIVED from it by
// its lead time (Fabrication `oven − leadCut`, Welding `oven − leadWeld`,
// finishing on the oven date itself), exactly how the worklists schedule the
// floor. Delivery carries no plan date, so it is actual-only.
//
// Only the NEWEST plan's tranches count for a line: a re-import re-promises the
// remaining work under new dates, so superseded dates stop counting (the same
// rule the Fabrication worklist applies).

import { dayNumber } from "./dates";
import { ITEMS, isPaintExempt } from "./constants";

/** Stages the comparison covers, in pipeline order. */
export const PVA_STAGES = ["Cut", "Welding", "Painting", "Delivered"] as const;
export type PvaStage = (typeof PVA_STAGES)[number];
/** Delivery is never plan-dated — its plan column stays blank. */
export const PVA_PLANNED: readonly PvaStage[] = ["Cut", "Welding", "Painting"];

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
  mo: string | null;
  item: string;
  qty: number;
}

export interface PvaCell {
  scheduled: number; // pcs the weekly plan promised for that stage on that day
  done: number; // pcs actually recorded that day (net of corrections)
}
/** One component's plan/actual inside a day or a project — the breakdown that
 *  answers "how many of THIS item were due, and how many did we make". */
export interface PvaItem {
  item: string;
  perStage: Record<string, PvaCell>;
  scheduled: number;
  done: number;
}
export interface PvaDay {
  iso: string;
  label: string; // "Sat 11/07"
  isOff: boolean; // Friday or a factory-calendar day off
  offName: string | null;
  perStage: Record<string, PvaCell>;
  items: PvaItem[]; // only the components with a promise or output that day
  scheduled: number;
  done: number;
}
export interface PvaProject {
  bom: string;
  mos: string[];
  perStage: Record<string, PvaCell>;
  items: PvaItem[]; // per component inside this project
  scheduled: number;
  done: number;
}
export interface PlanVsActual {
  days: PvaDay[];
  projects: PvaProject[];
  totals: Record<string, PvaCell>;
  scheduled: number;
  done: number;
  leadCut: number;
  leadWeld: number;
}

const WEEKDAY = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const dowOf = (d: number) => ((d % 7) + 7) % 7;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const cell = (): PvaCell => ({ scheduled: 0, done: 0 });

/** The stage an actual ledger entry counts under: the core's Shot Blast IS its
 *  finishing, so it lands in Painting (same rule as the rest of the report). */
export function stageOfEntry(dept: string, item: string): PvaStage | null {
  if (dept === "Cut") return "Cut";
  if (dept === "Welding") return "Welding";
  if (dept === "Painting") return "Painting";
  if (dept === "ShotBlast") return isPaintExempt(item) ? "Painting" : null;
  if (dept === "Delivered") return "Delivered";
  return null;
}

export function computePlanVsActual(opts: {
  schedules: PvaScheduleRow[]; // EVERY plan — supersession needs the older ones
  entries: PvaEntryRow[]; // ledger rows inside the range
  fromDay: number; // dayNumber of the first day
  toDay: number; // dayNumber of the last day (inclusive)
  isoOf: (day: number) => string;
  holidays: Map<number, string>;
  leadCut: number;
  leadWeld: number;
  stages?: readonly string[]; // the report's Dept filter
}): PlanVsActual {
  const { schedules, entries, fromDay, toDay, isoOf, holidays, leadCut, leadWeld } = opts;
  const shown = PVA_STAGES.filter((s) => (opts.stages ?? PVA_STAGES).includes(s));
  const leadOf = (s: PvaStage) => (s === "Cut" ? leadCut : s === "Welding" ? leadWeld : 0);

  // ---- only the NEWEST plan's tranches count for each line ----
  const maxPlan = new Map<string, number>();
  for (const s of schedules) {
    const k = `${s.bom}|${s.mo}|${s.item}`;
    const cur = maxPlan.get(k);
    if (cur === undefined || s.planNo > cur) maxPlan.set(k, s.planNo);
  }

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
      scheduled: 0,
      done: 0,
    });
  }

  const projects = new Map<string, PvaProject>();
  const projectOf = (bom: string, mo: string | null) => {
    let p = projects.get(bom);
    if (!p) {
      p = { bom, mos: [], perStage: Object.fromEntries(shown.map((s) => [s, cell()])), items: [], scheduled: 0, done: 0 };
      projects.set(bom, p);
    }
    if (mo && !p.mos.includes(mo)) p.mos.push(mo);
    return p;
  };
  const totals: Record<string, PvaCell> = Object.fromEntries(shown.map((s) => [s, cell()]));

  // per-component breakdown, accumulated alongside the roll-ups:
  // "<dayNumber>|<item>" and "<bom>|<item>" → stage cells
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
  /** Components in pipeline order, then anything unexpected the ledger holds. */
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
        const scheduled = shown.reduce((s, st) => s + perStage[st].scheduled, 0);
        const done = shown.reduce((s, st) => s + perStage[st].done, 0);
        return { item, perStage, scheduled, done };
      })
      .filter((r) => r.scheduled !== 0 || r.done !== 0)
      .sort((a, b) => itemOrder(a.item, b.item));

  // ---- scheduled: each stage's own due day, derived from the oven date ----
  for (const s of schedules) {
    if (s.planNo !== maxPlan.get(`${s.bom}|${s.mo}|${s.item}`)) continue; // superseded promise
    if (!s.qty) continue;
    const ovenD = dayNumber(s.ovenDate);
    for (const stage of shown) {
      if (!PVA_PLANNED.includes(stage)) continue; // delivery has no plan date
      const d = ovenD - leadOf(stage);
      const row = days.get(d);
      if (!row) continue;
      row.perStage[stage].scheduled += s.qty;
      row.scheduled += s.qty;
      const p = projectOf(s.bom, s.mo);
      p.perStage[stage].scheduled += s.qty;
      p.scheduled += s.qty;
      totals[stage].scheduled += s.qty;
      bucket(dayItems, `${d}|${s.item}`)[stage].scheduled += s.qty;
      bucket(projItems, `${s.bom}|${s.item}`)[stage].scheduled += s.qty;
    }
  }

  // ---- actual: what the departments recorded on each day ----
  for (const e of entries) {
    const stage = stageOfEntry(e.dept, e.item);
    if (!stage || !shown.includes(stage) || !e.qty) continue;
    const d = dayNumber(e.date);
    const row = days.get(d);
    if (!row) continue;
    row.perStage[stage].done += e.qty;
    row.done += e.qty;
    const p = projectOf(e.bom, e.mo);
    p.perStage[stage].done += e.qty;
    p.done += e.qty;
    totals[stage].done += e.qty;
    bucket(dayItems, `${d}|${e.item}`)[stage].done += e.qty;
    bucket(projItems, `${e.bom}|${e.item}`)[stage].done += e.qty;
  }

  // attach each row's per-component breakdown
  for (const [d, row] of days) row.items = collect(dayItems, String(d));
  for (const p of projects.values()) p.items = collect(projItems, p.bom);

  return {
    days: [...days.values()],
    // biggest promise first, then the busiest — the rows worth reading on top
    projects: [...projects.values()].sort((a, b) => b.scheduled - a.scheduled || b.done - a.done),
    totals,
    scheduled: shown.reduce((s, st) => s + totals[st].scheduled, 0),
    done: shown.reduce((s, st) => s + totals[st].done, 0),
    leadCut,
    leadWeld,
  };
}
