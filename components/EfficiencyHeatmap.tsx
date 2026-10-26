"use client";

import Link from "next/link";
import { TONE_CELL, fmt, pct, pctOrDash } from "@/components/charts/kit";
import { TableFrame } from "@/components/DataTable";
import { formatDate, formatDayShort } from "@/lib/domain/format";
import { efficiencyBand } from "@/lib/domain/kpis";
import type { HeatRow } from "@/lib/domain/floorKpis";
import { EFFICIENCY_OK, EFFICIENCY_WARN, UNUSUAL_EFFICIENCY } from "@/lib/domain/productivity";

// Each centre's (or department's) efficiency day by day — the Production
// dashboard's heatmap, one for the transformers' work centres and one for
// the panels' departments: green at the standard, amber short of it, red
// well short; the last column is the whole period. The rows are whatever
// the period read; `labels` names them. A day nobody booked is grey, never
// red or zero; a figure far above the standard is shown as it is, with ⚠ —
// its records are worth a look. `hrefOf` links a cell to its day's record.

const BAND_WORD = {
  ok: `at the standard (${pct(EFFICIENCY_OK)} and up)`,
  warn: `short (${pct(EFFICIENCY_WARN)}–${pct(EFFICIENCY_OK)})`,
  bad: `well short (under ${pct(EFFICIENCY_WARN)})`,
} as const;

const unusual = (e: number | null) => e !== null && e > UNUSUAL_EFFICIENCY;

export function EfficiencyHeatmap<C extends string>({ grid, dates, labels, rowHead = "Centre", hrefOf, unpriced }: {
  grid: readonly HeatRow<C>[]; dates: readonly string[]; labels: Record<C, string>; rowHead?: string;
  hrefOf?: (row: C, dateISO: string) => string;
  /** Rows whose output carries no standard hours: "n/p", not priced — never 0%. */
  unpriced?: ReadonlySet<C>;
}) {
  return (
    <>
      <TableFrame className="!max-h-none">
        <table className="border-separate w-full" style={{ borderSpacing: 3 }}>
          <thead>
            <tr>
              <th scope="col" className="px-2 text-left text-xs font-bold text-muted sticky left-0 bg-surface z-[1]">{rowHead}</th>
              {dates.map((d) => (
                <th key={d} scope="col" className="px-1 text-[11px] font-bold text-muted text-center leading-tight whitespace-nowrap">
                  <span className="block font-normal">{formatDate(d).split(" ")[0]}</span>{formatDayShort(d)}
                </th>
              ))}
              <th scope="col" className="px-2 text-xs font-bold text-muted text-center whitespace-nowrap">Period</th>
            </tr>
          </thead>
          <tbody>
            {grid.map((r) => {
              const tb = efficiencyBand(r.total);
              return (
                <tr key={r.centre}>
                  <th scope="row" className="px-2 text-left text-sm font-semibold whitespace-nowrap sticky left-0 bg-surface z-[1]">{labels[r.centre]}</th>
                  {r.cells.map((c) => {
                    const b = efficiencyBand(c.efficiency);
                    const np = unpriced?.has(r.centre) && c.workedH > 0;
                    const text = np ? "n/p" : c.efficiency === null ? "·" : `${unusual(c.efficiency) ? "⚠ " : ""}${pct(c.efficiency)}`;
                    return (
                      <td key={c.dateISO}
                        className={`min-w-[3.25rem] px-1.5 py-1.5 rounded text-center text-[13px] tabnum font-semibold whitespace-nowrap ${b ? TONE_CELL[b] : "bg-surface-2 text-muted font-normal"}`}
                        title={np ? `${labels[r.centre]} · ${formatDate(c.dateISO)}: ${fmt(c.workedH, 1)} h booked — the output carries no standard hours, so its efficiency is not known` : c.efficiency === null ? `${labels[r.centre]} · ${formatDate(c.dateISO)}: no hours booked` : `${labels[r.centre]} · ${formatDate(c.dateISO)}: ${pct(c.efficiency)} — ${fmt(c.earnedH, 1)} std-h of ${fmt(c.workedH, 1)} h booked${unusual(c.efficiency) ? " — unusually high: worth checking the day's records" : ""}`}>
                        {hrefOf && c.efficiency !== null ? <Link href={hrefOf(r.centre, c.dateISO)} className="block hover:underline">{text}</Link> : text}
                      </td>
                    );
                  })}
                  <td className={`min-w-[4rem] px-2 py-1.5 rounded text-center text-[13px] tabnum font-extrabold ${tb ? TONE_CELL[tb] : "text-muted"}`}
                    title={`${labels[r.centre]}: ${pctOrDash(r.total)} over ${r.days} recorded day${r.days === 1 ? "" : "s"}`}>
                    {pctOrDash(r.total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableFrame>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted" aria-label="Colour key">
        {(["ok", "warn", "bad"] as const).map((b) => (
          <li key={b} className="inline-flex items-center gap-1.5"><span className={`inline-block w-3.5 h-3.5 rounded-sm ${TONE_CELL[b]}`} aria-hidden />{BAND_WORD[b]}</li>
        ))}
        <li className="inline-flex items-center gap-1.5"><span className="inline-block w-3.5 h-3.5 rounded-sm bg-surface-2" aria-hidden />no hours booked</li>
        <li>⚠ over {pct(UNUSUAL_EFFICIENCY)} — shown as it is, worth checking</li>
        {unpriced && unpriced.size > 0 && <li>n/p — output not priced (Admin → Standard Times)</li>}
      </ul>
    </>
  );
}
