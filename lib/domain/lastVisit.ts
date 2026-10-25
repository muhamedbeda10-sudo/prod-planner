// Keeping a tab where it was left — the pure part of components/RememberLastVisit.tsx.
//
// A tab's page writes its URL (its filters) to the browser each time it
// changes, and a bare arrival reopens that URL. A tab whose views share one
// path and differ by `?view=` (ODOO: log / dashboard; Consumables)
// keeps one memory per VIEW as well, so the dashboard's period, BOM and
// product survive a visit to the log, and the view switch (`?view=dashboard`,
// nothing else) reopens the dashboard as it was left, not on its defaults.

export interface LastVisitInput {
  /** The browser key for the tab's last URL, e.g. "odoo:last". */
  storageKey: string;
  pathname: string;
  /** The query on screen, without "?". */
  qs: string;
  /** True on the first render after landing on the tab — the only time the
   *  tab's last URL is reopened from a bare path. */
  arriving: boolean;
  /** True when the view on screen is not the one before — the switch moves
   *  between views of one route, so the page is not mounted again. The
   *  view's own memory is reopened on an arrival or a switch. */
  viewChanged?: boolean;
  /** Query keys not carried to the next visit. */
  forget?: readonly string[];
  /** The query key that picks the view, and the view on screen (resolved by
   *  the page, so "/odoo" and "/odoo?view=log" are one view). */
  viewKey?: string;
  view?: string;
  /** Query keys the view switch carries from view to view (the Consumables
   *  period): they do not make a link explicit, and the value on the link
   *  is laid over the view's memory. */
  carry?: readonly string[];
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
  const viewKey = i.viewKey ?? "view";
  const scoped = i.view !== undefined ? viewStorageKey(i.storageKey, i.view) : null;
  const here = i.qs ? `${i.pathname}?${i.qs}` : i.pathname;
  const ours = (saved: string | null): saved is string => !!saved && saved.startsWith(`${i.pathname}?`);

  // a bare path reopens what was left on the tab — on landing only: a view
  // switch to the bare path (Consumables' Log) means that view, not the last one
  if (i.arriving && !i.qs) {
    const saved = i.read(i.storageKey);
    if (ours(saved) && saved !== here) return { redirect: saved, save: [] };
  }

  // the view switch alone (the view, and what the switch carries) reopens
  // that view as it was left, the carried values laid over it
  if ((i.arriving || i.viewChanged) && scoped && i.qs) {
    const carried = new Set([viewKey, ...(i.carry ?? [])]);
    if ([...params.keys()].every((k) => carried.has(k))) {
      const saved = i.read(scoped);
      if (ours(saved)) {
        const merged = new URLSearchParams(saved.slice(i.pathname.length + 1));
        for (const k of i.carry ?? []) {
          const v = params.get(k);
          if (v === null) merged.delete(k); else merged.set(k, v);
        }
        const target = merged.toString() ? `${i.pathname}?${merged}` : i.pathname;
        if (target !== here) return { redirect: target, save: [] };
      }
    }
  }

  // a change made on the page — the defaults included — is what is left
  for (const k of i.forget ?? []) params.delete(k);
  const kept = params.toString();
  const save = [{ key: i.storageKey, url: kept ? `${i.pathname}?${kept}` : i.pathname }];
  if (scoped) {
    // the view's own memory names the view the page resolved, so an alias
    // ("?view=monthly") or a view switched off for now never reopens as another
    params.set(viewKey, i.view!);
    save.push({ key: scoped, url: `${i.pathname}?${params}` });
  }
  return { redirect: null, save };
}
