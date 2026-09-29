"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Keeps a tab where it was left. Every filter change on the page (a day, a
 * view, a period, a plan, a month) is remembered in this browser, and so is
 * going back to the defaults. Coming back to the tab bare — from the nav, a
 * bookmark, a reload of the plain path — reopens it exactly as it was left.
 * An explicit query in the URL on arrival (a shared link) wins, and is
 * remembered in turn.
 */
export function RememberLastVisit({ storageKey }: { storageKey: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const arrived = useRef(false);
  useEffect(() => {
    const qs = params.toString();
    const here = qs ? `${pathname}?${qs}` : pathname;
    try {
      if (!arrived.current) {
        // arriving on the tab: a bare path reopens what was left
        arrived.current = true;
        if (!qs) {
          const saved = localStorage.getItem(storageKey);
          if (saved && saved !== pathname && saved.startsWith(`${pathname}?`)) {
            router.replace(saved);
            return;
          }
        }
      }
      // a change made on the page — the defaults included — is what is left
      localStorage.setItem(storageKey, here);
    } catch {
      // storage unavailable (private mode, blocked) — the tab simply opens on its defaults
    }
  }, [pathname, params, router, storageKey]);
  return null;
}
