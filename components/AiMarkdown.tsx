"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AiChart } from "@/components/AiChart";
import { isChartBlock } from "@/lib/domain/aiChart";

// An AI answer as it reads: Markdown (tables, lists, bold) in the app's own
// type. The answer as a whole reads in the language it was written in — an
// Arabic answer right to left, its tables too, so every column lines up on
// one side — while each paragraph and cell still finds its own direction
// for an MO number or an English line inside it. A ```chart block is drawn
// as a chart. No raw HTML is rendered — only Markdown — and nothing in an
// answer is fetched from outside: no images, and outside links are text.

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

const textOf = (n: HastNode | undefined): string => (!n ? "" : n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join(""));

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
    ul: ({ children }) => <ul dir="auto" className="my-2.5 ps-5 list-disc space-y-1">{children}</ul>,
    ol: ({ children }) => <ol dir="auto" className="my-2.5 ps-5 list-decimal space-y-1">{children}</ol>,
    li: ({ children }) => <li dir="auto">{children}</li>,
    h1: ({ children }) => <h3 dir="auto" className="mt-5 mb-1.5 text-[15px] font-bold">{children}</h3>,
    h2: ({ children }) => <h3 dir="auto" className="mt-5 mb-1.5 text-[15px] font-bold">{children}</h3>,
    h3: ({ children }) => <h4 dir="auto" className="mt-4 mb-1 text-sm font-bold">{children}</h4>,
    h4: ({ children }) => <h4 dir="auto" className="mt-3 mb-1 text-sm font-semibold">{children}</h4>,
    // a link into the app is a link; anything outside is shown, not followed —
    // a row of data could tell the model to put figures in an address
    a: ({ children, href }) =>
      href && href.startsWith("/") && !href.startsWith("//") ? (
        <a href={href} className="text-brand underline underline-offset-2">{children}</a>
      ) : (
        <span>{children}{href ? <span className="text-muted text-xs ltr"> ({href})</span> : null}</span>
      ),
    // nothing in an answer loads from anywhere
    img: () => null,
    blockquote: ({ children }) => <blockquote dir="auto" className="my-2.5 border-s-2 border-[var(--border-strong)] ps-3 text-muted">{children}</blockquote>,
    hr: () => <hr className="my-4 border-[var(--border)]" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-lg border">
        <table className="w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    th: ({ children }) => <th>{children}</th>,
    td: ({ children, node }) => {
      const text = textOf(node as HastNode | undefined);
      return <td className={isNumeric(text) ? "num ltr" : ""}>{children}</td>;
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
