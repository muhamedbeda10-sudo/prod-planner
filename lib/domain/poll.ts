// How often a page asks the server for news (chat pop-ups, the inbox count,
// the Odoo alerts, the open chat thread) — pure arithmetic, so the browser
// loop in lib/poll.ts stays small. A page in front asks at its own pace; a
// page out of sight (another tab, a minimised window) asks much less often, or
// not at all when nothing is waiting for its answer, and coming back to the
// front asks at once when the last answer is old enough to be stale.

export interface PollPace {
  /** Between two asks while the page is in front. */
  visibleMs: number;
  /** Between two asks while the page is out of sight; null = none until it is back. */
  hiddenMs: number | null;
}

/** The wait before the next ask, from whether the page is in front and how
 *  long ago the last ask was — the pace counts from the last ask, so a page
 *  that changes pace (hidden, then back) keeps its cadence instead of
 *  starting the wait over. */
export function pollDelay(visible: boolean, pace: PollPace, sinceLastAskMs = 0): number | null {
  const every = visible ? pace.visibleMs : pace.hiddenMs;
  return every === null ? null : Math.max(0, every - sinceLastAskMs);
}

/** Whether coming back to the front should ask now: never asked yet, or the
 *  last ask is at least a whole visible interval old. A quick switch away and
 *  back does not ask twice. */
export function askOnReturn(lastAskedAt: number | null, now: number, pace: PollPace): boolean {
  return lastAskedAt === null || now - lastAskedAt >= pace.visibleMs;
}
