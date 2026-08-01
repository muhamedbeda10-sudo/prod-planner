// Completion forecast (ETA) for open orders — plain flow-shop arithmetic, not
// a black box. Every order's remaining work passes Cut → Welding → Finishing;
// each stage is one station processing STD-HOURS at the plant's actual trailing
// rate, and orders queue FIFO by delivery date (undated orders go last). A
// stage starts an order when the previous stage finished it AND the station
// has worked off everyone ahead of it — the classic permutation flow shop.
//
// The output is WORKING-DAY offsets from "now"; the caller maps offsets to
// calendar dates (weekends/holidays are a calendar concern, not a queue one).

export const ETA_STAGES = ["cut", "weld", "finish"] as const;
export type EtaStage = (typeof ETA_STAGES)[number];

export interface EtaOrder {
  id: string; // MO
  dueISO: string | null; // latest scheduled delivery, null = never scheduled
  hours: Record<EtaStage, number>; // REMAINING std-hours per stage
}

export interface EtaResult {
  id: string;
  days: number | null; // working days from now until done (0 = nothing left); null = not computable
  blockedBy: EtaStage | null; // a needed stage whose rate is 0 — forecast impossible
}

/** FIFO queue: soonest due first; undated orders after every dated one. */
export function etaQueueOrder(a: EtaOrder, b: EtaOrder): number {
  if (a.dueISO && b.dueISO) return a.dueISO < b.dueISO ? -1 : a.dueISO > b.dueISO ? 1 : a.id < b.id ? -1 : 1;
  if (a.dueISO) return -1;
  if (b.dueISO) return 1;
  return a.id < b.id ? -1 : 1;
}

/** Forecast every order. `rates` = std-hours each stage completes per working
 *  day (trailing actuals). An order needing a stage whose rate is 0 gets
 *  `blockedBy` instead of a number — no history means no honest forecast. */
export function forecastEta(orders: EtaOrder[], rates: Record<EtaStage, number>): EtaResult[] {
  const queue = [...orders].sort(etaQueueOrder);
  // stageFree[s] = working-day time at which stage s has finished everything
  // queued ahead; orderReady = when this order left the previous stage
  const stageFree: Record<EtaStage, number> = { cut: 0, weld: 0, finish: 0 };
  const out = new Map<string, EtaResult>();

  for (const o of queue) {
    let ready = 0;
    let blockedBy: EtaStage | null = null;
    for (const s of ETA_STAGES) {
      const h = o.hours[s];
      if (h <= 0) continue; // nothing left at this stage — flows straight through
      if (!(rates[s] > 0)) {
        blockedBy = s;
        break;
      }
      const start = Math.max(ready, stageFree[s]);
      ready = start + h / rates[s];
      stageFree[s] = ready;
    }
    out.set(o.id, blockedBy ? { id: o.id, days: null, blockedBy } : { id: o.id, days: ready, blockedBy: null });
  }
  return orders.map((o) => out.get(o.id)!);
}

/** Mid-window pace for the weekly plan: what the week will CLOSE at, if the
 *  run-rate so far holds. Null before any working day has elapsed — a
 *  projection from nothing would be noise. */
export function projectPace(required: number, actualSoFar: number, elapsedWd: number, totalWd: number):
  | { projected: number; coverage: number }
  | null {
  if (elapsedWd <= 0 || totalWd <= 0 || required <= 0) return null;
  const projected = (actualSoFar / elapsedWd) * totalWd;
  return { projected, coverage: projected / required };
}
