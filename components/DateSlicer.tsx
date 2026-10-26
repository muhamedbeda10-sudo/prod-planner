"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { addDaysISO, clampISO, daysBetweenISO, slicerTicks, type SlicerPreset } from "@/lib/domain/dateSlicer";
import { formatDate } from "@/lib/domain/format";

/** Whether the timeline strip is open — one choice for the whole app,
 *  remembered in this browser. Open until someone closes it. */
const TIMELINE_KEY = "daterange:timeline";
const timelineListeners = new Set<() => void>();
function useTimelineOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (cb) => { timelineListeners.add(cb); return () => { timelineListeners.delete(cb); }; },
    () => { try { return localStorage.getItem(TIMELINE_KEY) !== "closed"; } catch { return true; } },
    () => true,
  );
  const set = (next: boolean) => {
    try { localStorage.setItem(TIMELINE_KEY, next ? "open" : "closed"); } catch {}
    timelineListeners.forEach((l) => l());
  };
  return [open, set];
}

// The one date filter of the app: quick filters on top (Today, Yesterday,
// Last 7 days…), and under them a strip of the days with a handle at each end
// of the period — drag one, or click the strip to move the nearer handle.
// "day" mode has one handle: pages that show a single day (the shift log).
// Days that hold data carry a dot, so an empty stretch is visible before it
// is picked. A pick is applied once the handle rests, not on every step.

export interface DateSlicerProps {
  mode: "range" | "day";
  /** The selection; null = every day (only with `allLabel`). */
  from: string | null;
  to: string | null;
  /** The strip's ends. */
  min: string;
  max: string;
  presets: SlicerPreset[];
  /** Offer an "All" chip that clears the dates. */
  allLabel?: string;
  /** Days that hold data — a dot each. */
  marks?: readonly string[];
  onChange: (from: string | null, to: string | null) => void;
  /** What the strip is filtering, when it is not obvious (e.g. "Due"). */
  label?: string;
  /** The page's own controls, sharing the strip's row instead of one of
   *  their own: at its start (the line switch) and at its end (the views,
   *  Print …). */
  start?: React.ReactNode;
  end?: React.ReactNode;
}

const COMMIT_MS = 350;

export function DateSlicer({ mode, from, to, min, max, presets, allLabel, marks, onChange, label, start, end }: DateSlicerProps) {
  const span = Math.max(1, daysBetweenISO(min, max));
  const [timelineOpen, setTimelineOpen] = useTimelineOpen();
  const isAll = from === null || to === null;
  const propA = isAll ? min : clampISO(from!, min, max);
  const propB = isAll ? max : clampISO(mode === "day" ? from! : to!, min, max);

  // the handles move locally while dragged; the page follows once they rest
  const [sel, setSel] = useState<[string, string]>([propA, propB]);
  const [prev, setPrev] = useState(`${propA}|${propB}|${isAll}`);
  const [dirty, setDirty] = useState(false);
  if (prev !== `${propA}|${propB}|${isAll}`) {
    setPrev(`${propA}|${propB}|${isAll}`);
    setSel([propA, propB]);
    setDirty(false);
  }
  const change = useRef(onChange);
  useEffect(() => { change.current = onChange; });
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => { setDirty(false); change.current(sel[0], sel[1]); }, COMMIT_MS);
    return () => clearTimeout(t);
  }, [sel, dirty]);

  const move = (next: [string, string]) => { setSel(next); setDirty(true); };
  const idx = (iso: string) => daysBetweenISO(min, iso);
  const at = (i: number) => addDaysISO(min, Math.round(Math.max(0, Math.min(span, i))));
  const pct = (iso: string) => (idx(iso) / span) * 100;
  const [a, b] = sel;
  const showAll = isAll && !dirty;

  // click on the strip: the nearer handle jumps there (range), or the one does (day)
  const track = useRef<HTMLDivElement>(null);
  const clickTrack = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const d = at(((clientX - r.left) / r.width) * span);
    if (mode === "day") return move([d, d]);
    if (Math.abs(idx(d) - idx(a)) <= Math.abs(idx(d) - idx(b))) move([d > b ? b : d, d > b ? d : b]);
    else move([d < a ? d : a, d < a ? a : d]);
  };
  // ‹ › step the whole selection by its own length (one day in day mode)
  const len = daysBetweenISO(a, b) + 1;
  const step = (dir: -1 | 1) => {
    const n = mode === "day" ? 1 : len;
    const na = addDaysISO(a, dir * n), nb = addDaysISO(b, dir * n);
    if (nb > max || na < min) return;
    onChange(na, nb);
  };
  const activePreset = showAll ? null : presets.find((p) => p.from === a && p.to === b)?.key ?? null;
  const ticks = slicerTicks(min, max);
  const markSet = marks ? [...new Set(marks)].filter((m) => m >= min && m <= max) : [];

  const rangeText = showAll ? allLabel : a === b ? formatDate(a) : `${formatDate(a)} → ${formatDate(b)} · ${daysBetweenISO(a, b) + 1} days`;

  return (
    <div className="no-print date-range min-w-0">
      {/* one row: what it filters, the quick picks, then the period itself
          with the steps either side and the timeline's own switch */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        {start}
        {label && <span className="filter-label shrink-0">{label}</span>}
        <div className="order-2 sm:order-none w-full sm:w-auto sm:flex-1 flex gap-1 overflow-x-auto min-w-0 [scrollbar-width:none]" role="group" aria-label="Quick dates">
          {presets.map((p) => (
            <button key={p.key} type="button" onClick={() => onChange(p.from, p.to)} aria-pressed={activePreset === p.key} className="chip-toggle shrink-0 whitespace-nowrap">
              {p.label}
            </button>
          ))}
          {allLabel && (
            <button type="button" onClick={() => onChange(null, null)} aria-pressed={showAll} className="chip-toggle shrink-0 whitespace-nowrap">
              {allLabel}
            </button>
          )}
        </div>
        <span className="order-1 sm:order-none ms-auto shrink-0 inline-flex items-center gap-1">
          <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={showAll || a <= min} aria-label="Earlier" title={mode === "day" ? "Previous day" : `The ${len} days before`}>
            <ChevronLeft size={15} />
          </button>
          <span className="text-[13px] font-semibold tabnum whitespace-nowrap" aria-live="polite">{rangeText}</span>
          <button type="button" className="icon-btn" onClick={() => step(1)} disabled={showAll || b >= max} aria-label="Later" title={mode === "day" ? "Next day" : `The ${len} days after`}>
            <ChevronRight size={15} />
          </button>
          <button
            type="button" className="icon-btn" onClick={() => setTimelineOpen(!timelineOpen)} aria-expanded={timelineOpen}
            aria-label={timelineOpen ? "Hide the timeline" : "Show the timeline"} title={timelineOpen ? "Hide the timeline" : "Show the timeline — drag a handle to pick any period"}
          >
            <CalendarRange size={15} />
          </button>
        </span>
        {end && <span className="order-1 sm:order-none shrink-0 max-w-full inline-flex flex-wrap items-center gap-2">{end}</span>}
      </div>

      {timelineOpen && (
        // the timeline: one strip and its labels, 40px in all
        <div className="mt-1.5 px-1">
          <div className="relative h-7 slicer" ref={track} onClick={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") clickTrack(e.clientX); }}>
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-border" />
            {markSet.map((m) => (
              <span key={m} className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-1 rounded-full bg-muted/60" style={{ left: `${pct(m)}%` }} />
            ))}
            {!showAll && (
              <div className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-brand" style={{ left: `${pct(a)}%`, width: `${Math.max(0.6, pct(b) - pct(a))}%` }} />
            )}
            {mode === "range" ? (
              <>
                <input
                  type="range" min={0} max={span} value={idx(a)} aria-label="From" className="slicer-range"
                  onChange={(e) => { const d = at(Number(e.target.value)); move([d > b ? b : d, b]); }}
                />
                <input
                  type="range" min={0} max={span} value={idx(b)} aria-label="To" className="slicer-range"
                  onChange={(e) => { const d = at(Number(e.target.value)); move([a, d < a ? a : d]); }}
                />
              </>
            ) : (
              <input
                type="range" min={0} max={span} value={idx(a)} aria-label="Day" className="slicer-range slicer-single"
                onChange={(e) => { const d = at(Number(e.target.value)); move([d, d]); }}
              />
            )}
          </div>
          <div className="relative h-3 text-[11px] leading-3 text-muted" aria-hidden>
            {ticks.map((t) => (
              <span key={t.iso} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${t.pos * 100}%` }}>{t.label}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
