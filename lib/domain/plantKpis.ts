// The whole plant on one dashboard — the two lines added up only where
// adding is honest, side by side everywhere else. Pure, tested; the pages
// and the assistant read the same rules.
//
//   - Efficiency over several parts is Σ earned ÷ Σ worked — never the mean
//     of the parts' rates (a small department would weigh as much as a big one).
//   - Standard hours add up across lines when both are priced the same way
//     (each line's share of output that carries hours says how far); pieces
//     never do — a panel is not a tank, and a component is not a transformer.
//   - The shot-blast crew is one and is booked on the transformers' side,
//     earning the panels' blasting too (lib/server/kpis.ts); the machines and
//     their stops are recorded by department, the punches shared. So the
//     plant's stops are the transformers' read, counted once, and nothing is
//     split between the lines without a record that says so.

import { combinedStat, peopleShort, type CockpitAction, type ManpowerRow } from "./kpis";
import { LINE_LABEL, PRODUCT_LINES, type ProductLine } from "./lines";
import { round1 } from "./shifts";

export interface LinePart {
  line: ProductLine;
  earnedH: number;
  workedH: number;
  /** Person-days over the recorded days. */
  personDays: number;
  /** Recorded days. */
  days: number;
  /** Share of the output that carries standard hours; null with no output. */
  pricedShare: number | null;
}

export interface PlantEfficiency {
  earnedH: number;
  workedH: number;
  /** Σ earned ÷ Σ worked; null without worked hours. */
  efficiency: number | null;
  stdPerPersonDay: number | null;
  personDays: number;
  /** A line whose figures are missing or only partly priced — said on the card. */
  notes: string[];
}


/** What one line's period contributes to the plant's figures. */
export function linePart(line: ProductLine, period: { summary: { earnedH: number; workedH: number; personDays: number; days: number }; pricedShare: number | null }): LinePart {
  return { line, earnedH: period.summary.earnedH, workedH: period.summary.workedH, personDays: period.summary.personDays, days: period.summary.days, pricedShare: period.pricedShare };
}

/** The plant's efficiency from the lines' sums. Each line's coverage of
 *  standard hours is noted when it falls short, since an unpriced piece
 *  earns nothing and reads as slow. */
export function plantEfficiency(parts: readonly LinePart[], o: { pricedFloor?: number } = {}): PlantEfficiency {
  const floor = o.pricedFloor ?? 0.95;
  const earnedH = parts.reduce((s, p) => s + p.earnedH, 0);
  const workedH = parts.reduce((s, p) => s + p.workedH, 0);
  const personDays = parts.reduce((s, p) => s + p.personDays, 0);
  const notes: string[] = [];
  for (const p of parts) {
    if (p.days === 0) notes.push(`${LINE_LABEL[p.line]}: no shift day recorded in the period — its side is missing from the total.`);
    else if (p.pricedShare !== null && p.pricedShare < floor) notes.push(`${LINE_LABEL[p.line]}: ${Math.round(p.pricedShare * 100)}% of its output carries standard hours — the rest earns nothing here.`);
  }
  return {
    earnedH: round1(earnedH),
    workedH: round1(workedH),
    efficiency: workedH > 0 ? earnedH / workedH : null,
    stdPerPersonDay: personDays > 0 ? earnedH / personDays : null,
    personDays,
    notes,
  };
}

/** The plant's Planning headline, from the two lines' own figures — one
 *  function for the page and the assistant, so they never disagree. People
 *  add (each line has its own departments); each line's recent efficiency
 *  is its own, the plant's the sums' ratio. */
export interface PlantPlanningSummary {
  peopleShort: { TR: number; LV: number; total: number };
  recentEfficiency: { TR: number | null; LV: number | null; plant: number | null };
}

export function plantPlanningSummary(
  tr: { manpower: readonly Pick<ManpowerRow<string>, "tone" | "gap">[]; recent: readonly { workedH: number; earnedH: number }[] },
  lv: { manpower: readonly Pick<ManpowerRow<string>, "tone" | "gap">[]; recent: readonly { workedH: number; earnedH: number }[] },
): PlantPlanningSummary {
  const trShort = peopleShort(tr.manpower), lvShort = peopleShort(lv.manpower);
  const t = combinedStat(tr.recent), l = combinedStat(lv.recent);
  return {
    peopleShort: { TR: trShort, LV: lvShort, total: trShort + lvShort },
    recentEfficiency: { TR: t.efficiency, LV: l.efficiency, plant: combinedStat([t, l]).efficiency },
  };
}

/** Decisions of both lines as one list, each tagged with its line, the worst
 *  first and the lines interleaved within a tone — never more than `max`. */
export function mergeActions(tr: readonly CockpitAction[], lv: readonly CockpitAction[], max = 8): (CockpitAction & { line: ProductLine })[] {
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  const order = (line: ProductLine) => PRODUCT_LINES.indexOf(line);
  const tag = (list: readonly CockpitAction[], line: ProductLine) => list.map((a, i) => ({ ...a, line, i }));
  return [...tag(tr, "TR"), ...tag(lv, "LV")]
    .sort((a, b) => rank[a.tone] - rank[b.tone] || order(a.line) - order(b.line) || a.i - b.i)
    .slice(0, max)
    .map((a) => ({ tone: a.tone, text: a.text, href: a.href, line: a.line, ...(a.floor ? { floor: true as const } : {}) }));
}

/** One day of the plant's output: each line's standard hours side by side,
 *  the man-hours added — the chart's point (components/CockpitCharts OutputPoint). */
export interface PlantOutputDay {
  dateISO: string;
  earnedH: number;
  workedH: number;
  efficiency: number | null;
  values: Record<ProductLine, number>;
}

/** The two lines' days merged by date, oldest first: standard hours stack,
 *  man-hours add, the day's efficiency is the sums' ratio. */
export function plantDailyOutput(tr: readonly { dateISO: string; earnedH: number; workedH: number }[], lv: readonly { dateISO: string; earnedH: number; workedH: number }[]): PlantOutputDay[] {
  const byDay = new Map<string, PlantOutputDay>();
  const at = (iso: string) => {
    if (!byDay.has(iso)) byDay.set(iso, { dateISO: iso, earnedH: 0, workedH: 0, efficiency: null, values: { TR: 0, LV: 0 } });
    return byDay.get(iso)!;
  };
  for (const [line, days] of [["TR", tr], ["LV", lv]] as const) {
    for (const d of days) {
      const o = at(d.dateISO);
      o.values[line] += d.earnedH;
      o.earnedH += d.earnedH;
      o.workedH += d.workedH;
    }
  }
  return [...byDay.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO)).map((o) => ({ ...o, efficiency: o.workedH > 0 ? o.earnedH / o.workedH : null }));
}
