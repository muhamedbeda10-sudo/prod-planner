"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { deptLabel } from "@/lib/domain/constants";
import { parseISODate, toDisplayDate } from "@/lib/domain/dates";
import { quickHours, weekTotals, type QuickWeek } from "@/lib/domain/quickHours";
import { SHIFT_DEPTS, type ShiftDept } from "@/lib/domain/shifts";
import type { QuickWeekData } from "@/lib/server/shifts";
import { saveQuickHours } from "@/app/shifts/actions";

// The quick entry — the whole week on one grid, every department at once:
// how many came in and how many hours each. A cell saves itself when the
// planner leaves it (Tab, Enter, an arrow, a click elsewhere), the way a
// spreadsheet does; there is no Save button to forget. Heads alone are
// enough — the hours default to the short shift — and the day's man-hours
// show beside the cell as they are typed. That figure is what the rates and
// the calibration read; the per-worker roster below stays for the days a
// supervisor wants names.

type Cell = { people: string; hoursEach: string };
type Draft = Record<string, Record<ShiftDept, Cell>>;

const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const cellOf = (c: { people: number | null; hoursEach: number | null }): Cell => ({ people: c.people ? String(c.people) : "", hoursEach: c.hoursEach ? String(c.hoursEach) : "" });
const toDraft = (week: QuickWeek): Draft => Object.fromEntries(Object.entries(week).map(([d, cells]) => [d, Object.fromEntries(SHIFT_DEPTS.map((x) => [x, cellOf(cells[x])])) as Record<ShiftDept, Cell>]));

type NavDir = "left" | "right" | "up" | "down";
function navDir(key: string): NavDir | null {
  return key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : key === "ArrowUp" ? "up" : key === "ArrowDown" || key === "Enter" ? "down" : null;
}
function moveFocus(from: HTMLElement, dir: NavDir): boolean {
  const tr = from.closest("tr");
  const table = from.closest("table");
  if (!tr || !table) return false;
  let target: HTMLElement | null | undefined;
  if (dir === "left" || dir === "right") {
    const cells = Array.from(tr.querySelectorAll<HTMLElement>("input[data-nav]:not(:disabled)"));
    target = cells[cells.indexOf(from) + (dir === "right" ? 1 : -1)];
  } else {
    const col = from.dataset.nav ?? "";
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    for (let i = rows.indexOf(tr) + (dir === "down" ? 1 : -1); i >= 0 && i < rows.length && !target; i += dir === "down" ? 1 : -1) {
      target = rows[i].querySelector<HTMLElement>(`input[data-nav="${CSS.escape(col)}"]:not(:disabled)`);
    }
  }
  if (!target) return false;
  target.focus();
  if (target instanceof HTMLInputElement) target.select();
  return true;
}

function shiftISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function QuickHours({ data, editable, today }: { data: QuickWeekData; editable: ShiftDept[]; today: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft>(() => toDraft(data.week));
  const [saved, setSaved] = useState<Draft>(() => toDraft(data.week));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<string | null>(null);

  const goWeek = (startISO: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("day", startISO);
    router.push(`${pathname}?${p}`);
  };
  const canEdit = (dept: ShiftDept) => editable.includes(dept);
  const key = (d: string, x: ShiftDept) => `${d}|${x}`;

  // live man-hours per cell from what is typed: heads × (hours typed, else the short shift)
  const hoursOf = (c: Cell): number => {
    const p = Number(c.people);
    const h = c.hoursEach === "" ? data.defaultHours : Number(c.hoursEach);
    return quickHours(Number.isFinite(p) ? p : 0, Number.isFinite(h) ? h : 0);
  };
  const liveWeek = useMemo<QuickWeek>(() => Object.fromEntries(Object.entries(draft).map(([d, cells]) => [d, Object.fromEntries(SHIFT_DEPTS.map((x) => {
    const src = data.week[d]?.[x];
    return [x, src?.source === "roster" ? src : { people: null, hoursEach: null, hours: hoursOf(cells[x]), source: "quick" as const }];
  })) as QuickWeek[string]])), [draft, data.week]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = useMemo(() => weekTotals(liveWeek), [liveWeek]);

  const set = (d: string, x: ShiftDept, patch: Partial<Cell>) => setDraft((prev) => ({ ...prev, [d]: { ...prev[d], [x]: { ...prev[d][x], ...patch } } }));

  /** Leaving a cell records it when it changed. */
  const commit = (d: string, x: ShiftDept) => {
    const cur = draft[d][x];
    const was = saved[d][x];
    if (cur.people === was.people && cur.hoursEach === was.hoursEach) return;
    const k = key(d, x);
    setBusy((b) => ({ ...b, [k]: true }));
    startTransition(async () => {
      const fd = new FormData();
      fd.set("date", d);
      fd.set("dept", x);
      fd.set("people", cur.people);
      fd.set("hoursEach", cur.hoursEach);
      const res = await saveQuickHours(fd);
      setBusy((b) => ({ ...b, [k]: false }));
      if (res.ok) {
        setSaved((s) => ({ ...s, [d]: { ...s[d], [x]: cur } }));
        setErrs((e) => { const { [k]: _drop, ...rest } = e; void _drop; return rest; });
        setFlash(`${deptLabel(x)} · ${toDisplayDate(parseISODate(d)!)} — ${res.hours ?? 0} man-hours saved.`);
        router.refresh();
      } else {
        setErrs((e) => ({ ...e, [k]: res.error ?? "Failed." }));
      }
    });
  };

  const copyFrom = (fromISO: string, toISO: string) => {
    const src = draft[fromISO];
    if (!src) return;
    // fill the editable, empty, non-roster cells and save each
    for (const x of SHIFT_DEPTS) {
      if (!canEdit(x) || data.week[toISO][x].source === "roster") continue;
      if (draft[toISO][x].people !== "") continue;
      if (src[x].people === "") continue;
      const fd = new FormData();
      fd.set("date", toISO);
      fd.set("dept", x);
      fd.set("people", src[x].people);
      fd.set("hoursEach", src[x].hoursEach);
      const cell = { ...src[x] };
      setDraft((p) => ({ ...p, [toISO]: { ...p[toISO], [x]: cell } }));
      startTransition(async () => {
        const res = await saveQuickHours(fd);
        if (res.ok) setSaved((s) => ({ ...s, [toISO]: { ...s[toISO], [x]: cell } }));
        else setErrs((e) => ({ ...e, [key(toISO, x)]: res.error ?? "Failed." }));
        router.refresh();
      });
    }
    setFlash(`Copied ${toDisplayDate(parseISODate(fromISO)!)} onto ${toDisplayDate(parseISODate(toISO)!)}.`);
  };

  const weekLabel = `${toDisplayDate(parseISODate(data.days[0].dateISO)!)} – ${toDisplayDate(parseISODate(data.days[6].dateISO)!)}`;
  const thisWeek = data.days.some((d) => d.dateISO === today);

  return (
    <section className="bg-surface border rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b">
        <h2 className="!mb-0">Hours worked · week of {weekLabel}</h2>
        <span className="text-xs text-muted">how many came in × hours each — type it and move on, every cell saves itself</span>
        <div className="ms-auto inline-flex items-center gap-1.5">
          <button type="button" className="btn btn-sm" onClick={() => goWeek(shiftISO(data.startISO, -7))} title="Previous week">‹</button>
          <button type="button" className="btn btn-sm" disabled={data.days[0].dateISO > today} onClick={() => goWeek(shiftISO(data.startISO, 7))} title="Next week">›</button>
          {!thisWeek && <button type="button" className="btn btn-sm btn-ghost" onClick={() => goWeek(today)}>This week</button>}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2 whitespace-nowrap">Day</th>
              {SHIFT_DEPTS.map((x) => (
                <th key={x} className="p-2 whitespace-nowrap" colSpan={3}>
                  {deptLabel(x)}
                  <span className="block text-[10px] font-normal opacity-80">people · h each · man-hours</span>
                </th>
              ))}
              <th className="p-2 w-8 no-print" />
            </tr>
          </thead>
          <tbody>
            {data.days.map((day, i) => {
              const cells = draft[day.dateISO];
              const dim = day.off || !!day.holiday;
              const rowEmpty = SHIFT_DEPTS.every((x) => cells[x].people === "" && data.week[day.dateISO][x].source !== "roster");
              const prev = i > 0 ? data.days[i - 1] : null;
              const prevHas = prev && SHIFT_DEPTS.some((x) => draft[prev.dateISO][x].people !== "");
              return (
                <tr key={day.dateISO} className={`border-t ${dim ? "bg-surface-2/50" : ""} ${day.dateISO === today ? "ring-1 ring-inset ring-[var(--brand,#1b7a43)]/40" : ""}`}>
                  <td className="p-2 whitespace-nowrap">
                    <span className="font-bold">{DAY_NAME[new Date(day.dateISO + "T00:00:00Z").getUTCDay()]}</span>
                    <span className="ms-2 text-xs text-muted tabnum">{toDisplayDate(parseISODate(day.dateISO)!)}</span>
                    {day.dateISO === today && <span className="ms-2 pill pill-ok">today</span>}
                    {day.off && <span className="ms-2 pill pill-muted">off</span>}
                    {day.holiday && <span className="ms-2 pill pill-muted" title={day.holiday}>holiday</span>}
                  </td>
                  {SHIFT_DEPTS.map((x) => {
                    const src = data.week[day.dateISO][x];
                    const k = key(day.dateISO, x);
                    const err = errs[k];
                    if (src.source === "roster") {
                      return (
                        <td key={x} colSpan={3} className="p-2 whitespace-nowrap">
                          <span className="font-extrabold tabnum">{src.hours}</span>
                          <span className="ms-1 text-xs text-muted">mh</span>
                          {src.people ? <span className="ms-2 text-xs text-muted tabnum">{src.people} present</span> : null}
                          <Link href={`/shifts?dept=${x}&day=${day.dateISO}#roster`} className="ms-2 pill pill-muted" title="Summed from the per-worker roster — edit it there">roster</Link>
                        </td>
                      );
                    }
                    const disabled = !canEdit(x) || day.future;
                    const c = cells[x];
                    const h = hoursOf(c);
                    const last = data.last[x];
                    return (
                      <td key={x} colSpan={3} className="p-1.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="text" inputMode="numeric" pattern="[0-9]*"
                            data-nav={`${x}-people`}
                            value={c.people}
                            placeholder={last ? String(last.people) : "0"}
                            disabled={disabled}
                            aria-label={`${deptLabel(x)} people on ${day.dateISO}`}
                            title={err ?? (last ? `Last time: ${last.people} people` : undefined)}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => set(day.dateISO, x, { people: e.target.value.replace(/\D/g, "") })}
                            onBlur={() => commit(day.dateISO, x)}
                            onKeyDown={(e) => {
                              const dir = navDir(e.key);
                              if (!dir) return;
                              e.preventDefault();
                              if (!moveFocus(e.currentTarget, dir)) e.currentTarget.blur();
                            }}
                            className={`w-14 border rounded-md px-1 py-1 text-center font-bold tabnum bg-surface placeholder:text-muted/50 disabled:opacity-40 ${err ? "border-bad-fg" : ""} ${busy[k] ? "opacity-60" : ""}`}
                          />
                          <span className="text-muted text-xs">×</span>
                          <input
                            type="text" inputMode="decimal"
                            data-nav={`${x}-hours`}
                            value={c.hoursEach}
                            placeholder={String(last?.hoursEach ?? data.defaultHours)}
                            disabled={disabled}
                            aria-label={`${deptLabel(x)} hours each on ${day.dateISO}`}
                            title={err ?? `Hours each — blank means ${data.defaultHours} h (the short shift); type 12 for a 9-hour shift with 3 overtime`}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => set(day.dateISO, x, { hoursEach: e.target.value.replace(/[^\d.]/g, "") })}
                            onBlur={() => commit(day.dateISO, x)}
                            onKeyDown={(e) => {
                              const dir = navDir(e.key);
                              if (!dir) return;
                              e.preventDefault();
                              if (!moveFocus(e.currentTarget, dir)) e.currentTarget.blur();
                            }}
                            className={`w-14 border rounded-md px-1 py-1 text-center font-bold tabnum bg-surface placeholder:text-muted/50 disabled:opacity-40 ${err ? "border-bad-fg" : ""} ${busy[k] ? "opacity-60" : ""}`}
                          />
                          <span className={`ms-1 min-w-[3.5rem] text-end tabnum ${h > 0 ? "font-extrabold" : "text-muted"}`}>{h > 0 ? h : "—"}</span>
                          <span className="text-[10px] text-muted">mh</span>
                        </span>
                        {err && <div className="text-[11px] text-bad-fg mt-0.5">{err}</div>}
                      </td>
                    );
                  })}
                  <td className="p-1 text-center no-print">
                    {prev && prevHas && rowEmpty && !day.future && (
                      <button type="button" className="btn btn-sm btn-ghost" title={`Same as ${DAY_NAME[new Date(prev.dateISO + "T00:00:00Z").getUTCDay()]}`} onClick={() => copyFrom(prev.dateISO, day.dateISO)}>↓</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t bg-surface-2/60 text-xs font-bold">
              <td className="p-2">Week</td>
              {SHIFT_DEPTS.map((x) => (
                <td key={x} colSpan={3} className="p-2 tabnum">
                  {totals[x].hours > 0 ? <>{totals[x].hours} mh <span className="font-normal text-muted">over {totals[x].days} day{totals[x].days === 1 ? "" : "s"}</span></> : <span className="font-normal text-muted">nothing yet</span>}
                </td>
              ))}
              <td className="no-print" />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-t text-xs text-muted">
        <span>Blank hours = {data.defaultHours} h each. ↓ copies the day above. Arrows and Enter move between cells.</span>
        {flash && <span className="text-ok-fg font-semibold ms-auto">{flash}</span>}
      </div>
    </section>
  );
}
