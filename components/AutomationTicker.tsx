"use client";

import { useEffect } from "react";

// The automations' clock when the database's scheduler is not set up: while a
// page of the app is open and in front, it asks the server now and then to
// run what is due (the server takes at most one tick a minute for the whole
// plant, however many pages ask). The server says whether pages are still
// needed — once the scheduler is on, or while no automation is on, a page asks
// only rarely, to notice when that changes.

const NEEDED_MS = 5 * 60_000;
const IDLE_MS = 30 * 60_000;

export function AutomationTicker() {
  useEffect(() => {
    let timer: number | undefined;
    let stop = false;
    const tick = async () => {
      let next = NEEDED_MS;
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch("/api/automations/tick", { method: "POST", keepalive: true });
          const body = (await r.json().catch(() => null)) as { pages?: boolean } | null;
          if (body?.pages === false) next = IDLE_MS;
        } catch {
          /* offline for a moment */
        }
      }
      if (!stop) timer = window.setTimeout(tick, next);
    };
    timer = window.setTimeout(tick, 20_000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
