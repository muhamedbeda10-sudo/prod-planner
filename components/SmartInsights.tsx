"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SmartInsightsData } from "@/lib/server/insights";
import type { Insight } from "@/lib/domain/insights";

// Severity → pill/strip styling (reuses the app's status palette)
const SEV: Record<Insight["severity"], { strip: string; label: string; pill: string }> = {
  critical: { strip: "var(--bad-fg)", label: "Action needed", pill: "pill-bad" },
  warn: { strip: "var(--warn-fg)", label: "Watch", pill: "pill-warn" },
  good: { strip: "var(--ok-fg)", label: "On track", pill: "pill-ok" },
  info: { strip: "var(--muted)", label: "Info", pill: "pill-muted" },
};

export function SmartInsights({ data }: { data: SmartInsightsData }) {
  const { insights } = data;
  const [open, setOpen] = useState(false);
  const critical = insights.filter((i) => i.severity === "critical").length;
  const warns = insights.filter((i) => i.severity === "warn").length;

  // close on ESC + lock background scroll while the popup is open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // the badge colour follows the most urgent thing waiting inside
  const badgeClass = critical > 0 ? "pill-bad" : warns > 0 ? "pill-warn" : "pill-ok";
  const badgeText = critical > 0 ? `${critical}` : warns > 0 ? `${warns}` : "✓";

  return (
    <>
      {/* trigger — a compact icon button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Open Smart Insights — automatic analysis of your production data"
        className="no-print relative inline-flex w-full items-center justify-center gap-2 rounded-xl border px-3.5 py-2 bg-gradient-to-l from-brand-light/60 to-transparent hover:from-brand-light transition-colors font-bold text-sm sm:w-auto"
        style={{ borderColor: "color-mix(in srgb, var(--brand) 45%, transparent)" }}
      >
        <span className="text-lg leading-none">✨</span>
        <span>Smart Insights</span>
        <span className={`pill ${badgeClass}`}>{badgeText}</span>
        {critical > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full animate-ping"
            style={{ background: "var(--bad-fg)" }}
          />
        )}
      </button>

      {/* popup */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Smart Insights"
          className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
        >
          {/* backdrop */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-[1px]"
          />

          {/* panel */}
          <div className="relative w-full max-w-2xl my-auto rounded-2xl border bg-surface shadow-2xl overflow-hidden">
            {/* header */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-gradient-to-l from-brand-light/60 to-transparent border-b">
              <div className="flex items-center gap-2.5">
                <span className="text-xl">✨</span>
                <div>
                  <h2 className="!m-0 leading-tight">Smart Insights</h2>
                  <p className="text-[11px] text-muted">
                    Automatic analysis of {data.analyzedEntries.toLocaleString()} production records and{" "}
                    {data.analyzedLines.toLocaleString()} open lines · runs locally
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {critical > 0 && <span className="pill pill-bad">🚨 {critical} critical</span>}
                {warns > 0 && <span className="pill pill-warn">⚠️ {warns} to watch</span>}
                {critical === 0 && warns === 0 && <span className="pill pill-ok">✓ all clear</span>}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="ml-1 grid place-items-center h-7 w-7 rounded-lg hover:bg-brand-light/60 transition-colors text-muted text-lg leading-none"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* insight list */}
            {insights.length === 0 ? (
              <p className="px-4 py-8 text-sm text-muted text-center">
                Not enough data yet — insights appear once production is being logged.
              </p>
            ) : (
              <ul className="divide-y max-h-[70vh] overflow-y-auto">
                {insights.map((ins) => {
                  const sev = SEV[ins.severity];
                  const body = (
                    <div className="flex gap-3 px-4 py-3 items-start">
                      <span aria-hidden className="w-1 self-stretch rounded-full shrink-0" style={{ background: sev.strip }} />
                      <span className="text-lg leading-6 shrink-0">{ins.icon}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-sm">{ins.title}</span>
                          <span className={`pill ${sev.pill}`}>{sev.label}</span>
                        </div>
                        <p className="text-xs text-muted mt-0.5 leading-relaxed">{ins.detail}</p>
                      </div>
                      {ins.href && <span className="ml-auto self-center text-muted text-sm shrink-0">→</span>}
                    </div>
                  );
                  return (
                    <li key={ins.id} className="bg-surface">
                      {ins.href ? (
                        <Link href={ins.href} onClick={() => setOpen(false)} className="block hover:bg-brand-light/30 transition-colors">
                          {body}
                        </Link>
                      ) : (
                        body
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
