// Cross-page links that have to remember WHERE the reader came from.
//
// The Plan Tracker is two tables behind one route: /tracker is the monthly
// registry, /tracker?view=weekly is one weekly plan. So a plain `plan=30` on a
// link back to the tracker is not enough — the tracker would open monthly and
// the reader who came from the weekly plan would land on the wrong table. The
// view travels with the link instead. So does the product line (?line=):
// a link from one line's screen opens on that line, whoever follows it.

import { LINE_PARAM, type ProductLine } from "./lines";

/** Where a "back to the tracker" link should point. */
export function trackerHref(planNo = 0, view?: string, line?: ProductLine): string {
  const qs = new URLSearchParams();
  if (view === "weekly") qs.set("view", "weekly");
  // the monthly table has no plan concept — the number is only meaningful to
  // the weekly view (and harmless elsewhere, which is the existing behaviour)
  if (planNo > 0) qs.set("plan", String(planNo));
  if (line) qs.set(LINE_PARAM, line);
  const s = qs.toString();
  return s ? `/tracker?${s}` : "/tracker";
}

/** A /trace link for one MO or BOM, carrying the origin so the trip back lands
 *  on the table it started from. `mo` wins when both are given — that is the
 *  narrower scope, and it is what the trace page itself prefers. `line` names
 *  the side to trace; without it an MO opens on its own order's line and a
 *  BOM on the reader's. */
export function traceHref(target: { mo?: string | null; bom?: string | null; line?: ProductLine }, planNo = 0, view?: string): string {
  const qs = new URLSearchParams();
  if (target.mo) qs.set("mo", target.mo);
  else if (target.bom) qs.set("bom", target.bom);
  if (planNo > 0) qs.set("plan", String(planNo));
  if (view === "weekly") qs.set("view", "weekly");
  if (target.line) qs.set(LINE_PARAM, target.line);
  return `/trace?${qs.toString()}`;
}

/** The ODOO log over a period (every day when `fromISO` is null), on a line. */
export function odooLogHref(fromISO: string | null, toISO: string, line?: ProductLine): string {
  const qs = new URLSearchParams({ day: fromISO ? (fromISO === toISO ? fromISO : `${fromISO}..${toISO}`) : "all" });
  if (line) qs.set(LINE_PARAM, line);
  return `/odoo?${qs.toString()}`;
}

/** A file of the person's own in the assistant's chat: its download, and the
 *  page that lays a sheet out to print (lib/domain/aiFiles.ts reads them back). */
export const aiFileHref = (id: number) => `/api/ai/files/${id}`;
export const aiPrintHref = (id: number) => `/ai/print/${id}`;
