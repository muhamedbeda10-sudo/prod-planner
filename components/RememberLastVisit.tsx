"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { planLastVisit } from "@/lib/domain/lastVisit";

/**
 * Keeps a tab where it was left. Every filter change on the page (a day, a
 * view, a period, a plan, a month) is remembered in this browser, and so is
 * going back to the defaults. Coming back to the tab bare — from the nav, a
 * bookmark, a reload of the plain path — reopens it exactly as it was left.
 * An explicit query in the URL on arrival (a shared link) wins, and is
 * remembered in turn.
 *
 * A tab whose views share one path (`?view=`) names the view on screen: each
 * view then keeps its own memory, and the view switch alone (`?view=x` and
 * nothing else — the switch's own link, or a bare link to that view) reopens
 * the view as it was left (lib/domain/lastVisit.ts).
 */
export function RememberLastVisit({ storageKey, forget = [], view, carry = [] }: {
  storageKey: string;
  /** Query keys NOT carried to the next visit — the tab opens on its own
   *  default for them every time (the ODOO log's day: always every day). */
  forget?: string[];
  /** The view on screen as the page resolved it — set on a tab whose views
   *  share one path (`?view=`); each view then keeps its own memory. */
  view?: string;
  /** Query keys the view switch carries from view to view (the Consumables period). */
  carry?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // the view switch moves between views of ONE route, so this component is
  // not mounted again — a change of view is noticed here instead
  const seen = useRef<{ view: string | undefined } | null>(null);
  useEffect(() => {
    const arriving = seen.current === null;
    const viewChanged = !arriving && seen.current!.view !== view;
    seen.current = { view };
    try {
      const plan = planLastVisit({
        storageKey, pathname, qs: params.toString(), arriving, viewChanged, forget, view, carry,
        read: (key) => localStorage.getItem(key),
      });
      if (plan.redirect) {
        router.replace(plan.redirect);
        return;
      }
      for (const s of plan.save) localStorage.setItem(s.key, s.url);
    } catch {
      // storage unavailable (private mode, blocked) — the tab simply opens on its defaults
    }
  }, [pathname, params, router, storageKey, forget.join(","), view, carry.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
