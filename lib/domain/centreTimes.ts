// The planner's own hours a piece per work centre — reading the grid he typed.
// Pure: the admin page posts one field per cell, `c:<kva>:<item>:<centre>`,
// and an empty cell means "no figure — keep the estimate".

import { ITEMS, isPaintExempt, type Item } from "./constants";
import { DEPT_CENTRES, isWorkCentre, routeFor, type WorkCentre } from "./shifts";

export interface CentreTimeCell {
  kva: number;
  item: Item;
  center: WorkCentre;
}

export interface CentreTimeEdits {
  set: (CentreTimeCell & { hoursPerPc: number })[];
  clear: CentreTimeCell[];
}

const FIELD = /^c:(\d+):([A-Z]{2}):([A-Za-z]+)$/;
/** The posted field of one cell — the grid and the assistant both build it here. */
export const centreField = (kva: number, item: string, center: WorkCentre) => `c:${kva}:${item}:${center}`;

/** Whether an item has hours at a centre at all: never the core's painting,
 *  and at Fabrication only the centres its route passes (a top cover is
 *  never bent). */
export function centreApplies(item: string, center: WorkCentre): boolean {
  if (center === "Painting" && isPaintExempt(item as Item)) return false;
  if (DEPT_CENTRES.Cut.includes(center)) return routeFor("Cut", item).includes(center);
  return true;
}
/** The most hours one piece may take at one centre — past it is a typo. */
export const MAX_CENTRE_HOURS = 200;

/** The cells of a posted grid, or what is wrong with the first bad one.
 *  Only classes in `classes` are taken; the core's painting is never set. */
export function readCentreTimes(entries: Iterable<[string, unknown]>, classes: ReadonlySet<number>): CentreTimeEdits | { error: string } {
  const out: CentreTimeEdits = { set: [], clear: [] };
  for (const [k, raw] of entries) {
    const m = FIELD.exec(k);
    if (!m) continue;
    const kva = Number(m[1]);
    const item = m[2];
    const center = m[3];
    if (!classes.has(kva)) return { error: `There is no ${kva} kVA class — reload the page.` };
    if (!(ITEMS as readonly string[]).includes(item) || !isWorkCentre(center)) continue;
    if (!centreApplies(item, center)) continue;
    const cell = { kva, item: item as Item, center };
    const text = String(raw ?? "").trim();
    if (!text) {
      out.clear.push(cell);
      continue;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return { error: `"${text}" is not a time — give the hours one piece takes, or leave the cell empty.` };
    if (n > MAX_CENTRE_HOURS) return { error: `${n} hours for one ${item} at one centre is more than ${MAX_CENTRE_HOURS} — check the figure.` };
    out.set.push({ ...cell, hoursPerPc: Math.round(n * 1000) / 1000 });
  }
  return out;
}
