// Standard-hours engine — every function takes the data as an argument.
//
// At runtime the data comes from the DATABASE (seeded from the engineering
// timings sheet, edited in Admin → Standard Times); the tests feed it the
// generated seed directly. The one thing that stays engineering-owned in code
// is the per-item SHARE of a class's hours (lib/domain/standardTimes.ts):
// the admin edits a class's STAGE totals and every component's share follows,
// rather than asking anyone to maintain a 4×3 matrix per class by hand.

import { isPaintExempt, type Item } from "./constants";
import { KVA_TIERS, TIER_ITEM_HOURS, type TierStageHours } from "./standardTimes";
import { DEPT_CENTRES, WORK_CENTRES, centerShares, routeFor, type WorkCentre } from "./shifts";

/** Per-piece hours of ONE component across the chain. EVERY component passes
 *  Shot Blast before its finish — the paint-exempt core ends there (paint = 0),
 *  the painted components (TC/TN/CB) continue to the paint line. */
export interface ItemStageHours { cut: number; weld: number; shb: number; paint: number }

/** The planner's own hours a piece at some work centres — typed by hand. */
export type CentreHours = Partial<Record<WorkCentre, number>>;

export interface StdData {
  tiers: Record<number, TierStageHours>; // KVA class -> stage hours per tank
  fgMap: Record<string, number>; // normalized FG code -> KVA class
  /** KVA class -> item -> hours a piece typed per work centre (Admin →
   *  Standard Times → Hours per work centre). Each figure replaces the estimate
   *  for that centre; the rest of the item keeps the estimate. */
  centre?: Record<number, Record<string, CentreHours>>;
}

export const normFg = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Nearest KVA class in `classes` for a numeric KVA (ties go DOWN — matches
 *  the sheet's bias for in-between sizes more often than rounding up would). */
export function nearestTierIn(classes: number[], kva: number): number | null {
  let best: number | null = null;
  for (const t of classes) {
    if (best === null || Math.abs(t - kva) < Math.abs(best - kva) || (Math.abs(t - kva) === Math.abs(best - kva) && t < best)) {
      best = t;
    }
  }
  return best;
}

/** Resolve an order to a KVA class: the FG map first (exact, then without a
 *  trailing M-revision), the numeric KVA as fallback. The FG map WINS because
 *  the sheet files in-between sizes inconsistently (250→200 but 400→500). */
export function tierForOrder(data: StdData, order: { fgCode?: string | null; kva?: string | null }): number | null {
  if (order.fgCode) {
    const key = normFg(order.fgCode);
    if (data.fgMap[key] !== undefined && data.tiers[data.fgMap[key]]) return data.fgMap[key];
    const base = key.replace(/M\d+$/, "");
    if (base !== key && data.fgMap[base] !== undefined && data.tiers[data.fgMap[base]]) return data.fgMap[base];
  }
  const kva = Number(String(order.kva ?? "").replace(/[^0-9.]/g, ""));
  if (Number.isFinite(kva) && kva > 0) return nearestTierIn(Object.keys(data.tiers).map(Number), kva);
  return null;
}

/** Per-piece hours for each base component of a class: the class's (possibly
 *  admin-edited) stage totals, split by the engineering shares of the nearest
 *  SEED class. Row/column sums always return the class's own totals.
 *
 *  Finishing splits across BOTH finishing work centres, because every
 *  component passes Shot Blast before paint: the core's whole finishing IS its
 *  shot blast, and the class's remaining SHB hours spread over the painted
 *  components in proportion to their finishing shares — so Σshb = the class's
 *  shb total and Σpaint = its paint total. */
export function itemHoursFor(data: StdData, tier: number): Record<string, ItemStageHours> {
  const base = estimatedItemHoursFor(data, tier);
  const typed = data.centre?.[tier];
  if (!typed) return base;
  const out: Record<string, ItemStageHours> = { ...base };
  for (const [item, hrs] of Object.entries(typed)) {
    const c = itemCentreHours(base[item], item, hrs);
    out[item] = { cut: c.Cutting + c.Bending + c.Fins, weld: c.Welding, shb: c.ShotBlast, paint: c.Painting };
  }
  return out;
}

/** One item's hours a piece at every work centre: what was typed, else the
 *  stage's estimate — Fabrication's split over the centres the item routes
 *  through, in proportion to their crews. */
function itemCentreHours(base: ItemStageHours | undefined, item: string, typed: CentreHours = {}): Record<WorkCentre, number> {
  const b = base ?? { cut: 0, weld: 0, shb: 0, paint: 0 };
  const shares = centerShares("Cut", item);
  const est: Record<WorkCentre, number> = {
    Cutting: (shares.Cutting ?? 0) * b.cut,
    Bending: (shares.Bending ?? 0) * b.cut,
    Fins: (shares.Fins ?? 0) * b.cut,
    Welding: b.weld,
    ShotBlast: b.shb,
    Painting: isPaintExempt(item as Item) ? 0 : b.paint,
  };
  const out = { ...est };
  const route = routeFor("Cut", item);
  for (const c of WORK_CENTRES) {
    const v = typed[c];
    if (v === undefined || !Number.isFinite(v) || v < 0) continue;
    if (c === "Painting" && isPaintExempt(item as Item)) continue; // the core is never painted
    if (DEPT_CENTRES.Cut.includes(c) && !route.includes(c)) continue; // a centre the item never passes
    out[c] = v;
  }
  return out;
}

/** Per-piece hours of each item at each work centre for a class — what a
 *  centre earns when the piece is recorded at its stage. Fabrication is one
 *  stage on the floor: a piece recorded there has passed every centre of its
 *  route, so each of them earns its share. */
export function itemCentreHoursFor(data: StdData, tier: number): Record<string, Record<WorkCentre, number>> {
  const base = estimatedItemHoursFor(data, tier);
  const typed = data.centre?.[tier] ?? {};
  const out: Record<string, Record<WorkCentre, number>> = {};
  for (const item of new Set([...Object.keys(base), ...Object.keys(typed)])) out[item] = itemCentreHours(base[item], item, typed[item]);
  return out;
}

/** The per-centre hours WITHOUT anything typed — what an empty cell falls back to. */
export function estimatedItemCentreHoursFor(data: StdData, tier: number): Record<string, Record<WorkCentre, number>> {
  return itemCentreHoursFor({ ...data, centre: undefined }, tier);
}

/** How ONE piece's stage hours divide over the centres of its route: in
 *  proportion to its hours at each (typed, else the estimate). Outside
 *  Fabrication a stage is one centre. Without a class, the crews' split. */
export function stageShares(data: StdData, tier: number | null, dept: string, item: string): Record<string, number> {
  if (dept !== "Cut" || tier === null) return centerShares(dept, item);
  const c = itemCentreHoursFor(data, tier)[item];
  const route = routeFor("Cut", item);
  const total = c ? route.reduce((s, r) => s + (c[r as WorkCentre] ?? 0), 0) : 0;
  if (!c || !(total > 0)) return centerShares(dept, item);
  return Object.fromEntries(route.map((r) => [r, (c[r as WorkCentre] ?? 0) / total]));
}

/** The estimate alone: the class's stage totals split by the engineering shares. */
export function estimatedItemHoursFor(data: StdData, tier: number): Record<string, ItemStageHours> {
  const t = data.tiers[tier];
  if (!t) return {};
  // shares come from the seed matrix — nearest seed class when the admin
  // added a class the sheet never had
  const shareTier = nearestTierIn([...KVA_TIERS], tier)!;
  const seed = TIER_ITEM_HOURS[shareTier];
  const seedFab = Object.values(seed).reduce((s, p) => s + p.cut + p.weld, 0);
  const seedFin = Object.values(seed).reduce((s, p) => s + p.finish, 0);

  // first pass: fab split + each item's total finishing
  const finish: Record<string, number> = {};
  const out: Record<string, ItemStageHours> = {};
  for (const [it, p] of Object.entries(seed)) {
    const fabShare = (p.cut + p.weld) / seedFab;
    finish[it] = (p.finish / seedFin) * (t.shb + t.paint);
    out[it] = { cut: fabShare * t.cut, weld: fabShare * t.weld, shb: 0, paint: 0 };
  }

  // second pass: the finishing → shb/paint split. The core takes its whole
  // finishing as shot blast; what remains of the class's SHB hours spreads
  // over the painted components, and their paint is the rest of their finishing.
  const coreShb = Object.keys(seed)
    .filter((it) => isPaintExempt(it as Item))
    .reduce((s, it) => s + finish[it], 0);
  const paintedFin = Object.keys(seed)
    .filter((it) => !isPaintExempt(it as Item))
    .reduce((s, it) => s + finish[it], 0);
  const shbLeft = Math.max(0, t.shb - coreShb);
  for (const it of Object.keys(seed)) {
    if (isPaintExempt(it as Item)) {
      out[it].shb = finish[it]; // the core is never painted
    } else {
      const shb = paintedFin > 0 ? (finish[it] / paintedFin) * shbLeft : 0;
      out[it].shb = Math.min(shb, finish[it]);
      out[it].paint = finish[it] - out[it].shb;
    }
  }
  return out;
}

/** Standard hours ONE PIECE of `item` earns when `dept` records it — 0 when
 *  there is no figure (AR/MB, unresolved order, non-production stage).
 *  A Painting entry earns shb + paint: the app records no separate shot-blast
 *  step for painted components, so "painted" MEANS "shot blasted then painted"
 *  and the entry carries both work centres' hours. */
export function stdHoursFor(data: StdData, dept: string, item: string, tier: number | null): number {
  if (tier === null) return 0;
  const per = itemHoursFor(data, tier)[item];
  if (!per) return 0; // AR / MB — no standard times
  if (dept === "Cut") return per.cut;
  if (dept === "Welding") return per.weld;
  if (dept === "ShotBlast") return isPaintExempt(item as Item) ? per.shb : 0;
  if (dept === "Painting") return isPaintExempt(item as Item) ? 0 : per.shb + per.paint;
  return 0; // Delivered and anything else — not a production stage
}

/** Required standard hours per stage for a set of plan lines (item + qty per
 *  order), for the capacity check. Unresolvable lines are summed separately so
 *  the caller can SAY how much of the plan the figures cover. */
export function requiredHoursForLines(
  data: StdData,
  lines: { item: string; qty: number; order: { fgCode?: string | null; kva?: string | null } | null }[]
): { byStage: Record<"Cut" | "Welding" | "ShotBlast" | "Painting", number>; uncoveredPcs: number; totalPcs: number } {
  const byStage = { Cut: 0, Welding: 0, ShotBlast: 0, Painting: 0 };
  let uncoveredPcs = 0;
  let totalPcs = 0;
  for (const l of lines) {
    const tier = l.order ? tierForOrder(data, l.order) : null;
    const per = tier === null ? undefined : itemHoursFor(data, tier)[l.item];
    // AR / MB carry no standard time unless the planner typed one
    if (!per && (l.item === "AR" || l.item === "MB")) continue;
    totalPcs += l.qty;
    if (!per) {
      uncoveredPcs += l.qty;
      continue;
    }
    byStage.Cut += per.cut * l.qty;
    byStage.Welding += per.weld * l.qty;
    // EVERY component loads the shot-blast station before its finish — the
    // painted ones then load the paint line with the rest of their finishing
    byStage.ShotBlast += per.shb * l.qty;
    byStage.Painting += per.paint * l.qty;
  }
  return { byStage, uncoveredPcs, totalPcs };
}
