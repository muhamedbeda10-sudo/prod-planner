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

export interface EtaSegment {
  stage: EtaStage;
  start: number; // working-day offset the station picks the order up
  end: number; // working-day offset it hands it on
}

export interface EtaResult {
  id: string;
  days: number | null; // working days from now until done (0 = nothing left); null = not computable
  blockedBy: EtaStage | null; // a needed stage whose rate is 0 — forecast impossible
  segments: EtaSegment[]; // when each station holds the order (empty when blocked)
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
  return forecastEtaQueued([...orders].sort(etaQueueOrder), rates).sort(
    (a, b) => orders.findIndex((o) => o.id === a.id) - orders.findIndex((o) => o.id === b.id)
  );
}

/** The station arithmetic itself, taking the queue EXACTLY as given — the
 *  what-if simulator feeds it hand-reordered queues. Results follow queue
 *  order. */
export function forecastEtaQueued(queue: EtaOrder[], rates: Record<EtaStage, number>): EtaResult[] {
  // stageFree[s] = working-day time at which stage s has finished everything
  // queued ahead; orderReady = when this order left the previous stage
  const stageFree: Record<EtaStage, number> = { cut: 0, weld: 0, finish: 0 };
  const out = new Map<string, EtaResult>();

  for (const o of queue) {
    let ready = 0;
    let blockedBy: EtaStage | null = null;
    const segments: EtaSegment[] = [];
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
      segments.push({ stage: s, start, end: ready });
    }
    out.set(
      o.id,
      blockedBy
        ? { id: o.id, days: null, blockedBy, segments: [] }
        : { id: o.id, days: ready, blockedBy: null, segments }
    );
  }
  return queue.map((o) => out.get(o.id)!);
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
