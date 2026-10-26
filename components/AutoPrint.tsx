"use client";

import { useEffect } from "react";
import { drawn } from "@/components/AiPrint";

/** Opens the print dialog once the page is drawn — the assistant's "Print"
 *  link lands on a page that is only there to be printed. */
export function AutoPrint() {
  useEffect(() => {
    let cancelled = false;
    drawn(document.body).then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
