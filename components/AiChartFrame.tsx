"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { ChartCard, Legend, TipBox, fmt, type TableRow } from "@/components/charts/kit";
import type { AiTone } from "@/lib/domain/aiChart";

// The frame every chart in an AI answer sits in — the dashboards' card, its
// numbers one click away as a table with their export (the chart is never
// the only way to read a number), and a legend under it when it carries more
// than one series. The tooltips' shell, shared by every form.

export const TICK = { fontSize: 11, fill: "var(--muted)" } as const;

/** " pcs" after a number, or nothing. */
export const unitOf = (unit: string) => (unit ? ` ${unit}` : "");

export const valueText = (v: number, unit: string) => `${fmt(v)}${unitOf(unit)}`;

const fileOf = (title: string) => title.replace(/[^\w؀-ۿ -]+/g, "").slice(0, 60) || "ai-chart";

export function ChartFrame({
  title,
  sub,
  rows,
  legend,
  children,
}: {
  title: string;
  sub?: ReactNode;
  /** The chart's numbers as a table — its twin and its export. */
  rows: TableRow[];
  legend?: { label: string; color: string; line?: boolean }[];
  children: ReactNode;
}) {
  return (
    <ChartCard title={title || "Chart"} sub={sub ? <span dir="auto">{sub}</span> : undefined} className="my-3 not-prose ai-chart" table={{ rows, filename: fileOf(title), sheet: "Data" }}>
      {children}
      {legend && legend.length > 1 && (
        <div className="mt-2">
          <Legend items={legend} />
        </div>
      )}
    </ChartCard>
  );
}

/** A tooltip of one mark or one x: its title and its values, the value first. */
export function Tip({ title, rows }: { title: string; rows: { label: string; value: string; color?: string; line?: boolean }[] }) {
  return <TipBox title={title} rows={rows} />;
}

/** What a recharts tooltip hands its content. */
export type TipProps = {
  active?: boolean;
  payload?: readonly { name?: unknown; value?: unknown; color?: string; dataKey?: unknown; payload?: Record<string, unknown> }[];
  label?: unknown;
};

const TONE = {
  ok: { icon: CheckCircle2, cls: "text-ok-fg", label: "Good" },
  warn: { icon: AlertTriangle, cls: "text-warn-fg", label: "Watch" },
  bad: { icon: XCircle, cls: "text-bad-fg", label: "Problem" },
} as const;

/** A status, never by colour alone: its icon, and its name for a screen reader. */
export function ToneIcon({ tone, size = 13 }: { tone: AiTone | null; size?: number }) {
  if (!tone) return null;
  const t = TONE[tone];
  return <t.icon size={size} className={`${t.cls} shrink-0`} aria-label={t.label} />;
}

/** The rendered width of an element, kept up to date. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
