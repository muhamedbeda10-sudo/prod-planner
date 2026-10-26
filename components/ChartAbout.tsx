"use client";

import { useRef } from "react";
import { Info, Sparkles } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { useAiPanel } from "@/components/AiPanel";
import { explainQuestion } from "@/lib/domain/aiExplain";
import { pageName } from "@/lib/aiTarget";

/**
 * A chart's title that explains the chart: rest the pointer on it (or on its
 * ⓘ), focus it or tap it, and a small card says what the chart shows and how
 * it is counted — the note the screen keeps off the card — with Ask AI for
 * what its numbers say now. Only the title where there is nothing to say.
 * Put it inside the card's heading; the card is the nearest <section> (or
 * element with data-ai-title) around it.
 */
export function ChartAbout({ title, about, rows }: { title: string; about?: string; rows?: Record<string, string | number>[] }) {
  const ai = useAiPanel();
  const trigger = useRef<HTMLButtonElement>(null);
  if (!about) return <>{title}</>;

  const ask = (close: () => void) => {
    const card = trigger.current?.closest("section, [data-ai-title]");
    const text = card instanceof HTMLElement ? card.innerText : undefined;
    close();
    ai?.ask(explainQuestion({ kind: "chart", title, about, rows, text }, pageName()), { explain: true });
  };

  return (
    <Tooltip
      interactive
      side="bottom"
      label={`About: ${title}`}
      content={(close) => (
        <span className="flex flex-col gap-2 text-start">
          <span className="flex items-center gap-2 font-bold">
            <Info size={15} className="shrink-0 text-brand-ink" aria-hidden />
            {title}
          </span>
          <span className="leading-relaxed text-muted">{about}</span>
          {ai?.canAsk && (
            <button type="button" className="btn btn-sm btn-primary self-start" onClick={() => ask(close)}>
              <Sparkles size={13} aria-hidden /> Ask AI about these numbers
            </button>
          )}
        </span>
      )}
    >
      <button ref={trigger} type="button" className="inline-flex cursor-help items-center gap-1.5 text-start [letter-spacing:inherit] [text-transform:inherit] hover:text-brand-ink">
        {title}
        <Info size={14} className="shrink-0 text-muted" aria-hidden />
      </button>
    </Tooltip>
  );
}
