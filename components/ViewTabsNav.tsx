"use client";

import Link from "next/link";
import { useCanSee } from "@/components/TabAccess";
import type { View } from "@/components/ViewTabs";

/** The tab's OTHER views. The one on screen is not offered — the page's
 *  title already says where you are — so the switch is only ever a way out. */
export function ViewTabsNav({ views: all, current, label }: { views: View[]; current: string; label: string }) {
  // a view is "current" by its path — or, where a tab's views share one path
  // and differ by ?view=, by its whole href
  const canSee = useCanSee();
  const views = all.filter((v) => canSee(v.href)); // a view switched off for this account is not offered
  const exact = views.some((v) => v.href === current);
  const isCurrent = (v: View) => (exact ? v.href === current : v.href.split("?")[0] === current);
  const others = views.filter((v) => !isCurrent(v));
  if (others.length === 0) return null;
  return (
    <nav className="seg" aria-label={label}>
      {others.map((v) => (
        <Link key={v.href} href={v.href} title={v.title}>
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

