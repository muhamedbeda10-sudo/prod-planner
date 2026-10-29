"use client";

import { useEffect, useRef } from "react";

// the page's own title while a printout borrows it, null otherwise — one for
// the page, as a printout with a header per machine sets it once per header
let pageTitle: string | null = null;

/** A printout takes its report's name: Save as PDF names the file after the
 *  page's title, so the header's title stands in for it while printing.
 *  While the assistant prints a report (html.ai-printing) only the header on
 *  that sheet names it, not the page's own under it. */
export function PrintTitle({ title }: { title: string }) {
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const before = () => {
      const aiPrinting = document.documentElement.classList.contains("ai-printing");
      const onSheet = !!mark.current?.closest(".ai-print-sheet");
      if (aiPrinting !== onSheet) return;
      pageTitle ??= document.title;
      document.title = title;
    };
    const after = () => {
      if (pageTitle === null) return;
      document.title = pageTitle;
      pageTitle = null;
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      after();
    };
  }, [title]);
  return <span ref={mark} hidden />;
}
