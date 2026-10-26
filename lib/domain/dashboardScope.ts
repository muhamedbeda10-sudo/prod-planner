// Which line a DASHBOARD shows — the two dashboards of the Dashboards tab
// (Planning and Production) can show the transformers, the LV panels, or the
// whole plant at once. Every other screen records or runs ONE line, chosen
// by the toggle in the nav (a cookie, lib/server/line.ts), so this scope is
// a URL parameter of the dashboards alone (?line=all|TR|LV): a dashboard
// opened without it shows the line the toggle is on, and picking "All" here
// never moves the toggle.

import { isProductLine, type ProductLine } from "./lines";

export const DASH_SCOPES = ["all", "TR", "LV"] as const;
export type DashScope = (typeof DASH_SCOPES)[number];

export const DASH_SCOPE_LABEL: Record<DashScope, string> = { all: "All", TR: "TR", LV: "LV" };
export const DASH_SCOPE_TITLE: Record<DashScope, string> = {
  all: "The whole plant — the plant's summary, then the two lines side by side",
  TR: "Transformers — tanks, covers, core frames and cable boxes",
  LV: "LV panels — the low-voltage substations and meter boxes",
};
/** How a scope reads in a sentence. */
export const DASH_SCOPE_NAME: Record<DashScope, string> = { all: "Whole plant", TR: "Transformers", LV: "LV Panels" };


/** The scope a dashboard's address asks for — `all`, a line, or (nothing or
 *  anything else) the line the toggle is on. Case does not matter. */
export function resolveDashScope(raw: unknown, active: ProductLine): DashScope {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return active;
  const u = v.trim();
  if (u.toLowerCase() === "all") return "all";
  const up = u.toUpperCase();
  return isProductLine(up) ? up : active;
}

/** A dashboard address with its scope and filters: `line` is written only
 *  when it is not the toggle's own line (so a bare address keeps following
 *  the toggle); empty values are left out. */
export function dashHref(path: string, scope: DashScope, active: ProductLine, params: Record<string, string | null | undefined> = {}): string {
  const q = new URLSearchParams();
  if (scope !== active) q.set("line", scope);
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Where an old link to the Planning page belongs now: the floor's figures
 *  moved to the Production dashboard, so an address naming a department, or
 *  a period on a scope whose Planning reads none (the transformers', the
 *  plant's), lands there with its filters. The panels' Planning reads a
 *  period for its stage table, so a period alone stays there. Null: stay. */
export function productionRedirectOf(sp: Record<string, string | string[] | undefined>, scope: DashScope): string | null {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const dept = one("dept");
  const period = one("from") ?? one("to");
  if (!dept && !(period && scope !== "LV")) return null;
  const q = new URLSearchParams();
  for (const k of ["from", "to", "dept", "line"]) {
    const v = one(k);
    if (v) q.set(k, v);
  }
  return `/dashboards/production?${q}`;
}
