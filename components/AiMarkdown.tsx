"use client";

import { Children, cloneElement, createContext, isValidElement, memo, useContext, useMemo, useState, type ReactElement, type ReactNode } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, CheckCircle2, ChevronDown, Crosshair, FileSpreadsheet, Printer, XCircle } from "lucide-react";
import { isChartBlock } from "@/lib/domain/aiChart";
import { humanizeKey, looksLikeColumn, readableDate } from "@/lib/domain/fieldNames";
import { isEvidenceAnchor, safeHref } from "@/lib/domain/aiEvidence";
import { fileLinkKind } from "@/lib/domain/aiFiles";
import { scopeLineOf } from "@/lib/domain/aiAnswer";
import { calloutOf, columnKind, FIGURE_UNITS, groupedFigure, TABLE_FOLD_AT, withoutCalloutMark } from "@/lib/domain/aiTable";
import { downloadXlsx } from "@/components/ExportButton";

// An AI answer as it reads: Markdown (tables, lists, bold) in the app's own
// type. The answer as a whole reads in the language it was written in — an
// Arabic answer right to left — while each paragraph and cell still finds its
// own direction for an MO number or an English line inside it. A table reads
// in the language of its head: Arabic columns right to left, columns named in
// English (the database's, an automation's rows) left to right — whatever the
// words around it. Column names written the database's way read as words,
// and dates as the app writes them, figures with their thousands separated.
// A table longer than a screen folds to its first rows with a button for
// the rest, and every table has its export to Excel. A ```chart block is
// drawn as a chart; a ```followups block (the next questions the assistant
// offers) is never drawn here — the chat draws it as buttons. A blockquote
// that opens with ⚠️, ✅ or ❌ is a callout in that tone, and the closing
// "Scope: …" line is a quiet strip. A link to a file the assistant made is a
// button — download it, or print it. No raw HTML is
// rendered — only Markdown — and nothing in an answer is fetched from
// outside: no images, and outside links are text.

// The chart (and Recharts under it) is the heaviest thing an answer can carry,
// and most answers, reports and tasks carry none. It is split into its own
// chunk and fetched the first time a chart block is drawn, with a quiet
// placeholder of a chart's height in the meantime — the text around it
// paints first.
const AiChart = dynamic(() => import("@/components/AiChart").then((m) => m.AiChart), {
  loading: () => <div className="my-3 h-24 rounded-xl bg-surface-2/60 animate-pulse" aria-hidden />,
});

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

const textOf = (n: HastNode | undefined): string => (!n ? "" : n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join(""));

/** A list item that opens with its label in bold — "**Status:** Pending":
 *  the label, and the rest. */
function labelOf(li: HastNode | undefined): string | null {
  const first = li?.children?.find((c) => c.type === "element" || (c.type === "text" && (c.value ?? "").trim() !== ""));
  if (first?.tagName !== "strong") return null;
  const t = textOf(first).trim();
  return t.endsWith(":") && t.length > 1 && t.length <= 40 ? t.slice(0, -1) : null;
}

/** A list every item of which is "**Label:** value" — read as a panel of
 *  fields, the labels in a column, rather than as bullets. */
const isFieldList = (ul: HastNode | undefined): boolean => {
  const items = (ul?.children ?? []).filter((c) => c.tagName === "li");
  return items.length >= 2 && items.every((li) => labelOf(li) !== null);
};

/** The direction the text as a whole reads in — from its first letter. */
export function textDirection(text: string): "rtl" | "ltr" {
  const m = /[؀-ۿݐ-ݿ]|[A-Za-z]/.exec(text);
  return m && /[؀-ۿݐ-ݿ]/.test(m[0]) ? "rtl" : "ltr";
}

/** A table cell holding a figure: a number, a percentage, a count with its
 *  unit, a dash — it lines up on the end side with the other figures. */
const NUMERIC = new RegExp(`^[\\s$€£%+\\-−–—.,0-9/٪٠-٩]*(?:[0-9٠-٩][\\s$€£%.,0-9/٪٠-٩]*)?(?:\\s*(?:${FIGURE_UNITS})\\.?)?\\s*$`, "u");
const isNumeric = (s: string) => s.trim() !== "" && NUMERIC.test(s) && /[0-9٠-٩]/.test(s);

/** The heads of the table a cell sits in (set by the table), and the cell's
 *  column (set by its row) — what tells a figure from a name. */
const TableHeads = createContext<string[]>([]);

/** The children with the callout's leading mark (⚠️ ✅ ❌) taken off the
 *  first text — the icon stands for it. */
function withoutMark(nodes: ReactNode): ReactNode {
  const list = Children.toArray(nodes);
  // the first node that is not the newline between blocks
  const at = list.findIndex((n) => !(typeof n === "string" && n.trim() === ""));
  if (at < 0) return nodes;
  const first = list[at];
  const stripped = typeof first === "string"
    ? withoutCalloutMark(first)
    : isValidElement<{ children?: ReactNode }>(first) ? cloneElement(first, { children: withoutMark(first.props.children) }) : first;
  return list.map((n, i) => (i === at ? stripped : n));
}

const CALLOUT = {
  warn: { icon: AlertTriangle, label: "Warning" },
  ok: { icon: CheckCircle2, label: "In order" },
  bad: { icon: XCircle, label: "Problem" },
} as const;

/** A table read off its tree: its heads as text, its rows as {column:
 *  value} for the export (the columns read as words). */
function readTable(table: HastNode | undefined): { heads: string[]; rows: Record<string, string>[] } {
  const head = table?.children?.find((c) => c.tagName === "thead")?.children?.find((c) => c.tagName === "tr");
  const heads = (head?.children ?? []).filter((c) => c.tagName === "th").map((c) => textOf(c).trim());
  const columns = heads.map((t, i) => (looksLikeColumn(t) ? humanizeKey(t) : t) || `Column ${i + 1}`);
  const body = table?.children?.find((c) => c.tagName === "tbody");
  const rows = (body?.children ?? []).filter((r) => r.tagName === "tr").map((r) => {
    const cells = (r.children ?? []).filter((c) => c.tagName === "td").map((c) => textOf(c).trim());
    return Object.fromEntries(columns.map((col, i) => [col, cells[i] ?? ""]));
  });
  return { heads, rows };
}

/** A body cell: a figure (grouped, on the end side), a long text with room
 *  to read as lines, or what it is. */
function Td({ text, col, children }: { text: string; col: number | undefined; children: ReactNode }) {
  const heads = useContext(TableHeads);
  const head = col !== undefined ? heads[col] : undefined;
  const grouped = groupedFigure(text, head === undefined ? "unknown" : columnKind(head));
  if (grouped) return <td className="num ltr" title={text.trim()}>{grouped}</td>;
  // a long text gets room to read as lines, not a word to a line
  return <td className={isNumeric(text) ? "num ltr" : text.length > 40 ? "cell-wide" : ""} dir="auto">{children}</td>;
}

/** A Markdown table: its export, and — past TABLE_FOLD_AT rows — folded to
 *  its first rows with a button for the rest (the printout shows them all). */
function MdTable({ node, children, dir }: { node: HastNode | undefined; children: ReactNode; dir: "rtl" | "ltr" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // read once per table, not on every streamed token
  const { heads, rows } = useMemo(() => readTable(node), [node]);
  const folded = rows.length > TABLE_FOLD_AT && !open;
  return (
    <div className={`my-3 md-table-wrap ${folded ? "md-table-folded" : ""}`} dir={dir}>
      <div className="overflow-x-auto rounded-lg border">
        <TableHeads.Provider value={heads}>
          <table className="md-table w-full">{children}</table>
        </TableHeads.Provider>
      </div>
      <div className="md-table-foot no-print">
        <span className="text-muted tabnum">{rows.length} row{rows.length === 1 ? "" : "s"}</span>
        {rows.length > TABLE_FOLD_AT && (
          <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setOpen((v) => !v)} aria-expanded={!folded}>
            <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
            {folded ? `Show all ${rows.length}` : `Show the first ${TABLE_FOLD_AT}`}
          </button>
        )}
        {rows.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm text-xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await downloadXlsx(rows, "ai-table.xlsx", "Data"); } finally { setBusy(false); }
            }}
            title="Export this table to Excel"
          >
            <FileSpreadsheet size={13} className="text-ok-fg" aria-hidden /> {busy ? "Preparing…" : "Excel"}
          </button>
        )}
      </div>
    </div>
  );
}

function components(streaming: boolean, ownFiles: boolean): Components {
  return {
    p: ({ children, node }) => {
      // the closing scope line — the line, the period, the moment — as a strip
      const scope = scopeLineOf(textOf(node as HastNode | undefined));
      if (scope) return (
        <p className="ai-scope" dir="auto" title="The line, the period and the moment the figures were read">
          <Crosshair size={12} aria-hidden />
          <span>{scope}</span>
        </p>
      );
      return <p dir="auto" className="my-2.5">{children}</p>;
    },
    ul: ({ children, node }) =>
      isFieldList(node as HastNode | undefined) ? (
        <ul dir="auto" className="ai-fields">{children}</ul>
      ) : (
        <ul dir="auto" className="my-2.5 ps-5 list-disc space-y-1">{children}</ul>
      ),
    ol: ({ children }) => <ol dir="auto" className="my-2.5 ps-5 list-decimal space-y-1">{children}</ol>,
    li: ({ children, node }) => {
      const label = labelOf(node as HastNode | undefined);
      if (label === null) return <li dir="auto">{children}</li>;
      // the bold label becomes the row's first cell; what follows it, its value
      const items = Children.toArray(children);
      const rest = items.slice(items.findIndex((c) => isValidElement(c)) + 1);
      return (
        <li>
          <span className="ai-field-label" dir="auto">{label}</span>
          <span className="ai-field-value" dir="auto">{trimStart(rest)}</span>
        </li>
      );
    },
    h1: ({ children }) => <h3 dir="auto" className="mt-5 mb-1.5 text-[15px] font-bold">{children}</h3>,
    h2: ({ children }) => <h3 dir="auto" className="mt-5 mb-1.5 text-[15px] font-bold">{children}</h3>,
    h3: ({ children }) => <h4 dir="auto" className="mt-4 mb-1 text-sm font-bold">{children}</h4>,
    h4: ({ children }) => <h4 dir="auto" className="mt-3 mb-1 text-sm font-semibold">{children}</h4>,
    // a link into the app is a link; anything outside is shown, not followed —
    // a row of data could tell the model to put figures in an address. A file
    // the assistant made is a button in the chat it was made in; shared onward
    // (the inbox, a task) it stays the asker's, so it reads as plain text
    a: ({ children, href }) => {
      const file = href ? fileLinkKind(href) : null;
      if (file) return ownFiles ? <FileLink kind={file} href={href!}>{children}</FileLink> : <span>{children}</span>;
      return href && (safeHref(href) || isEvidenceAnchor(href)) ? (
        <a href={href} className="text-brand-ink underline underline-offset-2" onClick={isEvidenceAnchor(href) ? (event) => {
          const source = document.getElementById(href.slice(1));
          if (source instanceof HTMLDetailsElement) {
            event.preventDefault(); source.open = true; source.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        } : undefined}>{children}</a>
      ) : (
        <span>{children}{href ? <span className="text-muted text-xs ltr"> ({href})</span> : null}</span>
      );
    },
    // nothing in an answer loads from anywhere
    img: () => null,
    blockquote: ({ children, node }) => {
      const tone = calloutOf(textOf(node as HastNode | undefined));
      if (!tone) return <blockquote dir="auto" className="my-2.5 border-s-2 border-[var(--border-strong)] ps-3 text-muted">{children}</blockquote>;
      const { icon: Icon, label } = CALLOUT[tone];
      return (
        <div dir="auto" className={`ai-callout ai-callout-${tone}`} role="note">
          <Icon size={16} className="ai-callout-icon" aria-label={label} />
          <div className="min-w-0">{withoutMark(children)}</div>
        </div>
      );
    },
    hr: () => <hr className="my-4 border-[var(--border)]" />,
    table: ({ children, node }) => {
      const head = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "thead");
      return <MdTable node={node as HastNode | undefined} dir={textDirection(textOf(head))}>{children}</MdTable>;
    },
    thead: ({ children }) => <thead>{children}</thead>,
    // the rows past the fold are marked, so a folded table hides them
    tbody: ({ children }) => <tbody>{Children.map(children, (c, i) => (isValidElement(c) && i >= TABLE_FOLD_AT ? cloneElement(c as ReactElement<{ className?: string }>, { className: "md-row-over" }) : c))}</tbody>,
    // each cell told its column, so a figure in a column of names stays a name
    tr: ({ children, className }) => <tr className={className}>{Children.map(children, (c, i) => (isValidElement(c) ? cloneElement(c as ReactElement<{ col?: number }>, { col: i }) : c))}</tr>,
    th: ({ children, node }) => {
      const text = textOf(node as HastNode | undefined);
      return <th>{looksLikeColumn(text) ? humanizeKey(text) : children}</th>;
    },
    td: ({ children, node, ...rest }) => {
      const text = textOf(node as HastNode | undefined);
      const date = readableDate(text);
      if (date) return <td className="whitespace-nowrap" title={text}>{date}</td>;
      const col = (rest as { col?: number }).col;
      return <Td text={text} col={col}>{children}</Td>;
    },
    code: ({ children, className }) => <code className={`${className ?? ""} px-1 py-0.5 rounded bg-surface-2 ltr`}>{children}</code>,
    pre: ({ node, children }) => {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.type === "element");
      if (code?.tagName === "code") {
        const cls = Array.isArray(code.properties?.className) ? (code.properties.className as unknown[]).map(String) : [];
        const lang = cls.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
        const source = textOf(code);
        // a chart's JSON draws as the chart, however its fence was labelled
        if (isChartBlock(lang, source)) return <AiChart source={source} streaming={streaming} />;
        // the follow-up questions are the chat's buttons, never text here —
        // nor while the fence's name is still being streamed ("```follo")
        if (/^follow[-_]?ups$/i.test(lang) || (lang.length > 0 && "followups".startsWith(lang.toLowerCase()))) return null;
      }
      return <pre className="my-2.5 p-3 rounded-lg bg-surface-2 overflow-x-auto text-xs ltr">{children}</pre>;
    },
  };
}

/** The value after a label, its leading space dropped. */
function trimStart(nodes: ReactNode[]): ReactNode[] {
  if (nodes.length > 0 && typeof nodes[0] === "string") return [nodes[0].replace(/^\s+/, ""), ...nodes.slice(1)];
  return nodes;
}

/** A file the assistant made: download it, or open it laid out to print in a tab of its own. */
function FileLink({ kind, href, children }: { kind: "download" | "print"; href: string; children: ReactNode }) {
  const Icon = kind === "download" ? FileSpreadsheet : Printer;
  return (
    <a href={href} {...(kind === "download" ? { download: true } : { target: "_blank", rel: "noopener" })} className="no-print btn btn-secondary btn-sm my-0.5 no-underline">
      <Icon size={14} className={kind === "download" ? "text-ok-fg" : undefined} aria-hidden />{children}
    </a>
  );
}

const LIVE = components(true, true);
const DONE = components(false, true);
const SHARED = components(false, false);

/** Parsed again only when its text changes — not on every streamed token
 *  of the answer after it. `shared`: an answer read away from its chat (the
 *  inbox, a task) — the files it links to are the asker's, so they are not
 *  offered there. */
export const AiMarkdown = memo(function AiMarkdown({ text, streaming = false, shared = false, className = "" }: { text: string; streaming?: boolean; shared?: boolean; className?: string }) {
  return (
    <div className={`ai-md min-w-0 ${className}`} dir={textDirection(text)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? LIVE : shared ? SHARED : DONE}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
