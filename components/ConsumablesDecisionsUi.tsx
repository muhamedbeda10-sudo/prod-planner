"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { FilterSelect } from "@/components/FilterControls";
import { TableEmpty, TableFrame, Th } from "@/components/DataTable";
import { Badge, type BadgeTone } from "@/components/Badge";
import { useSetParam } from "@/components/useSetParam";
import { fmt } from "@/components/charts/kit";
import { formatDate } from "@/lib/domain/format";
import { PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import {
  LINK_FILTERS, LINK_LABEL, ROW_ISSUES, ROW_STATUSES, ROW_STATUS_LABEL, hasFilters, headcountText, limitBasisText,
  type DecisionFilters, type DecisionOptions, type DecisionRow, type RowLimit, type RowStatus,
} from "@/lib/domain/consumablesDecisions";
import { LOG_IDS_MAX } from "@/lib/domain/consumables";
import type { ConsumablesDecisionsView } from "@/lib/server/consumables";

// The CONSUMABLES dashboard's filters (in the date bar, kept in the address)
// and its detail table: a row per item × department, against the limit that
// reads worst at the period's end — each opening onto its limits and its
// hand-outs, with the way into the log.

export function ConsumablesFilters({ filters: f, options }: { filters: DecisionFilters; options: DecisionOptions }) {
  const set = useSetParam();
  return (
    <>
      <FilterSelect label="Department" value={f.department ?? ""} onChange={(v) => set("dept", v)} options={options.departments} />
      <FilterSelect label="Item" value={f.item ?? ""} onChange={(v) => set("item", v)} options={options.items} />
      <FilterSelect label="Catalogue" value={f.link ?? ""} onChange={(v) => set("link", v)} options={LINK_FILTERS.map((x) => ({ value: x, label: LINK_LABEL[x] }))} />
      <FilterSelect label="Limit" value={f.status ?? ""} onChange={(v) => set("status", v)} options={ROW_STATUSES.map((x) => ({ value: x, label: ROW_STATUS_LABEL[x] }))}
        title="Where each item × department stands against its limit at the period's end" />
    </>
  );
}

const STATUS_TONE: Record<RowStatus, BadgeTone> = { over: "danger", near: "warning", within: "success", none: "neutral" };
const STATUS_ICON: Record<RowStatus, string> = { over: "⚠", near: "◐", within: "✓", none: "—" };

export function StatusBadge({ s }: { s: RowStatus }) {
  return <Badge tone={STATUS_TONE[s]} className="whitespace-nowrap">{STATUS_ICON[s]} {ROW_STATUS_LABEL[s]}</Badge>;
}

const left = (l: RowLimit) => (l.left < 0 ? 0 : l.left);
const overBy = (l: RowLimit) => (l.left < 0 ? -l.left : 0);

function LimitLine({ l, uom }: { l: RowLimit; uom: string | null }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <StatusBadge s={l.status} />
      <span className="font-semibold">{limitBasisText(l, uom)}</span>
      <span className="text-muted">{PERIOD_LABEL[l.period]} · {l.windowLabel}{l.toDate ? " to date" : ""}</span>
      <span className="tabnum"><b>{fmt(l.used)}</b> of {fmt(l.limit)}</span>
      {l.headcount && <span className="text-xs text-muted">× {headcountText(l.headcount)}</span>}
    </li>
  );
}

function RowDetail({ r, logHref, cols }: { r: DecisionRow; logHref: string; cols: number }) {
  return (
    <tr className="bg-surface-2/50">
      <td colSpan={cols} className="p-3 text-sm">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h4 className="font-bold mb-1">Limits that count it</h4>
            {r.limits.length === 0
              ? <p className="text-muted">{r.itemId === null ? "Typed by hand — not in the catalogue, so no limit counts it." : "None of the item's limits covers this department."}</p>
              : <ul className="space-y-1">{r.limits.map((l) => <LimitLine key={l.ruleId} l={l} uom={r.uom} />)}</ul>}
            {r.suggestion && (
              <p className="mt-2">
                <span className="text-muted">To review:</span> may be <b>{r.suggestion.name}</b>{r.suggestion.code && <span className="ltr text-muted"> {r.suggestion.code}</span>}
                {" "}({r.suggestion.match === "same" ? "same name" : "similar name"}) — link it on the log; nothing changes by itself.
              </p>
            )}
          </div>
          <div className="min-w-0">
            <h4 className="font-bold mb-1">Its hand-outs <span className="font-normal text-muted">({fmt(r.handOuts)}{r.handOuts > ROW_ISSUES ? `, the latest ${ROW_ISSUES}` : ""})</span></h4>
            <ul className="divide-y max-h-64 overflow-auto">
              {r.issues.map((i) => (
                <li key={i.id} className="py-1 flex flex-wrap gap-x-2">
                  <span className="tabnum text-muted">{formatDate(i.dayISO)}</span>
                  <b className="tabnum">{fmt(i.qty)}{r.uom ? ` ${r.uom}` : ""}</b>
                  <span>→ {i.recipient.kind === "worker" ? `${i.recipient.empId} ${i.recipient.name}` : i.recipient.label}</span>
                  {i.overLimit && <span className="text-bad-fg font-semibold">⚠ recorded over: “{i.overLimitReason ?? "no reason"}”</span>}
                  <span className="text-muted">· {i.recordedBy}</span>
                </li>
              ))}
            </ul>
            <Link className="text-brand-ink font-semibold hover:underline text-xs" href={logHref}>Open {r.issueIds.length > LOG_IDS_MAX ? `the latest ${LOG_IDS_MAX}` : "these"} on the log →</Link>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function ConsumablesDetailTable({ d, periodLabel }: { d: ConsumablesDecisionsView; periodLabel: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const pathname = usePathname();
  const params = useSearchParams();
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // the row's own hand-outs on the log, by their ids
  const logHref = (r: DecisionRow) => `/consumables?${new URLSearchParams({ from: d.fromISO, to: d.toISO, ids: r.issueIds.slice(0, LOG_IDS_MAX).join(",") })}`;
  const clear = (() => {
    const p = new URLSearchParams(params.toString());
    for (const k of ["dept", "item", "link", "status"]) p.delete(k);
    return `${pathname}${p.size ? `?${p}` : ""}#detail`;
  })();
  const COLS = 13;

  return (
    <section id="detail" className="scroll-mt-24 bg-surface border rounded-xl overflow-hidden min-w-0"
      data-ai-title={`Consumables by item and department — ${periodLabel}`}
      data-ai-about="A row per item and department: the quantity in the item's own unit, and the limit that reads worst at the period's end — its basis (shared, each department, or per worker times the headcount), its window counted up to the period's last day, used, left and over. Recorded over: hand-outs flagged when saved, with the latest reason. Typed items have no limit; a catalogue item is suggested for review, never applied.">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b">
        <h2 className="font-bold">By item and department</h2>
        <span className="text-sm text-muted tabnum">{fmt(d.rows.length)} row{d.rows.length === 1 ? "" : "s"} · {fmt(d.kpis.handOuts)} hand-outs · {periodLabel} · limits at {formatDate(d.toISO)}{d.endsToday ? " (now)" : ""}</span>
        {hasFilters(d.filters) && <Link className="ms-auto text-brand-ink text-sm font-semibold hover:underline" href={clear}>Clear the filters</Link>}
      </div>
      {d.rows.length === 0 ? (
        <TableEmpty
          title={d.quality.total === 0 ? `Nothing handed out ${periodLabel}` : "No row matches the filters"}
          hint={d.quality.total === 0 ? "Pick a longer period on the date bar." : undefined}
          filtered={d.quality.total > 0}
          action={d.quality.total > 0 ? <Link className="btn btn-sm btn-secondary" href={clear}>Clear the filters</Link> : undefined}
        />
      ) : (
        <TableFrame className="max-h-[640px]">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th label="Item" hint="Click a row for its limits and its hand-outs" />
                <Th label="UOM" />
                <Th label="Department" />
                <Th label="Qty" num hint="Handed out in the period, in the item's own unit" />
                <Th label="Limit basis" hint="Shared by its departments, each department its own number, or per worker × the headcount" />
                <Th label="Limit" num hint="The number for the window" />
                <Th label="Used" num full="Used in the limit's window" hint="Everything the limit counts in its window, up to the period's last day" />
                <Th label="Left" num />
                <Th label="Over" num />
                <Th label="Status" hint="At the period's end. No limit is never within the limit." />
                <Th label="Recorded over" hint="Hand-outs flagged over a limit when they were saved, with the latest reason — apart from the standing recomputed here" />
                <Th label="Catalogue" />
                <Th label="Last hand-out" />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => {
                const isOpen = open.has(r.key);
                const l = r.limit;
                return (
                  <Fragment key={r.key}>
                    <tr className="border-t align-middle cursor-pointer hover:bg-surface-2" onClick={() => toggle(r.key)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(r.key); } }}
                      tabIndex={0} aria-expanded={isOpen}>
                      <td className="p-2 min-w-[12rem]">
                        <div className="font-semibold"><span className="text-muted me-1 no-print inline-block w-3" aria-hidden>{isOpen ? "▾" : "▸"}</span><bdi>{r.item}</bdi></div>
                        {r.code && <div className="text-xs text-muted ltr ps-4">{r.code}</div>}
                      </td>
                      <td className="p-2 text-xs">{r.uom ?? <span className="text-muted">—</span>}</td>
                      <td className="p-2 whitespace-nowrap"><bdi>{r.departmentLabel}</bdi></td>
                      <td className="p-2 text-right tabnum whitespace-nowrap"><b>{fmt(r.qty)}</b><div className="text-[11px] text-muted">{fmt(r.handOuts)} hand-out{r.handOuts === 1 ? "" : "s"}</div></td>
                      <td className="p-2 text-xs min-w-[10rem]">{l ? limitBasisText(l, r.uom) : <span className="text-muted">—</span>}{r.limits.length > 1 && <div className="text-muted">+{r.limits.length - 1} more limit{r.limits.length > 2 ? "s" : ""}</div>}</td>
                      <td className="p-2 text-right tabnum whitespace-nowrap">{l ? <>{fmt(l.limit)}<div className="text-[11px] text-muted">{PERIOD_LABEL[l.period]}</div></> : "—"}</td>
                      <td className="p-2 text-right tabnum whitespace-nowrap">{l ? <><b>{fmt(l.used)}</b><div className="text-[11px] text-muted">{l.windowLabel}{l.toDate ? " to date" : ""}</div></> : "—"}</td>
                      <td className="p-2 text-right tabnum">{l ? fmt(left(l)) : "—"}</td>
                      <td className="p-2 text-right tabnum">{l ? (overBy(l) > 0 ? <b className="text-bad-fg">+{fmt(overBy(l))}</b> : "0") : "—"}</td>
                      <td className="p-2"><StatusBadge s={r.status} /></td>
                      <td className="p-2 text-xs min-w-[9rem]">
                        {r.recordedOver > 0 ? <><b className="text-bad-fg">⚠ {fmt(r.recordedOver)}</b> <bdi className="text-muted">“{r.lastReason ?? "no reason"}”</bdi></> : <span className="text-muted">none flagged</span>}
                      </td>
                      <td className="p-2 text-xs min-w-[9rem]">
                        {r.itemId !== null ? <Badge tone="success">✓ Linked</Badge> : (
                          <>
                            <Badge tone="warning">⚠ Not linked</Badge>
                            {r.suggestion && <div className="text-muted mt-0.5">may be <bdi className="text-foreground">{r.suggestion.name}</bdi> — review</div>}
                          </>
                        )}
                      </td>
                      <td className="p-2 whitespace-nowrap tabnum text-xs">{formatDate(r.lastDayISO)}</td>
                    </tr>
                    {isOpen && <RowDetail r={r} logHref={logHref(r)} cols={COLS} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </TableFrame>
      )}
    </section>
  );
}
