"use client";

import { BookOpen, ExternalLink } from "lucide-react";
import { evidenceAnchor, type AiEvidence } from "@/lib/domain/aiEvidence";
import { formatDateTime } from "@/lib/domain/format";

export function AiSources({ sources }: { sources: readonly AiEvidence[] }) {
  if (!sources.length) return null;
  return (
    <section className="mt-3 space-y-1.5" aria-label="Answer sources">
      <p className="text-xs font-semibold text-muted flex items-center gap-1.5"><BookOpen size={13} aria-hidden />Sources · {sources.length}</p>
      {sources.map((source) => (
        <details key={source.id} id={evidenceAnchor(source.id)} className="rounded-lg border bg-surface-2 text-xs scroll-mt-3">
          <summary className="cursor-pointer px-3 py-2 font-semibold" dir="auto">{source.title}<span className="block text-[11px] text-muted font-normal mt-0.5">Read {formatDateTime(new Date(source.recordedAt))}</span></summary>
          <div className="border-t px-3 py-2 space-y-2">
            {source.links.length > 0 && <div className="flex flex-wrap gap-x-3 gap-y-1.5">{source.links.map((link) => <a key={`${link.href}|${link.label}`} href={link.href} className="inline-flex items-center gap-1 text-brand-ink underline underline-offset-2" dir="auto">{link.label}<ExternalLink size={11} aria-hidden /></a>)}</div>}
            <p className="text-muted">Snapshot used for this answer; live records may have changed since.</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-[11px] leading-relaxed" dir="ltr">{source.snapshot}</pre>
            {source.truncated && <p className="text-warn-fg">The snapshot preview is shortened. Open the related records for the full detail.</p>}
          </div>
        </details>
      ))}
    </section>
  );
}
