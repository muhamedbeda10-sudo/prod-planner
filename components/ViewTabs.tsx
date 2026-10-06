import Link from "next/link";

// One tab in the strip can hold several screens: the pages stay separate
// routes (each is big, and each deep-links), and this switcher reads them as
// one place with views. The Plan Tracker tab holds the tracker, the plan's
// dashboard, the daily log and its report; the Material tab holds the nesting
// sheets and the analytics built on them.

export interface View {
  href: string;
  label: string;
  /** Shown as the link's tooltip — what this view answers. */
  title?: string;
}

/** The tab's OTHER views. The one on screen is not offered — the page's
 *  title already says where you are — so the switch is only ever a way out. */
export function ViewTabs({ views, current, label }: { views: View[]; current: string; label: string }) {
  const others = views.filter((v) => v.href.split("?")[0] !== current);
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

/** The Plan Tracker tab's screens: the tracker, the plan's dashboard (how
 *  the plant is doing this week), the raw ledger the tracker adds up, and the
 *  report printed from that ledger. There is no Dashboard tab any more — the
 *  dashboard is the plan's, so it lives with the plan. */
export const TRACKER_VIEWS: View[] = [
  { href: "/tracker", label: "Plan Tracker", title: "One row per order, every stage" },
  { href: "/", label: "Dashboard", title: "How the plan is doing this week — targets, throughput, the control loops" },
  { href: "/handover", label: "Daily log", title: "The raw entries the tracker adds up — edit and correct them here" },
  { href: "/report", label: "Report", title: "The daily log as one day or a period, ready to print" },
];

/** The same, for the product line on screen: the printed report is the
 *  transformers' — the panels' dashboard carries its own period table. */
export function trackerViews(line: string): View[] {
  return line === "LV" ? TRACKER_VIEWS.filter((v) => v.href !== "/report") : TRACKER_VIEWS;
}

/** The Material tab's screens: the nesting sheets, and the fabrication read
 *  through them in sheets, tonnes and thicknesses. */
export const MATERIAL_VIEWS: View[] = [
  { href: "/material", label: "Material", title: "The nesting project tracker — what each order consumed" },
  { href: "/analytics", label: "Dashboard", title: "Material dashboard — consumption (booked when the MO is closed on Odoo), scrap, weights" },
];

/** The two plan imports, which lived on two separate Admin pages: the monthly
 *  registry (orders and their quantities) and the weekly delivery schedule
 *  (the dates). They are the same job a month apart. */
export const PLANS_VIEWS: View[] = [
  { href: "/orders", label: "Orders & monthly plan", title: "The master MO list and the monthly plan import" },
  { href: "/import", label: "Weekly plan", title: "The delivery schedule — dates per MO" },
];
