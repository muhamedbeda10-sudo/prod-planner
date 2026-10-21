// Keeping a tab where it was left — the pure part of components/RememberLastVisit.tsx.
//
// A tab's page writes its URL (its filters) to the browser each time it
// changes, and a bare arrival reopens that URL. A tab whose views share one
// path and differ by `?view=` (ODOO: log / dashboard; Consumables; the Floor)
// keeps one memory per VIEW as well, so the dashboard's period, BOM and
// product survive a visit to the log, and the view switch (`?view=dashboard`,
// nothing else) reopens the dashboard as it was left, not on its defaults.

export interface LastVisitInput {
  /** The browser key for the tab's last URL, e.g. "odoo:last". */
  storageKey: string;
  pathname: string;
  /** The query on screen, without "?". */
  qs: string;
  /** True on the first render after landing on the tab — the only time a
   *  saved URL is reopened. */
  arriving: boolean;
  /** Query keys not carried to the next visit. */
  forget?: readonly string[];
  /** The query key that picks the view, and the view on screen (resolved by
   *  the page, so "/odoo" and "/odoo?view=log" are one view). */
  viewKey?: string;
  view?: string;
  /** Read a saved URL — null when none. */
  read: (key: string) => string | null;
}

export interface LastVisitPlan {
  /** Reopen this URL instead of the one on screen; nothing is saved then. */
  redirect: string | null;
  /** Write these — the overall last URL, and the view's own. */
  save: { key: string; url: string }[];
}

/** The key a view's own memory is kept under. */
export function viewStorageKey(storageKey: string, view: string): string {
  return `${storageKey}:${view}`;
}

export function planLastVisit(i: LastVisitInput): LastVisitPlan {
  const params = new URLSearchParams(i.qs);
  const scoped = i.viewKey && i.view !== undefined ? viewStorageKey(i.storageKey, i.view) : null;

  if (i.arriving) {
    const here = i.qs ? `${i.pathname}?${i.qs}` : i.pathname;
    const reopen = (saved: string | null) => (saved && saved !== here && saved.startsWith(`${i.pathname}?`) ? saved : null);
    // a bare path reopens what was left on the tab
    if (!i.qs) {
      const r = reopen(i.read(i.storageKey));
      if (r) return { redirect: r, save: [] };
    } else if (scoped && i.viewKey && [...params.keys()].every((k) => k === i.viewKey)) {
      // the view switch alone (no filter in the link) reopens that view as it was left
      const r = reopen(i.read(scoped));
      if (r) return { redirect: r, save: [] };
    }
  }

  // a change made on the page — the defaults included — is what is left
  for (const k of i.forget ?? []) params.delete(k);
  const kept = params.toString();
  const url = kept ? `${i.pathname}?${kept}` : i.pathname;
  const save = [{ key: i.storageKey, url }];
  if (scoped) save.push({ key: scoped, url });
  return { redirect: null, save };
}
