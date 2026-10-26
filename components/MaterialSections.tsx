"use client";

import Link from "next/link";
import { useCanSee } from "@/components/TabAccess";

// The Material tab holds three places: the nesting sheets (with their
// dashboard), the store's physical count, and the consumables the store
// hands out. Each keeps its own screens behind its own switch in the page
// head; this strip moves between the three. A place switched off for the
// account is not offered, and with one place left the strip is not drawn.

export type MaterialSection = "material" | "physical" | "consumables";

const SECTIONS: { id: MaterialSection; href: string; label: string; title: string; also?: string[] }[] = [
  { id: "material", href: "/material", label: "Material", title: "The nesting sheets, and the material dashboard built on them", also: ["/analytics"] },
  { id: "physical", href: "/physical", label: "Physical Material", title: "The store's count against Odoo's stock, code by code" },
  { id: "consumables", href: "/consumables", label: "Consumables", title: "What the store hands out to the floor — item, quantity, department, worker" },
];

export function MaterialSections({ current }: { current: MaterialSection }) {
  const canSee = useCanSee();
  // a section whose first screen is off opens on the one of its screens that is on
  const shown = SECTIONS.map((s) => ({ ...s, href: [s.href, ...(s.also ?? [])].find(canSee) })).filter((s): s is typeof s & { href: string } => !!s.href);
  if (shown.length < 2) return null;
  return (
    <nav className="tab-strip flex items-center gap-1 no-scrollbar no-print" aria-label="Material">
      {shown.map((s) => (
        <Link key={s.id} href={s.href} title={s.title} aria-current={s.id === current ? "page" : undefined} className={`tab ${s.id === current ? "tab-active" : ""}`}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
