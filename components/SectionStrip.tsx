"use client";

import Link from "next/link";
import { useCanSee } from "@/components/TabAccess";

// A top tab that holds several places — Material, Dashboards — draws this
// strip at the top of each of their pages to move between them. Each place
// keeps its own screens behind its own switch in the page head. A place
// switched off for the account is not offered (one whose first screen is off
// opens on the screen of it that is on), and with one place left the strip
// is not drawn.

export interface Section<Id extends string> {
  id: Id;
  href: string;
  label: string;
  title: string;
  also?: string[];
}

export function SectionStrip<Id extends string>({ sections, current, label }: { sections: readonly Section<Id>[]; current: Id; label: string }) {
  const canSee = useCanSee();
  const shown = sections
    .map((s) => ({ ...s, href: [s.href, ...(s.also ?? [])].find(canSee) }))
    .filter((s): s is Section<Id> & { href: string } => !!s.href);
  if (shown.length < 2) return null;
  return (
    <nav className="tab-strip flex items-center gap-1 no-scrollbar no-print" aria-label={label}>
      {shown.map((s) => (
        <Link key={s.id} href={s.href} title={s.title} aria-current={s.id === current ? "page" : undefined} className={`tab ${s.id === current ? "tab-active" : ""}`}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
