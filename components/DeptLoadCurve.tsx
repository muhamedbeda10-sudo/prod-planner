"use client";

import { useMemo } from "react";
import { buildDeptLoad, type LoadInput } from "@/lib/domain/deptLoad";
import { deptLabel } from "@/lib/domain/constants";
import { machineWord } from "@/lib/domain/shifts";
import type { MachineBoardData } from "@/lib/server/machineBoard";

// 📈 The department's load over the days ahead.
//
// One bar a day: the standard hours PROMISED by the end of that day, against
// the hours the department has in it (the dashed mark). A bar over the mark is
// a day that cannot be worked as it stands. The headline carries the reading
// that actually decides a week — the RUNNING totals, because work can be done
// early: the department is only really short once everything owed so far has
// passed everything workable so far.
//
// Colours are the app's chart tokens; the pair was checked for colour-blind
// separation against both surfaces before it was used.

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export function DeptLoadCurve({ board, horizon }: { board: MachineBoardData; horizon: number }) {
  const days = (board.days ?? []).slice(0, horizon);

  const load = useMemo(() => {
    // everything this stage still owes: what sits on the machines and what has
    // not been placed yet — together they are the department's whole open book
    const lines: LoadInput[] = [
      ...board.cards.flatMap((c) => c.queue.map((q) => ({ hours: q.hours, dueISO: q.dueISO ?? q.deliveryISO ?? null }))),
      ...board.unassigned.map((u) => ({ hours: u.hours, dueISO: u.dueISO ?? u.deliveryISO ?? null })),
    ];
    // today counts the downtime the shift log recorded; the days after it can
    // only go on the machines' hours a day
    // a retired machine stays on the board while work sits on it, but its
    // hours a day are no capacity any more (the board's own total leaves it out)
    const live = board.cards.filter((c) => c.machine.active);
    const today = live.reduce((s, c) => s + (c.availableH ?? 0), 0);
    const plain = live.reduce((s, c) => s + (c.machine.hoursPerDay ?? 0), 0);
    const capacity = days.map((_, i) => (i === 0 ? today : plain));
    return buildDeptLoad(lines, days, capacity);
  }, [board.cards, board.unassigned, days]);

  if (days.length === 0) return null;
  const noHours = board.cards.filter((c) => c.machine.hoursPerDay === null).length;
  const scale = Math.max(load.peakH, 1) * 1.15;
  const word = machineWord(board.dept, true);

  // how the curve is read, and what it leaves out — the assistant's to tell
  const about = [
    `A bar is every open line whose stage falls due that day, on a ${machineWord(board.dept)} or not yet placed; the dashed line is the hours the ${word} have that day.`,
    load.shortFromISO ? `${deptLabel(board.dept)} goes short on ${ddmm(load.shortFromISO)}: by then ${load.days.find((d) => d.dateISO === load.shortFromISO)!.shortH} h more is promised than its ${word} can work.` : `These ${days.length} working days clear: ${load.totalOwedH} h promised against ${load.totalCapH} h the ${word} can work, ${load.spareH} h to spare.`,
    load.undatedH > 0 && `${load.undatedH} h of open work carries no date and is not on the curve.`,
    load.beyondH > 0 && `${load.beyondH} h is owed past these days.`,
    load.unpricedLines > 0 && `${load.unpricedLines} line(s) have no standard time, so their hours are missing (Tools → Times per Machine).`,
    noHours > 0 && `${noHours} ${machineWord(board.dept, noHours > 1)} have no hours a day set, so they count as nothing.`,
  ].filter(Boolean).join(" ");

  return (
    <div data-ai-title={`${deptLabel(board.dept)} — department load`} data-ai-about={about}>
      {/* the reading that decides the week */}
      <p className="text-sm mb-2">
        {load.shortFromISO ? (
          <>
            <span className="font-extrabold text-bad-fg">⚠ {deptLabel(board.dept)} goes short on {ddmm(load.shortFromISO)}</span>
          </>
        ) : (
          <>
            <span className="font-extrabold text-ok-fg">✓ These {days.length} working days clear</span>
          </>
        )}
      </p>

      {/* the plot: one column a day */}
      <div className="relative" style={{ height: 168 }}>
        <div className="absolute inset-0 flex gap-[2px]">
          {load.days.map((d) => {
            const barH = (d.owedH / scale) * 100;
            const capH = (d.capacityH / scale) * 100;
            const title = [
              ddmm(d.dateISO),
              `${d.owedH} h promised by the end of it`,
              `${d.capacityH} h workable that day`,
              `running total: ${d.cumOwedH} h promised of ${d.cumCapH} h workable`,
              d.shortH > 0 ? `SHORT by ${d.shortH} h` : "still ahead",
            ].join(" · ");
            return (
              <div key={d.dateISO} className="relative flex-1 h-full" title={title}>
                {/* the hours that day can work — the mark a bar is read against */}
                <span
                  className="absolute inset-x-0 border-t-2 border-dashed border-muted/70"
                  style={{ bottom: `${capH}%` }}
                />
                {d.owedH > 0 && (
                  <span
                    className="fx-fill-up absolute inset-x-0 bottom-0 rounded-t-[4px]"
                    style={{
                      height: `${Math.max(barH, 1.5)}%`,
                      background: d.over ? "var(--viz-7)" : "var(--viz-2)",
                    }}
                  />
                )}
                {d.over && (
                  <span className="absolute inset-x-0 text-[10px] font-bold text-center tabnum" style={{ bottom: `calc(${Math.max(barH, 1.5)}% + 2px)`, color: "var(--viz-7)" }}>
                    {d.owedH}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* the days, under their own column */}
      <div className="flex gap-[2px] mt-1">
        {load.days.map((d, i) => (
          <span key={d.dateISO} className={`flex-1 text-center text-[10px] tabnum ${i === 0 ? "font-bold" : "text-muted"}`}>
            {ddmm(d.dateISO)}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm" style={{ background: "var(--viz-2)" }} /> hours promised by that day
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm" style={{ background: "var(--viz-7)" }} /> more than the day can work
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-4 border-t-2 border-dashed border-muted/70" /> hours the {word} have that day
        </span>
      </div>

    </div>
  );
}
