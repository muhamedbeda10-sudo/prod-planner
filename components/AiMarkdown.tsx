"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AiChart } from "@/components/AiChart";

// An AI answer as it reads: Markdown (tables, lists, bold) in the app's own
// type, every paragraph and cell finding its own direction (Arabic reads
// right to left, an MO number left to right), and a ```chart block drawn as
// a chart. No raw HTML is rendered — only Markdown.

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

const textOf = (n: HastNode): string => (n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join(""));

function components(streaming: boolean): Components {
  return {
    p: ({ children }) => <p dir="auto" className="my-2 leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul dir="auto" className="my-2 ps-5 list-disc space-y-1">{children}</ul>,
    ol: ({ children }) => <ol dir="auto" className="my-2 ps-5 list-decimal space-y-1">{children}</ol>,
    li: ({ children }) => <li dir="auto">{children}</li>,
    h1: ({ children }) => <h3 dir="auto" className="mt-4 mb-1.5 text-base font-extrabold">{children}</h3>,
    h2: ({ children }) => <h3 dir="auto" className="mt-4 mb-1.5 text-base font-extrabold">{children}</h3>,
    h3: ({ children }) => <h4 dir="auto" className="mt-3 mb-1 text-sm font-extrabold">{children}</h4>,
    h4: ({ children }) => <h4 dir="auto" className="mt-3 mb-1 text-sm font-bold">{children}</h4>,
    a: ({ children, href }) => <a href={href} className="text-brand underline" target={href?.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{children}</a>,
    blockquote: ({ children }) => <blockquote dir="auto" className="my-2 border-s-4 ps-3 text-muted">{children}</blockquote>,
    hr: () => <hr className="my-3 border-[var(--border)]" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface-2 border-b">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y">{children}</tbody>,
    th: ({ children, style }) => <th dir="auto" style={style} className="px-2.5 py-1.5 text-xs font-bold text-muted whitespace-nowrap text-start">{children}</th>,
    td: ({ children, style }) => <td dir="auto" style={style} className="px-2.5 py-1.5 tabnum">{children}</td>,
    code: ({ children, className }) => <code className={`${className ?? ""} px-1 py-0.5 rounded bg-surface-2 text-[0.9em] ltr`}>{children}</code>,
    pre: ({ node, children }) => {
      const code = (node as HastNode | undefined)?.children?.[0];
      const cls = code?.tagName === "code" ? code.properties?.className : undefined;
      if (Array.isArray(cls) && cls.includes("language-chart") && code) return <AiChart source={textOf(code)} streaming={streaming} />;
      return <pre className="my-2 p-2.5 rounded-lg bg-surface-2 overflow-x-auto text-xs ltr">{children}</pre>;
    },
  };
}

const LIVE = components(true);
const DONE = components(false);

export function AiMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="ai-md text-[15px] min-w-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? LIVE : DONE}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
