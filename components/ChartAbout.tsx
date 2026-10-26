"use client";

import { useRef } from "react";
import { Info, Sparkles } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { useAskAiEntry } from "@/components/ContextMenu";
import { cardTarget } from "@/lib/aiTarget";

/**
 * A chart's title that explains the chart: rest the pointer on it (or on its
 * ⓘ), focus it or tap it, and a small card says what the chart shows and how
 * it is counted — the note the screen keeps off the card — with Ask AI for
 * what its numbers say now (the same question a right-click on the card
 * asks). Only the title where there is nothing to say. Put it inside the
 * heading of a card that says what it is (ChartCard, or data-ai-title).
 */
export function ChartAbout({ title, about }: { title: string; about?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const askAi = useAskAiEntry(() => cardTarget(trigger.current));
  if (!about) return <>{title}</>;

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
          {askAi && (
            <button type="button" className="btn btn-sm btn-primary self-start" onClick={() => { close(); askAi.onSelect?.(); }}>
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
