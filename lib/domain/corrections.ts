// A correction — a figure lowered on the tracker — takes back pieces that
// were recorded on the day they were made. It is dated on those days, and
// filed under the plan they were filed under, not the day it is typed: dated
// today it took the output out of the wrong day's efficiency, and out of a
// period that never counted it.

export interface DatedQty {
  dateISO: string;
  qty: number;
  /** The weekly plan the row is filed under. */
  planNo: number;
}

/** The note a correction row carries ("tracker correction: total 15 → 8",
 *  "group correction: …") — how the Daily log's data guard knows it was
 *  dated back on purpose. */
export const isCorrectionNote = (note: string | null | undefined) => /^(tracker|group) correction:/.test(note ?? "");

/**
 * How a correction of `take` pieces splits over the work it takes back: the
 * most recent output first, each day and plan giving back its own net output
 * (a later correction has already taken back its share — it is carried into
 * the work before it). Output dated after `todayISO` (claimed ahead) is not
 * taken back ahead of time; what the work cannot cover falls on `todayISO`,
 * under `fallbackPlan`. The parts are negative, latest first, and add up to
 * −take.
 */
export function correctionDays(rows: readonly DatedQty[], take: number, todayISO: string, fallbackPlan: number): DatedQty[] {
  if (!(take > 0)) return [];
  const by = new Map<string, DatedQty>();
  for (const r of rows) {
    if (r.dateISO > todayISO) continue;
    const k = `${r.dateISO}|${r.planNo}`;
    const cur = by.get(k) ?? { dateISO: r.dateISO, planNo: r.planNo, qty: 0 };
    cur.qty += r.qty;
    by.set(k, cur);
  }
  const out: DatedQty[] = [];
  let left = take;
  let carried = 0; // later work's net taking-back, not yet set against output
  const latestFirst = [...by.values()].sort((a, b) => b.dateISO.localeCompare(a.dateISO) || b.planNo - a.planNo);
  for (const w of latestFirst) {
    if (left <= 0) break;
    const net = w.qty + carried;
    if (net <= 0) {
      carried = net;
      continue;
    }
    carried = 0;
    const q = Math.min(net, left);
    out.push({ dateISO: w.dateISO, planNo: w.planNo, qty: -q });
    left -= q;
  }
  if (left > 0) out.push({ dateISO: todayISO, planNo: fallbackPlan, qty: -left });
  return out;
}
