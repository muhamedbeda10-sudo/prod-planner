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
import { PRODUCT_LINES, type ProductLine } from "./lines";

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
