import type { ReactNode } from "react";

/**
 * The older page header, kept as an adapter so every page wears the ONE head:
 * its title (an emoji in front is dropped — the title is words, read to a
 * screen reader only), its sub, and whatever it held as actions on the right.
 * `label` (a tank's serial, a traced code) is the record on screen, not a
 * page name: it stays in sight, first in the row.
 */
export function PageHeader({
  title,
  sub,
  label,
  children,
}: {
  title?: string;
  sub?: string;
  label?: ReactNode;
  children?: ReactNode;
}) {
  const clean = title ? title.replace(/^[^\p{L}\p{N}]+/u, "").trim() : "";
  return (
    <PageHead title={clean || label || ""} sub={sub} actions={children}>
      {label && <span className="font-bold ltr">{label}</span>}
    </PageHead>
  );
}

/**
 * The head of a screen. A screen shows no name of its own — the top bar's lit
 * tab says where you are, and every row of the screen goes to its work — so
 * the title and the line under it are read to a screen reader only (the
 * page's one <h1>). What shows is ONE toolbar row, and only when there is
 * something for it: anything that belongs at its start (a picker, the line
 * switch), then on the right the page's actions (a decisions button …) and — always last,
 * in the same place on every view of a tab — the switch to the tab's OTHER
 * views. A screen with a filter bar puts these in that bar instead. Off the
 * paper: the printed sheets carry their own masthead.
 */
export function PageHead({
  title,
  sub,
  views,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** The tab's view switch (<ViewTabs>), pinned to the right end. */
  views?: ReactNode;
  /** The page's actions (a decisions button, a download), right-aligned before the views. */
  actions?: ReactNode;
  /** Anything that belongs beside the title (a window picker, a badge). */
  children?: ReactNode;
}) {
  return (
    <>
      <h1 className="sr-only">{title}{sub ? <> — {sub}</> : null}</h1>
      {(children || actions || views) && (
        <div className="page-head no-print">
          {children}
          {(actions || views) && (
            <span className="ms-auto flex flex-wrap items-center gap-2">
              {actions}
              {views}
            </span>
          )}
        </div>
      )}
    </>
  );
}

const COLUMN_WIDTH = { "3xl": "max-w-3xl", "4xl": "max-w-4xl" } as const;

/** A one-column screen (the inbox, automations, settings): a width that reads
 *  well, centred in whatever room the window and the docked assistant leave —
 *  never stuck to one side of a wide screen. */
export function ReadingColumn({ children, width = "4xl", className = "" }: { children: ReactNode; width?: keyof typeof COLUMN_WIDTH; className?: string }) {
  return <div className={`mx-auto w-full ${COLUMN_WIDTH[width]} ${className}`}>{children}</div>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border rounded-xl overflow-hidden ${className}`}>{children}</div>
  );
}

/** Red→amber→green scale for a 0..1 fraction (workbook semantics, ATC-green
 *  endpoint): the class of one of five status washes (`.pct-0` … `.pct-4` in
 *  globals.css), each on the theme's own ok / warn / bad tokens so the cell
 *  reads in light and dark alike. Quarter steps — red below 25%, red→amber,
 *  amber, amber→green, and green only at 100%. No fraction → no class, so
 *  the cell keeps its row's colours. */
export function pctClass(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "";
  const f = Math.max(0, Math.min(1, fraction));
  return f >= 1 ? "pct-4" : `pct-${Math.floor(f * 4)}`;
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

/**
 * What a save form shows when the server action threw before answering (the
 * connection dropped, the deploy rolled over): the write may or may not have
 * landed, so the person checks before saving again instead of doubling it.
 */
export const SAVE_UNCONFIRMED = "Could not confirm the save — refresh and check the records before trying again.";

