// How a chart's numbers are framed: the change against the period before,
// and a value axis with round ticks. Display only — what is counted is the
// caller's.

/** Under this many pieces in the period before, a percentage says more about
 *  the small base than about the change (3 → 13 is "+333%"), so the change is
 *  written as a count instead. */
export const DELTA_MIN_BASE = 10;

export type DeltaView =
  | { kind: "none" } // nothing to compare against
  | { kind: "same" }
  | { kind: "new" } // nothing at all before
  | { kind: "abs"; diff: number } // a small base: the change in pieces
  | { kind: "pct"; pct: number };

export function describeDelta(cur: number, prev: number | null): DeltaView {
  if (prev === null) return { kind: "none" };
  if (cur === prev) return { kind: "same" };
  if (prev === 0) return { kind: "new" };
  if (prev < DELTA_MIN_BASE) return { kind: "abs", diff: cur - prev };
  return { kind: "pct", pct: Math.round(((cur - prev) / prev) * 100) };
}

/** A value axis from 0 with round steps (1, 2 or 5 × a power of ten) and room
 *  above the tallest mark for its label. Counts never get a fractional tick. */
export function niceScale(max: number, target = 5, headroom = 1.12): { max: number; ticks: number[] } {
  const top = Math.max(1, max * headroom);
  const raw = top / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const niceMax = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
  return { max: niceMax, ticks };
}

/** Room for the widest tick label ("1,250") so none is clipped to "00". */
export function axisWidth(max: number): number {
  return 14 + Math.round(max).toLocaleString("en-US").length * 7;
}
