import { ViewTabsNav } from "@/components/ViewTabsNav";

// One place can show its rows several ways — Consumables' log, powder scrap
// and limits. This switch, at the end of the page's bar, moves between those
// views. (A tab holding several
// PLACES — Dashboards, Material, Plan Tracker — moves between them with the
// panel of the top bar's tab, components/AppNav.tsx.)

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
