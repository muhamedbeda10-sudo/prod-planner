// The addresses of the plant's dashboard (/) — the plan and the floor on one
// page (lib/domain/plantDashboard.ts), both lines with one switch (All | TR |
// LV, ?scope=), a section per line under All (#tr, #lv) that a link can open
// at. It takes no ?line= (BOTH_LINES in lib/domain/lines.ts): the proxy sends
// an older address naming one to that line's section. The floor's choices
// are built here, the plan's by its filters (planningUrl in
// lib/domain/planningDashboard.ts) on the same `href`. The old Production
// dashboard (/dashboards/production) sends its addresses here as they are.

import type { LineSection } from "./lines";

/** A line's section on either dashboard — the anchor a link opens at. */
export type DashSection = LineSection;

export type Search = Record<string, string | string[] | undefined>;
/** One parameter an address carries, as given. */
export const one = (sp: Search, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

/** A dashboard's address with its filters (empty ones left out), opened at a line's section. */
export function href(path: string, params: Record<string, string | null | undefined>, section?: DashSection): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}${section ? `#${section}` : ""}`;
}

/** The dashboard's floor figures over a period and a choice: the line (`scope`,
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
  return href("/", {
    from: o.from, to: o.to,
    // a department names its line: the scope is only written where it says more
    scope: scope === "all" || dept || (lvDept && !dept) ? null : scope?.toLowerCase(),
    dept: dept ?? lvDept,
    lvDept: dept && lvDept ? lvDept : null,
    centre: o.centre, shift: o.shift === "both" ? null : o.shift,
  });
}

/** The old Production dashboard's address on the one dashboard: the same
 *  choices, as they were written (the line switch is read either case). */
export function productionRedirectOf(sp: Search): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) q.set(k, v);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
