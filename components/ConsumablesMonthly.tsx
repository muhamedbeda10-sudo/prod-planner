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

function LimitDetail({ l, uom, workers, prevComplete }: { l: LimitMonthRow; uom: string; workers: MonthlyReportView["workers"]; prevComplete: boolean }) {
  return (
    <tr className="border-t">
      <td className="p-1.5 ps-6 text-xs">
        <div className="font-semibold">{l.departmentsLabel}</div>
        <div className="text-muted">
          {fmt(l.qty)} {uom} {PERIOD_LABEL[l.period]}{l.basis === "person" ? " per person" : ""}
          {l.toDate ? <> — counted over <b>{l.toDate}</b></> : null}
        </div>
      </td>
      <td className="p-1.5 text-end tabnum text-xs">{fmt(l.allowance)}</td>
      <td className="p-1.5 text-end tabnum text-xs">
        <b>{fmt(l.used)}</b>
        {l.basis === "person" && <div className="text-muted">top worker · all {fmt(l.usedAll)}</div>}
      </td>
      <td className="p-1.5"><UseBar used={l.used} allowance={l.allowance} status={l.status} /></td>
      <td className="p-1.5"><StatusPill s={l.status} /></td>
      <td className="p-1.5 text-xs tabnum text-muted">{prevComplete ? fmt(l.prevUsed) : "—"}</td>
      <td className="p-1.5 text-xs" colSpan={2}>
        {l.basis === "person" && (l.workersOver.length
          ? <div className="text-bad-fg">{l.workersOver.map((w) => `${workers[w.workerId]?.name ?? "?"} (${workers[w.workerId]?.empId ?? ""}) ${fmt(w.used)}`).join(" · ")}</div>
          : <div className="text-muted">no worker over {fmt(l.allowance)}</div>)}
      </td>
    </tr>
  );
}

function ItemRow({ r, open, toggle, workers, prevComplete }: { r: ItemMonthRow; open: boolean; toggle: () => void; workers: MonthlyReportView["workers"]; prevComplete: boolean }) {
  return (
    <Fragment>
      <tr className="border-t align-middle cursor-pointer hover:bg-surface-2/60" onClick={toggle} aria-expanded={open}>
        <td className="p-2">
          <div className="font-semibold">
            <span className="text-muted me-1 no-print">{r.limits.length ? (open ? "▾" : "▸") : " "}</span>
            {r.name}
            {!r.active && <span className="pill pill-muted ms-1.5">retired</span>}
          </div>
          <div className="text-xs text-muted ltr">{r.code ?? ""}{r.limits.length > 1 ? ` · ${r.limits.length} limits` : ""}</div>
        </td>
        <td className="p-2 text-end tabnum">{r.allowance === null ? <span className="text-xs text-muted">{r.limits.length ? (r.limits.every((l) => l.toDate !== null) ? "over months" : "—") : "—"}</span> : <>{fmt(r.allowance)} <span className="text-[10px] text-muted">{r.uom}</span></>}</td>
        <td className="p-2 text-end tabnum">
          <b>{fmt(r.used)}</b> <span className="text-[10px] text-muted">{r.uom}</span>
          {r.outside > 0 && <div className="text-[11px] text-muted" title="Handed out to departments none of its limits cover">{fmt(r.outside)} outside the limits</div>}
          {r.limits.filter((l) => l.toDate).map((l) => (
            <div key={l.ruleId} className="text-[11px] text-muted" title="A quarterly limit counts the quarter so far">{l.toDate}: <b className="text-foreground">{fmt(l.used)}</b> of {fmt(l.allowance)}</div>
          ))}
        </td>
        <td className="p-2"><UseBar used={r.allowance === null ? 0 : r.used - r.outside} allowance={r.allowance} status={r.status} /></td>
        <td className="p-2"><StatusPill s={r.status} /></td>
        <td className="p-2"><Change row={r} /></td>
        <td className="p-2" title={r.trend.map((t) => `${monthShort(t.month)}: ${fmt(t.used)}`).join("\n")}><Sparkline values={r.trend.map((t) => t.used)} width={90} height={24} /></td>
        <td className="p-2 text-[11px] text-muted tabnum whitespace-nowrap">{r.trend.map((t) => fmt(t.used)).join(" · ")}</td>
      </tr>
      {open && r.limits.map((l) => <LimitDetail key={l.ruleId} l={l} uom={r.uom} workers={workers} prevComplete={prevComplete} />)}
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2">Item</th>
                <th className="p-2 text-end">Monthly limit</th>
                <th className="p-2 text-end">Used · {monthShort(r.month)}</th>
                <th className="p-2">Of the limit</th>
                <th className="p-2">Status</th>
                <th className="p-2">vs {monthShort(r.prevMonth)}</th>
                <th className="p-2" colSpan={2}>{monthShort(r.trendMonths[0])} → {monthShort(r.month)}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => <ItemRow key={row.itemId} r={row} open={open.has(row.itemId)} toggle={() => toggle(row.itemId)} workers={r.workers} prevComplete={r.prevComplete} />)}
              {shown.length === 0 && <tr><td colSpan={8} className="p-4 text-sm text-muted">No item matches.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-[11px] text-muted">Items handed out to departments none of their limits cover show that part apart and it does not count against the limit.</p>
    </div>
  );
}
