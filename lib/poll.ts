// Browser side of a page's polling (lib/domain/poll.ts decides the pace): one
// loop that asks at the visible pace while the page is in front, at the hidden
// pace (or not at all) while it is out of sight, and asks at once when the page
// comes back to the front with a stale answer. One ask at a time: a return to
// the front during an ask lets that ask finish and takes the new pace from
// there. Client-only module.
//
// Two pollers stay on their own loops on purpose: components/UpdateNotice.tsx
// (its tick alternates a version check with the idle-reload decision, and has
// its own threshold on return) and components/AutomationTicker.tsx (the server
// sets its pace with every answer).

import { askOnReturn, pollDelay, type PollPace } from "@/lib/domain/poll";

/** Start the loop; the returned function stops it. `firstMs` is the wait
 *  before the first ask (after the page has painted). */
export function startPoll(ask: () => void | Promise<void>, pace: PollPace, firstMs = 0): () => void {
  let timer: number | undefined;
  let stopped = false;
  let asking = false;
  let lastAskedAt: number | null = null;
  const visible = () => document.visibilityState === "visible";

  const schedule = () => {
    window.clearTimeout(timer);
    timer = undefined;
    if (stopped || asking) return;
    const delay = pollDelay(visible(), pace, lastAskedAt === null ? 0 : Date.now() - lastAskedAt);
    if (delay !== null) timer = window.setTimeout(tick, delay);
  };
  const tick = async () => {
    if (stopped || asking) return;
    window.clearTimeout(timer);
    timer = undefined;
    asking = true;
    lastAskedAt = Date.now();
    try {
      await ask();
    } catch {
      /* offline for a moment — the next ask tries again */
    } finally {
      asking = false;
    }
    schedule();
  };
  const onVisibility = () => {
    if (stopped) return;
    if (visible() && askOnReturn(lastAskedAt, Date.now(), pace)) void tick();
    else schedule();
  };

  timer = window.setTimeout(tick, firstMs);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
