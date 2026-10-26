// The addresses of the two plant dashboards — Planning (/) and Production
// (/dashboards/production). Both show both product lines: Planning a section
// per line (#tr, #lv) that a link can open at, Production a line switch of
// its own (All | TR | LV, ?scope=). They take no ?line= (BOTH_LINES in
// lib/domain/lines.ts): the proxy sends an older address naming one to that
// line's section, or on Production to its scope.

import type { LineSection } from "./lines";

/** A line's section on either dashboard — the anchor a link opens at. */
export type DashSection = LineSection;

type Search = Record<string, string | string[] | undefined>;
const one = (sp: Search, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

/** A dashboard's address with its filters (empty ones left out), opened at a line's section. */
function href(path: string, params: Record<string, string | null | undefined>, section?: DashSection): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}${section ? `#${section}` : ""}`;
}

/** The Planning dashboard, opened at a line's section. */
export function planningHref(section?: DashSection): string {
  return href("/", {}, section);
}

/** The Production dashboard over a period and a choice: the line (`scope`,
 *  or a line's section on an older call), a department — one names its line,
 *  so the panels' alone travels in `dept` — a work centre and a shift. Each
 *  line's own department (`dept` and `lvDept`) keeps both on All. */
export function productionHref(o: {
  from?: string | null; to?: string | null; scope?: string | null; dept?: string | null; lvDept?: string | null;
  centre?: string | null; shift?: string | null; section?: DashSection;
} = {}): string {
  const scope = o.scope ?? (o.section === "lv" ? "LV" : o.section === "tr" ? "TR" : null);
  const dept = o.dept && o.dept !== "all" ? o.dept : null;
  const lvDept = o.lvDept && o.lvDept !== "all" ? o.lvDept : null;
  return href("/dashboards/production", {
    from: o.from, to: o.to,
    // a department names its line: the scope is only written where it says more
    scope: scope === "all" || dept || (lvDept && !dept) ? null : scope,
    dept: dept ?? lvDept,
    lvDept: dept && lvDept ? lvDept : null,
    centre: o.centre, shift: o.shift === "both" ? null : o.shift,
  });
}

/** Where an old link to the floor's figures on the Planning page belongs: a
 *  department moved to the Production dashboard, so an address naming one
 *  lands there with its period (the panels' department names its line
 *  there too). A period alone stays — the panels' stage table on Planning
 *  reads it. Null: stay. */
export function productionRedirectOf(sp: Search): string | null {
  const dept = one(sp, "dept");
  if (!dept) return null;
  return productionHref({ from: one(sp, "from"), to: one(sp, "to"), dept });
}
