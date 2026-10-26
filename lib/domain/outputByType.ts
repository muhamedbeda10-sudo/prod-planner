// What the floor made, item by item and type by type, against the month's
// plan — the Production dashboard's tracking card and the assistant's answer
// to "how many 630 kVA tanks did we weld?". Pure; the loaders feed it the
// Daily log's records and the month's orders (lib/server/kpis.ts,
// lib/server/lvKpis.ts).
//
//   - The transformers are tracked by component (Tank, Top Cover, …) and the
//     order's KVA class — the class their standard hours are priced at
//     (tierForOrder) — through cutting, welding and their finishing stage
//     (painting, or shot blast for the core frame).
//   - The panels by their plan (LV panels, meter boxes) and the panel type the
//     plan sheet names (USS, LSS, …) through their four stages.
//   - Pieces add up within one item (a 630 kVA tank and a 1000 kVA tank are
//     both tanks) and never across items or lines.
//   - "Made" is every record of the period, whatever order it was for; the
//     plan is the month's orders, each one's stage capped at what it asks, so
//     an extra piece on one order never covers another's shortfall.

import { ITEMS, ITEM_NAME, applicableItems, finishDeptOf, isItem, ospOf, type ItemRuleFields } from "./constants";
import { STAGES, type Stage } from "./kpis";
import { LV_FAMILY_LABEL, LV_STAGES, LV_STAGE_DONE, isLvFamily, lvStageOf, type LvStage, type LvState } from "./lv";

// The transformers are tracked through the plan's own three stages (kpis.ts
// STAGES), the panels through their four (LV_STAGES); the columns read what
// was done at each.
const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
export const TR_TYPE_STAGE_LABEL: Record<Stage, string> = { cut: "Cut", weld: "Welded", finish: "Finished" };
export const LV_TYPE_STAGE_LABEL = Object.fromEntries(LV_STAGES.map((s) => [s, capital(LV_STAGE_DONE[s])])) as Record<LvStage, string>;

/** The type of an order whose class or panel type the records cannot tell. */
export const NO_CLASS = "No class";
export const NO_TYPE = "No type";

/** One record of the Daily log, as the card counts it. */
export interface TypeRecord<S extends string> {
  item: string;
  type: string;
  stage: S;
  qty: number;
}

/** One line of the month's plan — an order (or a project's component) with
 *  what it asks and what each stage has done on it, ever. */
export interface TypePlanLine<S extends string> {
  item: string;
  type: string;
  required: number;
  done: Partial<Record<S, number>>;
}

export interface TypeRow<S extends string> {
  item: string;
  type: string;
  /** Pieces each stage recorded in the period. */
  made: Record<S, number>;
  /** The month's plan: what it asks, each stage's pieces on it (capped per
   *  line), what is left to finish and the share finished; null when the
   *  type is not on the month's plan. */
  plan: TypePlan<S> | null;
}

/** What the month's plan asks of a type, and how far it is. */
export interface TypePlan<S extends string> { required: number; done: Record<S, number>; left: number; share: number | null }

/** A line's card: its items and types over the period, against one month's plan. */
export interface OutputByTypeData<S extends string> { monthLabel: string; groups: TypeGroup<S>[] }

export interface TypeGroup<S extends string> {
  item: string;
  /** The item's types added up — pieces of one item add, never across items. */
  total: TypeRow<S>;
  types: TypeRow<S>[];
}

const zero = <S extends string>(stages: readonly S[]) => Object.fromEntries(stages.map((s) => [s, 0])) as Record<S, number>;

/** A KVA class as the card names it. */
export function kvaTypeLabel(tier: number | null | undefined): string {
  return tier === null || tier === undefined || !Number.isFinite(tier) ? NO_CLASS : `${tier} kVA`;
}

/** The transformers' stage a Daily log record counts for: cutting, welding,
 *  or the component's own finishing stage — any other record (the shot blast
 *  before a tank's painting, the leak test) is not a stage of this card. */
export function trTypeStageOf(dept: string, item: string): Stage | null {
  if (dept === "Cut") return "cut";
  if (dept === "Welding") return "weld";
  if (dept === finishDeptOf(item)) return "finish";
  return null;
}

/** A panel order's item (its plan) and type (the panel type the sheet names). */
export function lvItemType(o: { product?: string | null; family?: string | null } | null | undefined): { item: string; type: string } {
  const family = o?.family && isLvFamily(o.family) ? o.family : "";
  const type = o?.product?.trim().toUpperCase();
  return { item: LV_FAMILY_LABEL[family], type: type || NO_TYPE };
}

/** A panel order's line of the month's plan, from its position on the chain. */
export function lvPlanLine(o: { product?: string | null; family?: string | null; state: LvState }): TypePlanLine<LvStage> {
  return { ...lvItemType(o), required: o.state.required, done: Object.fromEntries(LV_STAGES.map((s) => [s, lvStageOf(o.state, s)])) as Record<LvStage, number> };
}

/** The item's place in the list: the line's own order, unknown ones after. */
const rankOf = (order: readonly string[]) => (x: string) => {
  const i = order.indexOf(x);
  return i < 0 ? order.length : i;
};

/** Types in reading order: by their number (100 kVA before 1000 kVA), then
 *  by name, the type the records cannot tell last. */
export function compareTypes(a: string, b: string): number {
  const unknown = (x: string) => x === NO_CLASS || x === NO_TYPE;
  if (unknown(a) !== unknown(b)) return unknown(a) ? 1 : -1;
  const na = parseFloat(a), nb = parseFloat(b);
  const ha = Number.isFinite(na), hb = Number.isFinite(nb);
  if (ha && hb && na !== nb) return na - nb;
  if (ha !== hb) return ha ? -1 : 1;
  return a.localeCompare(b);
}

/** What was made and what the month's plan asks, item by item and type by
 *  type, in the line's own item order. A type appears when it made something
 *  in the period or is on the month's plan. */
export function outputByType<S extends string>(
  stages: readonly S[],
  records: readonly TypeRecord<S>[],
  plan: readonly TypePlanLine<S>[],
  itemOrder: readonly string[],
): TypeGroup<S>[] {
  const last = stages[stages.length - 1];
  /** Add a part of the plan (its pieces asked, done per stage, left) to a row. */
  const addPlan = (r: TypeRow<S>, required: number, done: (s: S) => number, left: number) => {
    const p = (r.plan ??= { required: 0, done: zero(stages), left: 0, share: null });
    p.required += required;
    p.left += left;
    for (const s of stages) p.done[s] += done(s);
    p.share = p.required > 0 ? p.done[last] / p.required : null;
  };
  const rows = new Map<string, TypeRow<S>>();
  const row = (item: string, type: string) => {
    const k = `${item}|${type}`;
    if (!rows.has(k)) rows.set(k, { item, type, made: zero(stages), plan: null });
    return rows.get(k)!;
  };
  for (const r of records) {
    if (r.qty === 0 || !stages.includes(r.stage)) continue;
    row(r.item, r.type).made[r.stage] += r.qty;
  }
  for (const l of plan) {
    if (!(l.required > 0)) continue;
    // each line counted up to what it asks
    const doneAt = (s: S) => Math.min(l.required, Math.max(0, l.done[s] ?? 0));
    addPlan(row(l.item, l.type), l.required, doneAt, l.required - doneAt(last));
  }
  const byItem = new Map<string, TypeRow<S>[]>();
  for (const r of rows.values()) {
    // a record taken back (a negative correction) never shows as less than nothing
    for (const s of stages) r.made[s] = Math.max(0, r.made[s]);
    if (!r.plan && stages.every((s) => r.made[s] === 0)) continue;
    if (!byItem.has(r.item)) byItem.set(r.item, []);
    byItem.get(r.item)!.push(r);
  }
  const rank = rankOf(itemOrder);
  return [...byItem.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([item, types]) => {
      types.sort((a, b) => compareTypes(a.type, b.type));
      const total: TypeRow<S> = { item, type: "All types", made: zero(stages), plan: null };
      for (const t of types) {
        for (const s of stages) total.made[s] += t.made[s];
        if (t.plan) addPlan(total, t.plan.required, (s) => t.plan!.done[s], t.plan.left);
      }
      return { item, total, types };
    });
}

/** The transformers' components in the plant's own order, by name. */
export const TR_ITEM_ORDER: readonly string[] = ITEMS.map((i) => ITEM_NAME[i]);
/** The panels' plans in the plant's own order. */
export const LV_ITEM_ORDER: readonly string[] = Object.values(LV_FAMILY_LABEL);

/** A component code as the card names it. */
export const trItemName = (item: string) => (isItem(item) ? ITEM_NAME[item] : item);

/** The transformers' month plan as lines of this card, one per order and
 *  component at the order's class: what it asks (its pieces less the
 *  outsourced ones) and what each stage has recorded on it, ever (an order
 *  carried over brings its work along, as the people's plan counts it). A
 *  record the Daily log's form wrote without an order number fills its
 *  project's orders of that component in turn, each up to what it still
 *  lacks at that stage — the loader picks such rows only for a project with
 *  no other open order (lib/server/kpis.ts readMonthPlanTr). */
export function trPlanLines(
  orders: readonly (ItemRuleFields & Parameters<typeof ospOf>[0] & { mo: string; bom: string; planQty: number })[],
  ledger: readonly { mo: string | null; bom: string; item: string; dept: string; qty: number }[],
  tierOf: (mo: string | null | undefined, bom: string) => number | null,
): TypePlanLine<Stage>[] {
  type Line = TypePlanLine<Stage> & { done: Record<Stage, number> };
  const byOrder = new Map<string, Line>();
  const byProject = new Map<string, Line[]>();
  for (const o of [...orders].sort((a, b) => a.mo.localeCompare(b.mo))) {
    const type = kvaTypeLabel(tierOf(o.mo, o.bom));
    for (const item of applicableItems(o)) {
      const required = Math.max(0, o.planQty - ospOf(o, item));
      if (!(required > 0)) continue;
      const k = `${o.mo}|${item}`;
      const line = byOrder.get(k) ?? { item: trItemName(item), type, required: 0, done: zero(STAGES) };
      if (!byOrder.has(k)) {
        byOrder.set(k, line);
        const project = `${o.bom}|${item}`;
        if (!byProject.has(project)) byProject.set(project, []);
        byProject.get(project)!.push(line);
      }
      line.required += required;
    }
  }
  // a record of the order's own first; then the project's records without one, pooled by component
  const loose = new Map<string, Record<Stage, number>>();
  for (const e of ledger) {
    const stage = trTypeStageOf(e.dept, e.item);
    if (!stage) continue;
    if (e.mo) {
      const line = byOrder.get(`${e.mo}|${e.item}`);
      if (line) line.done[stage] += e.qty;
      continue;
    }
    const k = `${e.bom}|${e.item}`;
    if (!loose.has(k)) loose.set(k, zero(STAGES));
    loose.get(k)![stage] += e.qty;
  }
  for (const [k, pooled] of loose) {
    for (const stage of STAGES) {
      let left = pooled[stage];
      for (const line of byProject.get(k) ?? []) {
        if (!(left > 0)) break;
        const take = Math.min(left, Math.max(0, line.required - line.done[stage]));
        line.done[stage] += take;
        left -= take;
      }
    }
  }
  return [...byOrder.values()];
}

/** Both lines' cards as one sheet — a row per item type, the line and the
 *  plan's month on each: what the card shows, for make_excel. */
export function outputByTypeRows(tr: OutputByTypeData<Stage> | null, lv: OutputByTypeData<LvStage> | null): Record<string, string | number>[] {
  const rows = <S extends string>(line: string, d: OutputByTypeData<S>, stages: readonly S[], label: Record<S, string>) =>
    d.groups.flatMap((g) => g.types.map((t) => ({
      Line: line,
      Item: g.item,
      Type: t.type,
      ...Object.fromEntries(stages.map((s) => [`Made — ${label[s]}`, t.made[s]])),
      "Plan month": d.monthLabel,
      Planned: t.plan?.required ?? "",
      Finished: t.plan ? t.plan.done[stages[stages.length - 1]] : "",
      Left: t.plan?.left ?? "",
      "Done %": t.plan?.share == null ? "" : Math.round(t.plan.share * 100),
    })));
  return [...(tr ? rows("Transformers", tr, STAGES, TR_TYPE_STAGE_LABEL) : []), ...(lv ? rows("LV Panels", lv, LV_STAGES, LV_TYPE_STAGE_LABEL) : [])];
}
