// A weekly plan is a list of dated promises, and planners repeat a line they
// are still waiting for: the same 2 core boxes get scheduled on Monday and
// again on Wednesday. Read literally that is a promise to make 4, so a finished
// order sits on the sheet reading half done forever and the capacity check asks
// for twice the hours.
//
// The ORDER's own quantity settles it. Walk an order's promises in date order
// and hand each one as much of that quantity as is left: the first promise is
// real work, whatever comes after it is the same pieces asked for again.

import { parseExcludedItems } from "./constants";

/** How much an order can still be asked to make of one component across a
 *  single plan. `Infinity` = no ceiling to apply: the order is not in the
 *  registry, carries no quantity, or already marks the component N/A (in which
 *  case it is excluded from the work owed on its own, and capping it as well
 *  would subtract the same promise twice). */
export function promiseCeiling(
  order: { planQty?: number | null; excludedItems?: string | null } | null | undefined,
  item: string,
): number {
  if (!order || !(order.planQty && order.planQty > 0)) return Infinity;
  if (parseExcludedItems(order.excludedItems).has(item.toUpperCase())) return Infinity;
  return order.planQty;
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
