import type { ReactNode } from "react";

export function PageHeader({
  title,
  children,
}: {
  title: string;
  /** @deprecated headlines were removed app-wide — accepted but not rendered */
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5 pb-4 border-b">
      <h1 className="text-[22px] font-extrabold tracking-tight leading-tight">{title}</h1>
      <div className="flex flex-wrap items-center gap-3 no-print">{children}</div>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border rounded-xl overflow-hidden ${className}`}>{children}</div>
  );
}

/** Red→amber→green scale for a 0..1 fraction (workbook semantics, ATC-green endpoint). */
export function pctStyle(fraction: number | null): { background: string; color: string } {
  if (fraction === null || Number.isNaN(fraction)) return { background: "transparent", color: "inherit" };
  const f = Math.max(0, Math.min(1, fraction));
  // interpolate red(247,205,197) -> amber(252,228,166) -> ATC green tint(168,214,187)
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  let r, g, b;
  if (f < 0.5) {
    const t = f / 0.5;
    r = lerp(247, 252, t); g = lerp(205, 228, t); b = lerp(197, 166, t);
  } else {
    const t = (f - 0.5) / 0.5;
    r = lerp(252, 168, t); g = lerp(228, 214, t); b = lerp(166, 187, t);
  }
  return { background: `rgb(${r},${g},${b})`, color: "#1d2521" };
}

export function StatusPill({ status }: { status: string }) {
  const cls =
    status === "Done" || status === "Closed" || status === "Cut ready"
      ? "pill-ok"
      : status === "In progress" || status.startsWith("Partial")
        ? "pill-warn"
        : status === "Pending" || status === "NOT CUT YET" || status === "No plan data"
          ? "pill-bad"
          : "pill-muted";
  return <span className={`pill ${cls} ltr`}>{status}</span>;
}

export function Num({ v, className = "" }: { v: number | null | undefined; className?: string }) {
  if (v === null || v === undefined || v === 0) return <span className={`tabnum text-muted ${className}`}>0</span>;
  return <span className={`tabnum ${className}`}>{Number.isInteger(v) ? v : v.toFixed(1)}</span>;
}

/** The SOI of an order, as it reads on every screen that names one: the MO's
 *  own SOI, or — for a row that covers a whole BOM — the SOIs of its orders.
 *  Renders an em-dash rather than nothing, so a missing SOI is visibly missing
 *  instead of looking like a layout bug. */
export function Soi({
  soi,
  className = "",
}: {
  soi: string | null | undefined;
  className?: string;
}) {
  const v = (soi ?? "").trim();
  if (!v) return <span className={`text-muted ${className}`}>—</span>;
  return (
    <span className={`ltr text-xs font-semibold whitespace-nowrap ${className}`} title={`SOI ${v}`}>
      {v}
    </span>
  );
}

/** The SOI behind a row: its MO's, falling back to its BOM's when the row is
 *  BOM-level (the worklists group that way). */
export function soiOf(
  lookup: { byMo: Record<string, string>; byBom: Record<string, string> } | undefined,
  mo: string | null | undefined,
  bom?: string | null
): string | null {
  if (!lookup) return null;
  const m = (mo ?? "").trim();
  if (m && lookup.byMo[m]) return lookup.byMo[m];
  const b = (bom ?? "").trim();
  if (b && lookup.byBom[b]) return lookup.byBom[b];
  return null;
}
