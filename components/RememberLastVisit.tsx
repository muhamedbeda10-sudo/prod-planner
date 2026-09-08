"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Keeps a tab where it was left. Every visit WITH a query string (a day, a
 * view, a period, a month) is remembered in this browser; opening the tab
 * bare — from the nav, a bookmark, a reload of the plain path — goes back to
 * that remembered state instead of the defaults. A link that means "the
 * default view" must carry an explicit query (e.g. ?view=log) so it is not
 * bounced back.
 */
export function RememberLastVisit({ storageKey }: { storageKey: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    const qs = params.toString();
    try {
      if (qs) {
        localStorage.setItem(storageKey, `${pathname}?${qs}`);
      } else {
        const saved = localStorage.getItem(storageKey);
        if (saved && saved.startsWith(`${pathname}?`)) router.replace(saved);
      }
    } catch {
      // storage unavailable (private mode, blocked) — the tab simply opens on its defaults
    }
  }, [pathname, params, router, storageKey]);
  return null;
}
