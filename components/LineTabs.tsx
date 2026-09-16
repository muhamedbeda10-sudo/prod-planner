"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LINE_LABEL, PRODUCT_LINES, type ProductLine } from "@/lib/domain/lines";
import { setLineAction } from "@/app/line/actions";

// The switch between the plant's two product lines. It sits in the nav so it
// is inside every tab at once: the same Orders, Tracker or Dashboard, showing
// transformers or LV panels — never both. The choice is a cookie, so it
// follows the planner from tab to tab and survives the browser closing.

export function LineTabs({ line }: { line: ProductLine }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (next: ProductLine) => {
    if (next === line || pending) return;
    start(async () => {
      await setLineAction(next);
      router.refresh();
    });
  };
  return (
    <div className={`seg ${pending ? "opacity-60" : ""}`} role="tablist" aria-label="Product line" title="Which of the plant's two products every tab shows">
      {PRODUCT_LINES.map((l) => (
        <button key={l} type="button" role="tab" aria-selected={l === line} className={l === line ? "on" : ""} onClick={() => go(l)} disabled={pending}>
          {LINE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
