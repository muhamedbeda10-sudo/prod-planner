"use client";

import { useTransition } from "react";
import type { HiddenLineDTO } from "@/lib/server/worklistExtras";
import { unhideWorklistLine } from "@/app/worklist/actions";

/** ADMIN — the lines removed from this worklist, with one-click restore.
 *  Collapsed at the bottom of the page so it never distracts the floor. */
export function HiddenLinesPanel({ rows }: { rows: HiddenLineDTO[] }) {
  const [pending, startTransition] = useTransition();
  if (rows.length === 0) return null;

  function restore(r: HiddenLineDTO) {
    const fd = new FormData();
    fd.set("dept", r.dept);
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    startTransition(async () => {
      const res = await unhideWorklistLine(fd);
      if (!res.ok) alert(res.error ?? "Failed");
    });
  }

  return (
    <details className="mt-8 no-print">
      <summary className="text-xs text-muted cursor-pointer select-none">
        🗑 Hidden lines ({rows.length}) — removed from this worklist by an admin, click to restore
      </summary>
      <div className="mt-2 flex flex-wrap gap-2">
        {rows.map((r) => (
          <button
            key={`${r.bom}|${r.mo}|${r.item}`}
            type="button"
            onClick={() => restore(r)}
            disabled={pending}
            className="pill pill-muted hover:ring-2 hover:ring-brand/60 transition-all disabled:opacity-50"
            title="Restore this line to the worklist"
          >
            ↩ {r.mo || r.bom} · {r.item}
          </button>
        ))}
      </div>
    </details>
  );
}
