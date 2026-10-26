import { ViewTabsNav } from "@/components/ViewTabsNav";

// One place can show its rows several ways — Consumables' log, powder scrap
// and limits; the Orders Registry's monthly and weekly imports. This switch,
// in the page head, moves between those views. (A tab holding several
// PLACES — Dashboards, Material, Plan Tracker — moves between them with the
// strip at the top, components/SectionStrip.tsx.)

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

/** The two plan imports, which lived on two separate Admin pages: the monthly
 *  registry (orders and their quantities) and the weekly delivery schedule
 *  (the dates). They are the same job a month apart. */
export const PLANS_VIEWS: View[] = [
  { href: "/orders", label: "Orders & monthly plan", title: "The master MO list and the monthly plan import" },
  { href: "/import", label: "Weekly plan", title: "The delivery schedule — dates per MO" },
];
