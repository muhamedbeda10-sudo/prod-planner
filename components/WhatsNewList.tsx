"use client";

import Link from "next/link";
import { WHATS_NEW, unseenCount } from "@/lib/domain/whatsNew";
import { formatDate } from "@/lib/domain/format";

/** The What's new list itself — its own chunk, fetched when the window opens
 *  (the full history is large and every page carries the bar). `seen` is the
 *  newest entry this person had seen when the page loaded: the ones after it
 *  stay marked while the list is open. */
export function WhatsNewList({ seen, onNavigate }: { seen: string | null; onNavigate: () => void }) {
  const fresh = unseenCount(seen);
  return (
    <ol className="space-y-3 max-h-[65vh] overflow-y-auto pe-1">
      {WHATS_NEW.map((e, i) => (
        <li key={e.id} className={`rounded-lg border px-3 py-2.5 ${i < fresh ? "border-brand/50 bg-brand-light/30" : ""}`}>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-bold">{e.title}</span>
            {i < fresh && <span className="pill pill-ok text-[11px]">new</span>}
            <span className="ms-auto text-xs text-muted tabnum">{formatDate(e.dateISO)}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">{e.where}</div>
          <p className="text-sm mt-1">{e.body}</p>
          {e.href && <Link href={e.href} onClick={onNavigate} aria-label={`Open ${e.title}`} className="text-xs font-semibold text-brand-ink hover:underline">Open →</Link>}
        </li>
      ))}
    </ol>
  );
}
