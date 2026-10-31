// A correction — a figure lowered on the tracker — takes back pieces that
// were recorded on the day they were made. It is dated on those days, not the
// day it is typed: dated today it took the output out of the wrong day's
// efficiency, and out of a period that never counted it.

export interface DatedQty {
  dateISO: string;
  qty: number;
}

/**
 * How a correction of `take` pieces splits over the days of the work it takes
 * back: the most recent output first. Each day gives back its own net output
 * (a later correction has already taken back its share — it is carried into
 * the days before it); what the days cannot cover falls on `todayISO`. The
 * parts are negative, latest day first, and add up to −take.
 */
export function correctionDays(rows: readonly DatedQty[], take: number, todayISO: string): DatedQty[] {
  if (!(take > 0)) return [];
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.dateISO, (byDay.get(r.dateISO) ?? 0) + r.qty);
  const out: DatedQty[] = [];
  let left = take;
  let carried = 0; // a later day's net taking-back, not yet set against output
  for (const day of [...byDay.keys()].sort().reverse()) {
    if (left <= 0) break;
    const net = byDay.get(day)! + carried;
    if (net <= 0) {
      carried = net;
      continue;
    }
    carried = 0;
    const q = Math.min(net, left);
    out.push({ dateISO: day, qty: -q });
    left -= q;
  }
  if (left > 0) out.push({ dateISO: todayISO, qty: -left });
  return out;
}
