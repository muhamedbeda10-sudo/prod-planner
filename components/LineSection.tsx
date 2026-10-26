"use client";

import { useEffect, useId, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// One product line's part of a plant dashboard (Planning, Production): a
// header that folds it away, so a planner who works one line can keep the
// other out of sight without losing the plant's figures above. The fold is
// remembered in this browser, per page and line (storage is the source of
// truth, as for the stored filters — the server renders it open); a link
// that names the section (#tr, #lv) opens it. On paper every section prints,
// folded or not.

const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, boolean>();
const storeKey = (page: string, id: string) => `fold:${page}:${id}`;

function subscribeTo(key: string) {
  return (cb: () => void) => {
    let set = listeners.get(key);
    if (!set) { set = new Set(); listeners.set(key, set); }
    set.add(cb);
    window.addEventListener("storage", cb);
    return () => { set!.delete(cb); window.removeEventListener("storage", cb); };
  };
}

function isFolded(key: string): boolean {
  try { return localStorage.getItem(key) === "0"; } catch { return memory.get(key) ?? false; }
}

function setFolded(key: string, folded: boolean) {
  memory.set(key, folded);
  try {
    if (folded) localStorage.setItem(key, "0");
    else localStorage.removeItem(key);
  } catch { /* storage unavailable — holds for this page load only */ }
  listeners.get(key)?.forEach((l) => l());
}

export function LineSection({ id, page, title, sub, children }: {
  /** The anchor a link opens the section at. */
  id: string;
  /** Which dashboard — the fold is remembered per page. */
  page: string;
  title: string;
  /** A quiet line beside the title: the plan, the last recorded day. */
  sub?: ReactNode;
  children: ReactNode;
}) {
  const key = storeKey(page, id);
  const subscribe = useMemo(() => subscribeTo(key), [key]);
  const folded = useSyncExternalStore(subscribe, () => isFolded(key), () => false);
  const bodyId = useId();

  // a link naming the section opens it, whatever was remembered: an address
  // that arrives with it, and a link to it on this page (the router moves
  // within a page without a hashchange)
  useEffect(() => {
    const openIfNamed = () => { if (window.location.hash === `#${id}`) setFolded(key, false); };
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      const to = new URL(a.href, window.location.href);
      if (to.hash === `#${id}` && to.pathname === window.location.pathname) setFolded(key, false);
    };
    openIfNamed();
    window.addEventListener("hashchange", openIfNamed);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", openIfNamed);
      document.removeEventListener("click", onClick);
    };
  }, [id, key]);

  return (
    <section id={id} className="space-y-3 scroll-mt-16" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="m-0">
        <button
          type="button"
          onClick={() => setFolded(key, !folded)}
          aria-expanded={!folded}
          aria-controls={bodyId}
          className="no-print w-full flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-left bg-surface border rounded-xl px-4 py-2.5 hover:bg-surface-2 transition-colors"
        >
          <ChevronDown size={16} aria-hidden className={`self-center shrink-0 text-muted transition-transform motion-reduce:transition-none ${folded ? "-rotate-90" : ""}`} />
          <span className="font-bold">{title}</span>
          {sub && <span className="text-xs text-muted font-normal min-w-0">{sub}</span>}
          <span className="ms-auto text-xs text-muted font-normal" aria-hidden>{folded ? "Show" : "Hide"}</span>
        </button>
        <span className="print-only text-base font-bold">{title}</span>
      </h2>
      <div id={bodyId} className={folded ? "hidden print:block print:space-y-3" : "space-y-3"}>
        {children}
      </div>
    </section>
  );
}
