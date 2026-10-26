import { ViewTabsNav } from "@/components/ViewTabsNav";

// One tab in the strip can hold several screens: the pages stay separate
// routes (each is big, and each deep-links), and this switcher reads them as
// one place with views. The Plan Tracker tab holds the tracker, the daily log,
// the simulator and the ODOO log. (A tab holding several places — Material, Dashboards —
// moves between them with components/SectionStrip.tsx.)

export interface View {
  href: string;
  label: string;
  /** Shown as the link's tooltip — what this view answers. */
  title?: string;
}

/** The tab's OTHER views — those this account may see (see ViewTabsNav).
 *  This module carries no "use client", so server pages can call the helpers
 *  below; the switch itself renders on the client, where the account's
 *  hidden screens are known. */
export function ViewTabs(props: { views: View[]; current: string; label: string }) {
  return <ViewTabsNav {...props} />;
}

/** The Plan Tracker tab's screens: the tracker, the raw ledger the tracker
 *  adds up, the what-if simulator the plan is tried out on, and the ODOO
 *  close-out log. The plan's dashboard is in the Dashboards tab (Planning,
 *  the home page). */
export const TRACKER_VIEWS: View[] = [
  { href: "/tracker", label: "Plan Tracker", title: "One row per order, every stage" },
  { href: "/handover", label: "Daily log", title: "The raw entries the tracker adds up — edit and correct them here" },
  { href: "/simulate", label: "Simulator", title: "What-if: move the dates and the capacity and see what lands" },
  { href: "/odoo", label: "ODOO", title: "The daily close-out log on Odoo, both lines" },
];

/** The same, for the product line on screen: on the panels there is no
 *  simulator, which models the transformers' plan only. */
export function trackerViews(line: string): View[] {
  return line !== "LV" ? TRACKER_VIEWS : TRACKER_VIEWS.filter((v) => v.href !== "/simulate");
}

/** The two plan imports, which lived on two separate Admin pages: the monthly
 *  registry (orders and their quantities) and the weekly delivery schedule
 *  (the dates). They are the same job a month apart. */
export const PLANS_VIEWS: View[] = [
  { href: "/orders", label: "Orders & monthly plan", title: "The master MO list and the monthly plan import" },
  { href: "/import", label: "Weekly plan", title: "The delivery schedule — dates per MO" },
];
