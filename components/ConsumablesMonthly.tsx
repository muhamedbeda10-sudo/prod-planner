"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Legend, Sparkline, StatTile, TipBox, fmt, pct } from "@/components/charts/kit";
import {
  MONTH_STATUS_LABEL, monthLong, monthShort,
  type ItemMonthRow, type LimitMonthRow, type MonthStatus,
} from "@/lib/domain/consumableMonthly";
import { PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import { TableEmpty, TableFrame, Th } from "@/components/DataTable";
import type { MonthlyReportView } from "@/lib/server/consumableMonthly";

// The CONSUMABLES monthly review: each catalogue item's month against its
// monthly limit (a limit of several months counted over its months so far),
// graded over / close / under / not issued — the month before beside it, the
// last six months as a line, and each item opening onto its limits by
// department.

const STATUS_COLOR: Record<MonthStatus, string> = {
  over: "var(--bad-fg)",
  near: "var(--warn-fg)",
  under: "var(--ok-fg)",
  unused: "var(--viz-other)",
  nolimit: "var(--border-strong)",
};
const STATUS_PILL: Record<MonthStatus, string> = { over: "pill-bad", near: "pill-warn", under: "pill-ok", unused: "pill-muted", nolimit: "pill-muted" };
const STATUS_ORDER: MonthStatus[] = ["over", "near", "under", "unused", "nolimit"];

function StatusPill({ s }: { s: MonthStatus }) {
  return <span className={`pill ${STATUS_PILL[s]} whitespace-nowrap`}>{s === "over" ? "⚠ " : ""}{MONTH_STATUS_LABEL[s]}</span>;
}

/** Use against the allowance: the bar scaled to whichever is larger, the
 *  allowance marked, the part past the mark is the over. */
function UseBar({ used, allowance, status }: { used: number; allowance: number | null; status: MonthStatus }) {
  if (allowance === null || allowance <= 0) return <span className="text-xs text-muted">—</span>;
  const top = Math.max(used, allowance);
  return (
    <div className="min-w-[7rem]">
      <div className="relative h-2 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(used / top) * 100}%`, background: STATUS_COLOR[status] }} />
        <div className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-[var(--foreground)]" style={{ left: `calc(${(allowance / top) * 100}% - 1px)` }} />
      </div>
      <div className="text-[11px] tabnum text-muted mt-0.5">{pct(used / allowance)}</div>
    </div>
  );
}

function Change({ row }: { row: ItemMonthRow }) {
  if (row.change === null) return <span className="text-xs text-muted">{row.used > 0 ? "none before" : "—"}</span>;
  const p = Math.round(row.change * 100);
  return (
    <span className="text-xs tabnum whitespace-nowrap" title={`Last month: ${fmt(row.prevUsed)}`}>
      <b>{p > 0 ? "▲" : p < 0 ? "▼" : "•"} {Math.abs(p)}%</b> <span className="text-muted">({fmt(row.prevUsed)})</span>
    </span>
  );
}

const BASIS_WORD: Record<LimitMonthRow["basis"], string> = { pool: "shared", each: "each department", person: "per worker" };

/** How a counted limit reads: "60 PC a month · each department", or for a
 *  per-worker one "2 PC per worker × 12 workers a month". */
function limitWords(l: LimitMonthRow, uom: string): string {
  if (l.perWorker) {
    const n = l.perWorker.workers;
    return `${fmt(l.perWorker.qty)} ${uom} per worker × ${n > 0 ? `${n} worker${n === 1 ? "" : "s"}` : "1 (no one on the list)"} ${PERIOD_LABEL[l.period]}`;
  }
  return `${fmt(l.qty)} ${uom} ${PERIOD_LABEL[l.period]} · ${BASIS_WORD[l.basis]}`;
}

function LimitDetail({ l, uom, prevComplete }: { l: LimitMonthRow; uom: string; prevComplete: boolean }) {
  return (
    <tr className="bg-surface-2/50">
      <td className="p-1.5 ps-7 text-xs">
        <div className="font-semibold">{l.departmentsLabel}</div>
        <div className="text-muted">
          {limitWords(l, uom)}
          {l.toDate ? <> — counted over <b>{l.toDate}</b></> : null}
        </div>
      </td>
      <td className="p-1.5 text-right tabnum text-xs">{fmt(l.allowance)}</td>
      <td className="p-1.5 text-right tabnum text-xs"><b>{fmt(l.used)}</b></td>
      <td className="p-1.5 text-right tabnum text-xs"><b style={{ color: l.left < 0 ? "var(--bad-fg)" : undefined }}>{fmt(l.left)}</b></td>
      <td className="p-1.5"><UseBar used={l.used} allowance={l.allowance} status={l.status} /></td>
      <td className="p-1.5"><StatusPill s={l.status} /></td>
      <td className="p-1.5 text-xs tabnum text-muted">{prevComplete ? fmt(l.prevUsed) : "—"}</td>
      <td className="p-1.5" colSpan={2} />
    </tr>
  );
}

function ItemRow({ r, open, toggle, prevComplete }: { r: ItemMonthRow; open: boolean; toggle: () => void; prevComplete: boolean }) {
  const multi = r.limits.filter((l) => l.toDate);
  const left = r.allowance === null ? null : Math.round((r.allowance - r.covered) * 1000) / 1000;
  return (
    <Fragment>
      <tr className={`border-t align-middle ${r.limits.length ? "cursor-pointer" : ""}`} onClick={r.limits.length ? toggle : undefined} aria-expanded={r.limits.length ? open : undefined}>
        <td className="p-2">
          <div className="font-semibold">
            <span className="text-muted me-1 no-print inline-block w-3">{r.limits.length ? (open ? "▾" : "▸") : ""}</span>
            {r.name}
            {!r.active && <span className="pill pill-muted ms-1.5">retired</span>}
          </div>
          <div className="text-xs text-muted ltr ps-4">{[r.code, r.limits.length > 1 ? `${r.limits.length} limits` : null].filter(Boolean).join(" · ")}</div>
        </td>
        <td className="p-2 text-right tabnum whitespace-nowrap">
          {r.allowance === null
            ? <span className="text-xs text-muted" title={multi.length ? "Only limits of several months — see each one" : undefined}>{multi.length ? "over months" : "—"}</span>
            : <>{fmt(r.allowance)} <span className="text-[10px] text-muted">{r.uom}</span></>}
        </td>
        <td className="p-2 text-right tabnum whitespace-nowrap">
          <b>{fmt(r.used)}</b> <span className="text-[10px] text-muted">{r.uom}</span>
          {r.outside > 0 && <div className="text-[11px] text-muted" title="Handed out to departments none of its limits cover — not held against a limit">{fmt(r.outside)} outside the limits</div>}
          {multi.length > 0 && r.allowance !== null && <div className="text-[11px] text-muted">monthly limits: {fmt(r.covered)}</div>}
        </td>
        <td className="p-2 text-right tabnum whitespace-nowrap">
          {left === null ? <span className="text-xs text-muted">—</span> : <b style={{ color: left < 0 ? "var(--bad-fg)" : undefined }}>{fmt(left)}</b>}
        </td>
        <td className="p-2"><UseBar used={r.allowance === null ? 0 : r.covered} allowance={r.allowance} status={r.status} /></td>
        <td className="p-2"><StatusPill s={r.status} /></td>
        <td className="p-2"><Change row={r} /></td>
        <td className="p-2" title={r.trend.map((t) => `${monthShort(t.month)}: ${fmt(t.used)}`).join("\n")}><Sparkline values={r.trend.map((t) => t.used)} width={90} height={24} /></td>
        <td className="p-2 text-[11px] text-muted tabnum whitespace-nowrap">{r.trend.map((t) => fmt(t.used)).join(" · ")}</td>
      </tr>
      {open && r.limits.map((l) => <LimitDetail key={l.ruleId} l={l} uom={r.uom} prevComplete={prevComplete} />)}
    </Fragment>
  );
}

export function ConsumablesMonthly({ report: r, monthHref }: { report: MonthlyReportView; /** The page's link with "month=" last — the month is appended. */ monthHref: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState<MonthStatus | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const idx = r.months.indexOf(r.month);
  const older = r.months[idx + 1];
  const newer = idx > 0 ? r.months[idx - 1] : undefined;
  // back to this section after the page reloads on the new month
  const hrefOf = (m: string) => `${monthHref}${m}#monthly`;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return r.rows.filter((row) => (filter === "all" || row.status === filter) && (!needle || [row.name, row.code ?? ""].some((v) => v.toLowerCase().includes(needle))));
  }, [r.rows, filter, q]);
  const allOpen = shown.length > 0 && shown.every((row) => open.has(row.itemId));

  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const handChange = r.prevComplete && r.handOuts.prev > 0 ? Math.round(((r.handOuts.month - r.handOuts.prev) / r.handOuts.prev) * 100) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 no-print">
        {older ? <Link href={hrefOf(older)} className="btn btn-sm" aria-label="Previous month">◀</Link> : <span className="btn btn-sm opacity-40">◀</span>}
        <select value={r.month} onChange={(e) => router.push(hrefOf(e.target.value))} aria-label="Month" className="px-2 py-1.5 text-sm font-bold">
          {r.months.map((m) => <option key={m} value={m}>{monthLong(m)}</option>)}
        </select>
        {newer ? <Link href={hrefOf(newer)} className="btn btn-sm" aria-label="Next month">▶</Link> : <span className="btn btn-sm opacity-40">▶</span>}
        <span className="text-xs text-muted">Each item against its monthly limit; a limit of several months is counted over its months so far · the limits as they stand today</span>
      </div>

      <div className="flex flex-wrap gap-3">
        {STATUS_ORDER.map((s) => (
          <button key={s} type="button" onClick={() => setFilter(filter === s ? "all" : s)} className={`text-start flex-1 min-w-[9rem] rounded-xl ${filter === s ? "ring-2 ring-[var(--foreground)]" : ""}`} aria-pressed={filter === s}>
            <StatTile label={MONTH_STATUS_LABEL[s]} value={fmt(r.counts[s])} sub={<span style={{ color: STATUS_COLOR[s] }}>● {s === "nolimit" ? "handed out, no limit set" : "items"}</span>} />
          </button>
        ))}
        <StatTile label="Catalogue hand-outs" value={fmt(r.handOuts.month)} sub={!r.prevComplete ? `the log does not cover ${monthShort(r.prevMonth)} — nothing to compare with` : handChange === null ? `none in ${monthShort(r.prevMonth)}` : `${handChange > 0 ? "▲" : handChange < 0 ? "▼" : "•"} ${Math.abs(handChange)}% vs ${monthShort(r.prevMonth)} (${fmt(r.handOuts.prev)})`} />
      </div>

      <section className="bg-surface border rounded-xl p-4">
        <h2 className="font-bold">The last six months</h2>
        <p className="text-xs text-muted mb-2">How many items ended each month over, close to, under their limit, or not issued</p>
        <div className="viz" style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={r.countsByMonth.map((c) => ({ ...c, label: monthShort(c.month) }))} margin={{ top: 8, right: 8, left: -4, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as (typeof r.countsByMonth)[number] & { label: string } | undefined) : undefined;
                return p ? <TipBox title={monthLong(p.month)} rows={(["over", "near", "under", "unused"] as const).map((s) => ({ label: MONTH_STATUS_LABEL[s], value: fmt(p[s]), color: STATUS_COLOR[s] }))} /> : null;
              }} />
              {(["under", "near", "over"] as const).map((s, i) => (
                <Bar key={s} dataKey={s} stackId="s" fill={STATUS_COLOR[s]} stroke="var(--surface)" strokeWidth={1} maxBarSize={36} radius={i === 2 ? [4, 4, 0, 0] : undefined} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2"><Legend items={(["over", "near", "under"] as const).map((s) => ({ label: MONTH_STATUS_LABEL[s], color: STATUS_COLOR[s] }))} /></div>
      </section>

      <div className="flex flex-wrap items-center gap-2 no-print">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item, code…" aria-label="Search" className="px-2 py-1.5 text-sm font-semibold w-full sm:w-64" />
        {filter !== "all" && <button type="button" className="pill pill-muted cursor-pointer" onClick={() => setFilter("all")}>{MONTH_STATUS_LABEL[filter]} ✕</button>}
        <span className="text-sm text-muted">{shown.length} of {r.rows.length} items</span>
        <button type="button" className="btn btn-sm ms-auto" onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((row) => row.itemId)))}>{allOpen ? "Collapse all" : "Open all"}</button>
      </div>

      <section className="bg-surface border rounded-xl overflow-hidden">
        {shown.length === 0 ? (
          <TableEmpty
            title={r.rows.length === 0 ? `No catalogue item has a limit or a hand-out in ${monthLong(r.month)}` : "No item matches"}
            filtered={r.rows.length > 0}
            action={r.rows.length > 0 ? <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setQ(""); setFilter("all"); }}>Show every item</button> : undefined}
          />
        ) : (
          <TableFrame>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left">
                  <Th label="Item" hint="Click an item for its limits, department by department" />
                  <Th label="Monthly limit" num className="text-right" hint="Its monthly limits added up — every department's own share. A limit of several months is counted on its own line, over its months so far." />
                  <Th label={`Used · ${monthShort(r.month)}`} num className="text-right" hint="Everything handed out of the item in the month" />
                  <Th label="Left" num className="text-right" hint="Monthly limit − what its departments drew; negative when over" />
                  <Th label="Of the limit" />
                  <Th label="Status" hint="An item takes the worst of its limits" />
                  <Th label={`vs ${monthShort(r.prevMonth)}`} />
                  <Th label={`${monthShort(r.trendMonths[0])} → ${monthShort(r.month)}`} colSpan={2} />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => <ItemRow key={row.itemId} r={row} open={open.has(row.itemId)} toggle={() => toggle(row.itemId)} prevComplete={r.prevComplete} />)}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>
      <p className="text-[11px] text-muted">
        Each-department and per-worker limits are counted department by department, the way the record form and the alarms count them — a per-worker number is times the department&apos;s workers on the list today.
        Hand-outs to departments none of an item&apos;s limits cover show apart and count against no limit.
      </p>
    </div>
  );
}
