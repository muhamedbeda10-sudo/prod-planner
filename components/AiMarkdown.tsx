"use client";

import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AiChart } from "@/components/AiChart";
import { isChartBlock } from "@/lib/domain/aiChart";
import { humanizeKey, looksLikeColumn, readableDate } from "@/lib/domain/fieldNames";
import { isEvidenceAnchor } from "@/lib/domain/aiEvidence";

// An AI answer as it reads: Markdown (tables, lists, bold) in the app's own
// type. The answer as a whole reads in the language it was written in — an
// Arabic answer right to left — while each paragraph and cell still finds its
// own direction for an MO number or an English line inside it. A table reads
// in the language of its head: Arabic columns right to left, columns named in
// English (the database's, an automation's rows) left to right — whatever the
// words around it. Column names written the database's way read as words,
// and dates as the app writes them. A ```chart block is drawn
// as a chart. No raw HTML is rendered — only Markdown — and nothing in an
// answer is fetched from outside: no images, and outside links are text.

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
const NUMERIC = /^[\s$€£%+\-−–—.,0-9/٪٠-٩]*(?:[0-9٠-٩][\s$€£%.,0-9/٪٠-٩]*)?(?:\s*(?:pcs|pc|h|hrs|kg|mm|d|days|day|يوم|أيام|قطعة|ساعة|كجم)\.?)?\s*$/u;
const isNumeric = (s: string) => s.trim() !== "" && NUMERIC.test(s) && /[0-9٠-٩]/.test(s);

function components(streaming: boolean): Components {
  return {
    p: ({ children }) => <p dir="auto" className="my-2.5">{children}</p>,
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
    // a row of data could tell the model to put figures in an address
    a: ({ children, href }) =>
      href && ((href.startsWith("/") && !href.startsWith("//")) || isEvidenceAnchor(href)) ? (
        <a href={href} className="text-brand-ink underline underline-offset-2" onClick={isEvidenceAnchor(href) ? (event) => {
          const source = document.getElementById(href.slice(1));
          if (source instanceof HTMLDetailsElement) {
            event.preventDefault(); source.open = true; source.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        } : undefined}>{children}</a>
      ) : (
        <span>{children}{href ? <span className="text-muted text-xs ltr"> ({href})</span> : null}</span>
      ),
    // nothing in an answer loads from anywhere
    img: () => null,
    blockquote: ({ children }) => <blockquote dir="auto" className="my-2.5 border-s-2 border-[var(--border-strong)] ps-3 text-muted">{children}</blockquote>,
    hr: () => <hr className="my-4 border-[var(--border)]" />,
    table: ({ children, node }) => {
      const head = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "thead");
      return (
        <div className="my-3 overflow-x-auto rounded-lg border" dir={textDirection(textOf(head))}>
          <table className="w-full">{children}</table>
        </div>
      );
    },
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    th: ({ children, node }) => {
      const text = textOf(node as HastNode | undefined);
      return <th>{looksLikeColumn(text) ? humanizeKey(text) : children}</th>;
    },
    td: ({ children, node }) => {
      const text = textOf(node as HastNode | undefined);
      const date = readableDate(text);
      if (date) return <td className="whitespace-nowrap" title={text}>{date}</td>;
      // a long text gets room to read as lines, not a word to a line
      return <td className={isNumeric(text) ? "num ltr" : text.length > 40 ? "cell-wide" : ""} dir="auto">{children}</td>;
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

const LIVE = components(true);
const DONE = components(false);

export function AiMarkdown({ text, streaming = false, className = "" }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={`ai-md min-w-0 ${className}`} dir={textDirection(text)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? LIVE : DONE}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
