// Cross-page links that have to remember WHERE the reader came from.
//
// The Plan Tracker is two tables behind one route: /tracker is the monthly
// registry, /tracker?view=weekly is one weekly plan. So a plain `plan=30` on a
// link back to the tracker is not enough — the tracker would open monthly and
// the reader who came from the weekly plan would land on the wrong table. The
// view travels with the link instead.

/** Where a "back to the tracker" link should point. */
export function trackerHref(planNo = 0, view?: string): string {
  const qs = new URLSearchParams();
  if (view === "weekly") qs.set("view", "weekly");
  // the monthly table has no plan concept — the number is only meaningful to
  // the weekly view (and harmless elsewhere, which is the existing behaviour)
  if (planNo > 0) qs.set("plan", String(planNo));
  const s = qs.toString();
  return s ? `/tracker?${s}` : "/tracker";
}

/** A /trace link for one MO or BOM, carrying the origin so the trip back lands
 *  on the table it started from. `mo` wins when both are given — that is the
 *  narrower scope, and it is what the trace page itself prefers. */
export function traceHref(target: { mo?: string | null; bom?: string | null }, planNo = 0, view?: string): string {
  const qs = new URLSearchParams();
  if (target.mo) qs.set("mo", target.mo);
  else if (target.bom) qs.set("bom", target.bom);
  if (planNo > 0) qs.set("plan", String(planNo));
  if (view === "weekly") qs.set("view", "weekly");
  return `/trace?${qs.toString()}`;
}
