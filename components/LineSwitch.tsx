"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LINE_LABEL, PRODUCT_LINES, hrefWithLine } from "@/lib/domain/lines";
import { useActiveLine } from "@/components/LineContext";

// The switch between the plant's two product lines, in the page head of each
// screen whose rows depend on the line: the same Plan Tracker, Daily log or
// ODOO log, showing transformers or LV panels. Both are always on screen, the
// one shown is lit, and each is a link — the line is part of the address, so
// a bookmark or a link sent to a colleague opens the same line. Moving to the
// other line starts its screen fresh: a filter set for one line's rows (an
// MO, a month, a weekly plan) means nothing on the other's.

export function LineSwitch() {
  const line = useActiveLine();
  const path = usePathname();
  return (
    <nav className="seg" aria-label="Product line">
      {PRODUCT_LINES.map((l) => (
        <Link key={l} href={hrefWithLine(path, l)} aria-current={l === line ? "page" : undefined} className={l === line ? "on" : ""}>
          {LINE_LABEL[l]}
        </Link>
      ))}
    </nav>
  );
}
