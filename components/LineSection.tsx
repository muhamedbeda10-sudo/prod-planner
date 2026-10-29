"use client";

import { useEffect, useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useStoredValue, writeStoredValue } from "@/components/useStoredFilters";

// One product line's part of a plant dashboard (Planning, Production): a
// header that folds it away, so a planner who works one line can keep the
// other out of sight without losing the plant's figures above. The fold is
// remembered in this browser, per page and line (the stored filters' own
// store — the server renders it open); a link that names the section (#tr,
// #lv) opens it. On paper every section prints, folded or not.

const storeKey = (page: string, id: string) => `fold:${page}:${id}`;

export function LineSection({ id, page, title, sub, foldable = true, children }: {
  /** The anchor a link opens the section at. */
  id: string;
  /** Which dashboard — the fold is remembered per page. */
  page: string;
  title: string;
  /** A quiet line beside the title: the plan, the last recorded day. */
  sub?: ReactNode;
  /** Whether it folds — not when it is the only line on the page (the page's own switch shows the other). */
  foldable?: boolean;
  children: ReactNode;
}) {
  const key = storeKey(page, id);
  const stored = useStoredValue(key);
  const folded = foldable && stored === "0";
  const bodyId = useId();

  // a link naming the section opens it, whatever was remembered; the hash is
  // then taken off the address, so the same link opens it again next time
  useEffect(() => {
    const openIfNamed = () => {
      if (window.location.hash !== `#${id}`) return;
      writeStoredValue(key, "");
      // a null state lets the router take the new address as its own
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    openIfNamed();
    window.addEventListener("hashchange", openIfNamed);
    return () => window.removeEventListener("hashchange", openIfNamed);
  }, [id, key]);

  return (
    <section id={id} className="space-y-3 scroll-mt-16" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="m-0">
        {!foldable ? (
          <span className="no-print w-full flex flex-wrap items-baseline gap-x-3 gap-y-0.5 bg-surface border rounded-xl px-4 py-2.5">
            <span className="font-bold">{title}</span>
            {sub && <span className="explain text-xs text-muted font-normal min-w-0">{sub}</span>}
          </span>
        ) : (
        <button
          type="button"
          onClick={() => writeStoredValue(key, folded ? "" : "0")}
          aria-expanded={!folded}
          aria-controls={bodyId}
          className="no-print w-full flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-left bg-surface border rounded-xl px-4 py-2.5 hover:bg-surface-2 transition-colors"
        >
          <ChevronDown size={16} aria-hidden className={`self-center shrink-0 text-muted transition-transform motion-reduce:transition-none ${folded ? "-rotate-90" : ""}`} />
          <span className="font-bold">{title}</span>
          {sub && <span className="explain text-xs text-muted font-normal min-w-0">{sub}</span>}
          <span className="ms-auto text-xs text-muted font-normal" aria-hidden>{folded ? "Show" : "Hide"}</span>
        </button>
        )}
        <span className="print-only text-base font-bold">{title}</span>
      </h2>
      <div id={bodyId} className={folded ? "hidden print:block print:space-y-3" : "space-y-3"}>
        {children}
      </div>
    </section>
  );
}
