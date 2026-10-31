// The plant's one dashboard (the home page, /): the plan — will we make it,
// where is the shortfall — and the floor — what we made, at what efficiency —
// on one page under one bar. One address carries both: the line (?scope=),
// the department (?dept=, a centre ?centre=, the panels' ?lvDept=) and the
// period (?from=&to=) are shared; the plan's own filters (?plan=, ?item=,
// ?q=, ?family=) and the floor's (?shift=, ?stage=) are each side's alone.
// A department names its line, so the scope both sides show is the floor's
// request's (productionRequest) — the plan reads the same line and the
// department's centre, so the two halves never show different choices.
// Pure; the page and the assistant read it.

import type { CockpitAction } from "./kpis";
import { isWorkCentre, type WorkCentre } from "./shifts";
import { productionRequest, type ProductionRequest } from "./productionDashboard";
import { planningFiltersOf, scopeOfLine, type PlanningFilters } from "./planningDashboard";
import { one, type Search } from "./dashboardLinks";
import { lineParam, type ProductLine } from "./lines";

/** The page's address read once for both halves. The line switch is written
 *  lower case (tr, lv) and read either way — an older Production link wrote it
 *  upper case. */
export function plantDashboardOf(sp: Search, todayISO: string): { f: PlanningFilters; req: ProductionRequest } {
  const req = productionRequest({ ...sp, scope: lineParam(one(sp, "scope")) ?? undefined }, todayISO);
  const base = planningFiltersOf(sp);
  return {
    req,
    f: { ...base, scope: scopeOfLine(req.scope === "all" ? null : req.scope), centre: planCentreOf(req), lvDept: req.lvDept === "all" ? null : req.lvDept },
  };
}

/** The plan's work centre for the floor's choice: the centre named, else a
 *  department that is one centre (welding, shot blast, painting). Fabrication
 *  as a whole is three centres — the plan stays whole for it. */
export function planCentreOf(req: Pick<ProductionRequest, "centre" | "trDept">): WorkCentre | null {
  if (req.centre) return req.centre;
  return req.trDept !== "all" && isWorkCentre(req.trDept) ? req.trDept : null;
}

/** The plan's decisions and the floor's interventions in the bar's one list.
 *  With the floor's figures on the page, the plan's own floor warnings (a
 *  centre slow over its last recorded days, the week's biggest machine loss)
 *  are left out — the floor's list says the same over the chosen period. The
 *  worst first, each line's order kept; a sentence said twice is said once. */
export function dashboardActions(
  plan: readonly (CockpitAction & { line: ProductLine })[],
  floor: readonly (CockpitAction & { line: ProductLine })[] | null,
  max = 10,
): (CockpitAction & { line: ProductLine })[] {
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  const kept = floor ? plan.filter((a) => !(a.floor && a.tone === "warn")) : plan;
  const seen = new Set<string>();
  return [...kept, ...(floor ?? [])]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank[x.a.tone] - rank[y.a.tone] || x.i - y.i)
    .map((x) => x.a)
    .filter((a) => {
      const k = `${a.line}|${a.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max);
}
