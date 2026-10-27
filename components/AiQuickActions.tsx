"use client";

import { AlertTriangle, BarChart3, Bell, CalendarClock, FileBarChart, FileSpreadsheet, FlaskConical, ScanLine, Sunrise, TrendingDown } from "lucide-react";
import type { AiQuickAction, AiQuickId } from "@/lib/domain/aiQuickActions";
import { toneAt } from "@/lib/domain/tones";

// The assistant's tiles: what it can do, each in a colour of its own, coming
// in one after the other. A click opens the tile's form (or asks straight
// away) — the chat decides (components/AiChat).

const ICON: Record<AiQuickId, typeof Bell> = {
  report: FileBarChart,
  chart: BarChart3,
  excel: FileSpreadsheet,
  whatif: FlaskConical,
  deadline: CalendarClock,
  briefing: Sunrise,
  problems: AlertTriangle,
  why: TrendingDown,
  scan: ScanLine,
  automation: Bell,
};

export function AiQuickGrid({ actions, onPick, disabled = false, compact = false }: { actions: readonly AiQuickAction[]; onPick: (a: AiQuickAction) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <div className={`ai-caps ${compact ? "ai-caps-compact" : ""}`}>
      {actions.map((a, i) => {
        const Icon = ICON[a.id];
        return (
          <button key={a.id} type="button" className={`ai-cap ${toneAt(i)}`} onClick={() => onPick(a)} disabled={disabled} title={a.hint}>
            <span className="tone-tile ai-cap-icon" aria-hidden><Icon size={17} /></span>
            <span className="ai-cap-text">
              <span className="ai-cap-label">{a.label}</span>
              <span className="ai-cap-hint">{a.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
