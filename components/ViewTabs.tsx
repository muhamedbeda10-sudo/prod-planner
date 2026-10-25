import { ViewTabsNav } from "@/components/ViewTabsNav";

// One tab in the strip can hold several screens: the pages stay separate
// routes (each is big, and each deep-links), and this switcher reads them as
// one place with views. The Plan Tracker tab holds the tracker, the plan's
// cockpit, the tracker and the daily log; the Material tab holds the nesting
// sheets and the analytics built on them.

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

/** The Plan Tracker tab's screens: the planner's cockpit (the home page —
 *  how the plant is doing, in standard hours), the tracker, and the raw
 *  ledger the tracker adds up. */
export const TRACKER_VIEWS: View[] = [
  { href: "/", label: "Cockpit", title: "The plan, each centre's pace, the load ahead, welding's parts and the losses — what needs a decision today" },
  { href: "/tracker", label: "Plan Tracker", title: "One row per order, every stage" },
  { href: "/handover", label: "Daily log", title: "The raw entries the tracker adds up — edit and correct them here" },
];

/** The same, for the product line on screen: the cockpit is the
 *  transformers'; on the panels the home page is their own dashboard. */
export function trackerViews(line: string): View[] {
  if (line !== "LV") return TRACKER_VIEWS;
  const [, tracker, handover] = TRACKER_VIEWS;
  return [tracker, { href: "/", label: "Dashboard", title: "The panels' plan through its four stages" }, handover];
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
