import type { ReactNode } from "react";

/**
 * The page's toolbar row. Pages carry no title — the highlighted tab in the
 * nav already says where you are — so this is just the view switches and
 * buttons, packed at the top. `label` is for a page whose name IS data (a
 * tank's serial, the code being traced); a plain page name is not shown.
 */
export function PageHeader({
  label,
  children,
}: {
  /** @deprecated page titles were removed app-wide — accepted, not rendered */
  title?: string;
  /** @deprecated headlines were removed app-wide — accepted but not rendered */
  sub?: string;
  label?: ReactNode;
  children?: ReactNode;
}) {
  if (!label && !children) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      {label && <span className="text-base font-extrabold tracking-tight ltr">{label}</span>}
      {children && <div className="flex flex-wrap items-center gap-2 no-print">{children}</div>}
    </div>
  );
}

/**
 * The head of a screen: its name, a quiet line under it, and — always in the
 * same place, the top right — the switch to the tab's OTHER views. Every view
 * of a tab carries it, so the switch never moves as you go between them.
 * Off the paper: the printed sheets carry their own masthead.
 */
export function PageHead({
  title,
  sub,
  views,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** The tab's view switch (<ViewTabs>), pinned to the right. */
  views?: ReactNode;
  /** Anything that belongs beside the title (a window picker, a badge). */
  children?: ReactNode;
}) {
  return (
    <div className="page-head no-print">
      <h1 className="page-title">{title}</h1>
      {sub && <span className="page-sub">{sub}</span>}
      {children}
      {views && <span className="ml-auto">{views}</span>}
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
 *  instead of looking like a layout bug.
 *
 *  Several SOIs behind one row CASCADE: the cell shows the first and a "+N"
 *  badge, and opens into a vertical list on click. A joined strip of sixteen
 *  codes made the column wider than the rest of the table put together, and
 *  repeated on every line of the BOM. Native <details>, so it works in server
 *  and client components alike and needs no state. */
export function Soi({
  soi,
  className = "",
}: {
  soi: string | null | undefined;
  className?: string;
}) {
  const v = (soi ?? "").trim();
  if (!v) return <span className={`text-muted ${className}`}>—</span>;
  const parts = v.split("·").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return (
      <span className={`ltr text-xs font-semibold whitespace-nowrap ${className}`} title={`SOI ${v}`}>
        {v}
      </span>
    );
  }
  return (
    <details className={`soi-cascade ltr text-xs font-semibold ${className}`} title={`${parts.length} orders on this line — click to open`}>
      <summary className="cursor-pointer whitespace-nowrap select-none">
        {parts[0]}
        <span className="pill pill-muted ml-1">+{parts.length - 1}</span>
      </summary>
      <div className="mt-1 flex flex-col gap-0.5">
        {parts.map((p) => (
          <span key={p} className="whitespace-nowrap">{p}</span>
        ))}
      </div>
    </details>
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
