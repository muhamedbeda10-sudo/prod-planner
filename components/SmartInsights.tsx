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
  const critical = insights.filter((i) => i.severity === "critical").length;
  const warns = insights.filter((i) => i.severity === "warn").length;

  return (
    <section
      className="rounded-xl border overflow-hidden"
      style={{ borderColor: "color-mix(in srgb, var(--brand) 45%, transparent)" }}
    >
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-gradient-to-l from-brand-light/60 to-transparent">
        <div className="flex items-center gap-2.5">
          <span className="text-xl">✨</span>
          <div>
            <h2 className="!m-0 leading-tight">Smart Insights</h2>
            <p className="text-[11px] text-muted">
              Automatic analysis of {data.analyzedEntries.toLocaleString()} production records and{" "}
              {data.analyzedLines.toLocaleString()} open lines · runs locally, updates on every refresh
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {critical > 0 && <span className="pill pill-bad">🚨 {critical} critical</span>}
          {warns > 0 && <span className="pill pill-warn">⚠️ {warns} to watch</span>}
          {critical === 0 && warns === 0 && <span className="pill pill-ok">✓ all clear</span>}
        </div>
      </div>

      {/* insight list */}
      {insights.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          Not enough data yet — insights appear once production is being logged.
        </p>
      ) : (
        <ul className="divide-y">
          {insights.map((ins) => {
            const sev = SEV[ins.severity];
            const body = (
              <div className="flex gap-3 px-4 py-2.5 items-start">
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
                  <Link href={ins.href} className="block hover:bg-brand-light/30 transition-colors">
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
    </section>
  );
}
