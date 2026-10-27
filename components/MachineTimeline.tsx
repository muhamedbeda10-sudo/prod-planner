"use client";

import { useMemo, useState } from "react";
import { buildTimeline, type TimelineBlock } from "@/lib/domain/machineTimeline";
import { CENTER_LABEL, machineWord } from "@/lib/domain/shifts";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import { DeptLoadCurve } from "@/components/DeptLoadCurve";
import { ChartAbout } from "@/components/ChartAbout";

// 📊 The board's Timeline view: every machine a track, every queued line a
// block as long as that machine needs for it, laid on the working days ahead.
// A load figure says a machine is busy; this says WHEN each job comes off it
// and which promise it will miss — the block turns red past the day its stage
// was due, with the date marked on the track.

const ZOOMS = [5, 10, 20] as const;

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function Block({ b, horizon, word }: { b: TimelineBlock; horizon: number; word: string }) {
  // an unpriced line has no length — draw it as a sliver so it is not invisible
  const width = Math.max(b.unpriced ? 0.6 : 1.2, ((b.endDay - b.startDay) / horizon) * 100);
  const left = (b.startDay / horizon) * 100;
  if (left >= 100) return null;
  // a solid block carries white text; the pale waiting ones keep the page's own
  const tone = b.late
    ? "bg-bad-fg border-bad-fg text-white"
    : b.running
      ? "bg-brand-fill border-brand-fill text-white"
      : "bg-brand/25 border-brand/60 text-foreground";
  const title = [
    `${b.bom} ${b.item} ×${b.pieces}`,
    b.hours !== null ? `${b.hours} h on this ${word}` : "no standard time",
    b.running ? "running now" : `starts after ${b.startDay} working day(s)`,
    `done after ${b.endDay}`,
    b.dueDay !== null ? `owed on day ${b.dueDay + 1} of the picture${b.late ? " — LATE" : ""}` : "no date",
  ].join(" · ");
  return (
    <span
      className={`fx-fill absolute top-1 bottom-1 rounded-[3px] border overflow-hidden text-[10px] leading-none flex items-center px-1 ${tone}`}
      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
      title={title}
    >
      <span className="truncate font-bold">{b.running ? "▶ " : ""}{b.bom}</span>
      <span className="ms-1 shrink-0 opacity-75">{b.item}·{b.pieces}</span>
    </span>
  );
}

export function MachineTimeline({ board }: { board: MachineBoardData }) {
  const [horizon, setHorizon] = useState<number>(10);
  // two readings of the same days: what each machine runs, and whether the
  // department can carry what it has promised at all
  const [view, setView] = useState<"machines" | "load">("machines");
  const word = machineWord(board.dept);
  const t = useMemo(() => buildTimeline(board.cards, board.days ?? [], horizon), [board.cards, board.days, horizon]);
  const days = t.days.slice(0, horizon);
  if (days.length === 0) return null;

  const about = `Each block is one line on that ${word}, as long as the machine needs for it (its standard hours over the hours it has in a day, at the planner's own time per piece where there is one). They run in the queue's order, what is running now first. A block turns red when it is still running after the day its stage was owed; the thin mark on the track is that day. The work is moved with the machine cards, or with the printed sheets on the machines worklist.`;
  return (
    <section className="bg-surface border rounded-xl p-3 no-print" data-ai-title={`The ${word}s' next ${horizon} working days`} data-ai-about={about}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="inline-flex rounded-md overflow-hidden border">
          <button type="button" className={`btn btn-sm rounded-none ${view === "machines" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("machines")} title={`What each ${word} runs, and when`}>By {word}</button>
          <button type="button" className={`btn btn-sm rounded-none ${view === "load" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("load")} title="What the whole department has promised, against the hours it has">Department load</button>
        </span>
        <span className="text-sm font-bold"><ChartAbout title={`the next ${horizon} working days`} about={view === "machines" ? about : undefined} /></span>
        {view === "machines" && t.lateCount > 0 ? (
          <span className="pill pill-bad tabnum" title="Blocks that finish after the day their stage was promised">{t.lateCount} job(s) land late</span>
        ) : view === "machines" ? (
          <span className="pill pill-ok">every job makes its date</span>
        ) : null}
        {view === "machines" && t.spanDays > horizon && <span className="pill pill-warn tabnum" title="The longest queue runs past the picture">longest queue {t.spanDays} day(s)</span>}
        <span className="ms-auto inline-flex items-center gap-1 text-xs text-muted">
          show
          {ZOOMS.map((z) => (
            <button key={z} type="button" onClick={() => setHorizon(z)} className={`btn btn-sm ${z === horizon ? "btn-primary" : "btn-ghost"}`}>{z}d</button>
          ))}
        </span>
      </div>

      {view === "load" ? <DeptLoadCurve board={board} horizon={horizon} /> : (<>
      {/* the days across the top */}
      <div className="flex text-[10px] text-muted">
        <span className="w-28 shrink-0" />
        <span className="flex-1 flex">
          {days.map((d, i) => (
            <span key={d} className={`flex-1 text-center tabnum border-s ${i === 0 ? "font-bold text-foreground" : ""}`} title={d}>
              {ddmm(d)}
            </span>
          ))}
        </span>
      </div>

      <div className="space-y-1 mt-1">
        {t.rows.map((r) => (
          <div key={r.machineId} className="flex items-stretch text-xs">
            <span className="w-28 shrink-0 pe-2 truncate" title={`${r.code} · ${r.name} — ${CENTER_LABEL[r.center] ?? r.center}${r.availableH !== null ? `, ${r.availableH} h a day` : ", hours a day not set"}`}>
              <b className="ltr tabnum">{r.code}</b>
              {r.beyond > 0 && <span className="text-[10px] text-muted ms-1" title={`${r.beyond} more line(s) start past the picture`}>+{r.beyond}</span>}
            </span>
            <span className="relative flex-1 h-7 rounded-md bg-surface-2 overflow-hidden">
              {/* one cell per working day */}
              {days.map((d, i) => (
                <span key={d} className="absolute top-0 bottom-0 border-s border-border" style={{ left: `${(i / horizon) * 100}%` }} />
              ))}
              {r.blocks.map((b) => <Block key={b.key} b={b} horizon={horizon} word={word} />)}
              {/* the day each block is owed, so a miss is visible against it */}
              {r.blocks.filter((b) => b.dueDay !== null && b.dueDay < horizon).map((b) => (
                <span
                  key={`due-${b.key}`}
                  className={`absolute top-0 bottom-0 w-px ${b.late ? "bg-bad-fg" : "bg-ok-fg/60"}`}
                  style={{ left: `${(((b.dueDay as number) + 1) / horizon) * 100}%` }}
                  title={`${b.bom} ${b.item} is owed by the end of ${ddmm(days[b.dueDay as number])}`}
                />
              ))}
              {r.blocks.length === 0 && (
                <span className="absolute inset-0 grid place-items-center text-[10px] text-muted">
                  {r.availableH === null ? "no hours a day set" : "idle"}
                </span>
              )}
            </span>
            <span className="w-16 shrink-0 ps-2 text-end tabnum text-[11px] text-muted self-center" title="Working days of work queued on it">
              {r.totalDays > 0 ? `${r.totalDays} d` : "—"}
            </span>
          </div>
        ))}
      </div>

      </>)}
    </section>
  );
}
