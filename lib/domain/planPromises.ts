// A weekly plan is a list of dated promises, and planners repeat a line they
// are still waiting for: the same 2 core boxes get scheduled on Monday and
// again on Wednesday. Read literally that is a promise to make 4, so a finished
// order sits on the sheet reading half done forever and the capacity check asks
// for twice the hours.
//
// The ORDER's own quantity settles it. Walk an order's promises in date order
// and hand each one as much of that quantity as is left: the first promise is
// real work, whatever comes after it is the same pieces asked for again.

import { applicableItems, isItem, ospOf, parseExcludedItems, type ItemRuleFields } from "./constants";

/** How much an order can still be asked for of one component across a single
 *  plan — the order's own quantity. A plan's promise is met by every piece the
 *  order gets, the bought-out (OSP) ones included, so the weekly tracker counts
 *  OSP as made against this ceiling. `Infinity` = no ceiling to apply: the
 *  order is not in the registry, carries no quantity, or already marks the
 *  component N/A (in which case it is excluded from the work owed on its own,
 *  and capping it as well would subtract the same promise twice). */
export function promiseCeiling(
  order: { planQty?: number | null; excludedItems?: string | null } | null | undefined,
  item: string,
): number {
  if (!order || !(order.planQty && order.planQty > 0)) return Infinity;
  if (parseExcludedItems(order.excludedItems).has(item.toUpperCase())) return Infinity;
  return order.planQty;
}

/** The share of that ceiling the plant itself makes: the order's quantity
 *  less the pieces bought out (OSP), which no department here ever works on —
 *  the hours a plan really asks of the floor (capacity card, simulator), the
 *  same in-house share the cockpit's manpower, the ETA and the tracker's Dlvd
 *  target read. */
export function inHouseCeiling(
  order: { planQty?: number | null; excludedItems?: string | null; ospCF?: number | null; ospTC?: number | null; ospTN?: number | null; ospCB?: number | null } | null | undefined,
  item: string,
): number {
  const ceiling = promiseCeiling(order, item);
  if (!Number.isFinite(ceiling)) return ceiling;
  const it = item.toUpperCase();
  return Math.max(0, ceiling - (isItem(it) ? ospOf(order!, it) : 0));
}

/** The pieces each line of a plan really owes, in the lines' own order: the
 *  same order+component's promises are walked by date and each gets what the
 *  order can still owe (owedAcrossDays). ONE walk for every reader of a plan's
 *  required hours — the capacity card and the simulator must agree. */
export function owedPlanQtys<T extends { mo: string; item: string; ovenDate: Date; qty: number }>(
  schedules: readonly T[],
  orderOf: (mo: string) => (Parameters<typeof inHouseCeiling>[0] & ItemRuleFields) | null | undefined,
): number[] {
  const owed = schedules.map((s) => s.qty);
  const byOrderItem = new Map<string, number[]>();
  const ordered = schedules.map((_, i) => i).sort((a, b) => +schedules[a].ovenDate - +schedules[b].ovenDate);
  for (const i of ordered) {
    const k = `${schedules[i].mo}|${schedules[i].item}`;
    if (!byOrderItem.has(k)) byOrderItem.set(k, []);
    byOrderItem.get(k)!.push(i);
  }
  for (const [k, idx] of byOrderItem) {
    const [mo, item] = k.split("|");
    const order = orderOf(mo);
    // a component the order does not need owes nothing, however often the
    // sheet promises it — the weekly tracker folds those pieces into "N/A"
    const qtys = promiseNotNeeded(order, item) ? idx.map(() => 0) : owedAcrossDays(idx.map((i) => schedules[i].qty), inHouseCeiling(order, item));
    idx.forEach((i, n) => { owed[i] = qtys[n]; });
  }
  return owed;
}

/** Whether a plan line promises a component the order does not need: ticked
 *  N/A on the order, or an AR/MB its kVA/rating rule does not give it (and
 *  not ticked in by hand). Unknown orders need everything they are promised. */
export function promiseNotNeeded(order: ItemRuleFields | null | undefined, item: string): boolean {
  if (!order) return false;
  const it = item.toUpperCase();
  return parseExcludedItems(order.excludedItems).has(it) || (isItem(it) && !applicableItems(order).includes(it));
}

/** Split one order+component's day quantities — IN DATE ORDER — into the pcs
 *  each day really owes. The earliest promise fills first; once the order's
 *  quantity is spent, the rest is a repeat and owes nothing. */
export function owedAcrossDays(qtys: readonly number[], ceiling: number): number[] {
  let need = ceiling;
  return qtys.map((q) => {
    const owed = Math.max(0, Math.min(need, q));
    need -= owed;
    return owed;
  });
}
