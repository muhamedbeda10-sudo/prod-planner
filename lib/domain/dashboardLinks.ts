// The addresses of the two plant dashboards — Planning (/) and Production
// (/dashboards/production). Each shows both product lines on one page: the
// plant's figures first, then a section per line (#tr, #lv) that a link can
// open at. They take no line of their own; a `?line=` an older link carries
// is left alone.

import { isLvFloorDept, type LvFloorFilter } from "./lvKpis";

/** The dashboards that show both lines on one page — no line rides onto them. */
export const BOTH_LINES_PATHS: ReadonlySet<string> = new Set(["/", "/dashboards/production"]);

/** A line's section on either dashboard — the anchor a link opens at. */
export type DashSection = "tr" | "lv";
export const DASH_SECTION_ID: Record<"TR" | "LV", DashSection> = { TR: "tr", LV: "lv" };

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

/** The Production dashboard over a period: the transformers' department in
 *  `dept`, the panels' in `lvDept` — each section keeps its own. */
export function productionHref(o: { from?: string | null; to?: string | null; dept?: string | null; lvDept?: string | null; section?: DashSection } = {}): string {
  return href("/dashboards/production", { from: o.from, to: o.to, dept: o.dept === "all" ? null : o.dept, lvDept: o.lvDept === "all" ? null : o.lvDept }, o.section);
}

/** The panels' department a Production address picks (`lvDept`). */
export function lvDeptOfSearch(sp: Search): LvFloorFilter {
  const lv = one(sp, "lvDept");
  return isLvFloorDept(lv) ? lv : "all";
}

/** Where an older Production link belongs — one from when the page showed one
 *  line, naming the panels' department in `dept`: the same view, its
 *  department moved to `lvDept`, opened at the panels' section. Null: stay. */
export function productionLegacyRedirect(sp: Search): string | null {
  const dept = one(sp, "dept");
  if (!isLvFloorDept(dept)) return null;
  return productionHref({ from: one(sp, "from"), to: one(sp, "to"), lvDept: one(sp, "lvDept") ?? dept, section: "lv" });
}

/** Where an old link to the floor's figures on the Planning page belongs: a
 *  department moved to the Production dashboard, so an address naming one
 *  lands there with its period. A period alone stays — the panels' stage
 *  table on Planning reads it. Null: stay. */
export function productionRedirectOf(sp: Search): string | null {
  const dept = one(sp, "dept");
  if (!dept) return null;
  return isLvFloorDept(dept)
    ? productionHref({ from: one(sp, "from"), to: one(sp, "to"), lvDept: dept, section: "lv" })
    : productionHref({ from: one(sp, "from"), to: one(sp, "to"), dept });
}
