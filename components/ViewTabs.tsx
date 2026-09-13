import Link from "next/link";

// One tab in the strip can hold several screens. The nav used to carry a tab
// each for the Dashboard, the Report and the Analytics — three answers to the
// same question, three slots — and another for the Plan Tracker beside its own
// daily log. This is the switcher that lets one tab hold them all: the pages
// stay separate routes (each is big, and each deep-links), and this reads as
// one place with views.

export interface View {
  href: string;
  label: string;
  /** Shown as the link's tooltip — what this view answers. */
  title?: string;
}

export function ViewTabs({ views, current, label }: { views: View[]; current: string; label: string }) {
  return (
    <nav className="seg" aria-label={label}>
      {views.map((v) => (
        <Link key={v.href} href={v.href} className={v.href.split("?")[0] === current ? "on" : ""} title={v.title}>
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

/** The Dashboard tab's three screens: how the plant is doing, one day or
 *  period on paper, and the floor read in sheets. */
export const DASHBOARD_VIEWS: View[] = [
  { href: "/", label: "Dashboard", title: "How the plant is doing this week" },
  { href: "/report", label: "Report", title: "One day or a period, ready to print" },
  { href: "/analytics", label: "Analytics", title: "Fabrication read in sheets, tonnes and thicknesses" },
];

/** The Plan Tracker tab's two screens: the summary and the raw ledger the
 *  summary is made of. */
export const TRACKER_VIEWS: View[] = [
  { href: "/tracker", label: "Plan Tracker", title: "One row per order, every stage" },
  { href: "/handover", label: "Daily log", title: "The raw entries the tracker adds up — edit and correct them here" },
];

/** The two plan imports, which lived on two separate Admin pages: the monthly
 *  registry (orders and their quantities) and the weekly delivery schedule
 *  (the dates). They are the same job a month apart. */
export const PLANS_VIEWS: View[] = [
  { href: "/orders", label: "Orders & monthly plan", title: "The master MO list and the monthly plan import" },
  { href: "/import", label: "Weekly plan", title: "The delivery schedule — dates per MO" },
];
