"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useHrefWith } from "@/components/useSetParam";
import { CheckCircle2, Info } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/Badge";
import { FilterSelect, SearchBox } from "@/components/FilterControls";
import { Modal } from "@/components/Modal";
import { TableFrame, Th } from "@/components/DataTable";
import { EmptyState } from "@/components/primitives";
import { TONE_CELL, fmt, signed } from "@/components/charts/kit";
import { formatDate, formatDayShort } from "@/lib/domain/format";
import { ITEM_NAME, ITEMS } from "@/lib/domain/constants";
import { LV_FAMILIES, LV_FAMILY_LABEL } from "@/lib/domain/lv";
import { LV_FLOOR_DEPTS, LV_FLOOR_DEPT_LABEL } from "@/lib/domain/lvKpis";
import { WORK_CENTRES, WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import {
  FAMILY_PARAM, LOAD_STATE_LABEL, PLANNING_SCOPES, PLANNING_SCOPE_LABEL, RISK_LABEL, familyOfParam, isPlanningDetail, planningUrl, showsLv, showsTr,
  type AtRiskRow, type LoadMatrixRow, type LoadState, type PlanningDetail, type PlanningFilters, type RiskStatus,
} from "@/lib/domain/planningDashboard";

// The Planning dashboard's own parts, shared by its plant figures and its two
// line sections: the one bar of the page (the scope first, each line's
// filters, how current the page is and its decisions at the end), the strip
// that says what the figures rest on, the load against the capacity day by
// day, the lines at risk, and the popup with the rows behind a figure. Every
// choice is written to the address (lib/domain/planningDashboard.ts), so a
// link, a reload and the back button keep it.

/** The figure whose rows are open (?detail=), read and written in the browser:
 *  the rows are on the page already, so opening or closing one asks the server
 *  nothing (Next keeps useSearchParams in step with history.pushState). A link
 *  still names it, so a new tab or a shared address opens it too. */
export function useDetail() {
  const raw = useSearchParams().get("detail") ?? "";
  const hrefWith = useHrefWith();
  const urlWith = (key: PlanningDetail | null) => hrefWith({ detail: key });
  return {
    detail: isPlanningDetail(raw) ? raw : null,
    /** A link's props that open the rows in place (a modified click still opens a new tab). */
    open: (key: PlanningDetail) => ({
      href: urlWith(key),
      onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        window.history.pushState(null, "", urlWith(key));
      },
    }),
    close: () => window.history.pushState(null, "", urlWith(null)),
  };
}

/** Go to the page with `patch` over its filters — a popup open is closed by any other choice. */
function useGo(f: PlanningFilters) {
  const router = useRouter();
  return (patch: Partial<PlanningFilters>) => router.push(planningUrl(f, { detail: null, ...patch }), { scroll: false });
}

// ---------------------------------------------------------------- the bar

export function PlanningBar({ f, planNos, activePlan, asOf, actions }: {
  f: PlanningFilters;
  /** The transformers' weekly plans, newest first, and the one on screen. */
  planNos: readonly number[];
  activePlan: number | null;
  /** The factory's clock when the page was read. */
  asOf: string;
  actions?: ReactNode;
}) {
  const go = useGo(f);
  return (
    <div className="no-print toolbar toolbar-row">
      <nav className="seg" aria-label="Line shown">
        {PLANNING_SCOPES.map((s) => (
          <Link key={s} href={planningUrl(f, { scope: s, detail: null })} scroll={false} aria-current={f.scope === s ? "page" : undefined} className={f.scope === s ? "on" : ""}>
            {PLANNING_SCOPE_LABEL[s]}
          </Link>
        ))}
      </nav>
      {showsTr(f) && (
        <>
          {planNos.length > 1 && (
            <FilterSelect label="TR plan" value={activePlan && activePlan !== planNos[0] ? String(activePlan) : ""} allLabel={`newest (${planNos[0]})`}
              onChange={(v) => go({ plan: v ? Number(v) : null })} options={planNos.slice(1).map((n) => ({ value: String(n), label: String(n) }))}
              title="The transformers' weekly plan — an earlier one shows its lines as they stand now" />
          )}
          <FilterSelect label="TR component" value={f.item ?? ""} onChange={(v) => go({ item: v || null })} options={ITEMS.map((i) => ({ value: i, label: ITEM_NAME[i] }))} />
          <FilterSelect label="TR centre" value={f.centre ?? ""} onChange={(v) => go({ centre: (v || null) as PlanningFilters["centre"] })} options={WORK_CENTRES.map((c) => ({ value: c, label: WORK_CENTRE_LABEL[c] }))} />
          {/* a new address (back, a link) starts the box afresh from it */}
          <PlanSearch key={f.q} f={f} />
        </>
      )}
      {showsLv(f) && (
        <>
          <FilterSelect label="LV family" value={f.family === null ? "" : FAMILY_PARAM[f.family]} onChange={(v) => go({ family: familyOfParam(v) })}
            options={LV_FAMILIES.map((x) => ({ value: FAMILY_PARAM[x], label: LV_FAMILY_LABEL[x] }))} />
          <FilterSelect label="LV department" value={f.lvDept ?? ""} onChange={(v) => go({ lvDept: (v || null) as PlanningFilters["lvDept"] })} options={LV_FLOOR_DEPTS.map((d) => ({ value: d, label: LV_FLOOR_DEPT_LABEL[d] }))} />
        </>
      )}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted tabnum whitespace-nowrap" title="The figures are read when the page opens — reload for the latest">
          As of {asOf}{activePlan ? ` · TR weekly plan ${activePlan}` : ""}
        </span>
        {actions}
      </span>
    </div>
  );
}

/** The plan's MO / BOM / SOI search: written to the address on Enter, cleared at once. */
function PlanSearch({ f }: { f: PlanningFilters }) {
  const go = useGo(f);
  const [q, setQ] = useState(f.q);
  return (
    <form role="search" className="max-sm:basis-full max-sm:w-full" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() }); }}>
      <SearchBox value={q} onChange={(v) => { setQ(v); if (!v && f.q) go({ q: "" }); }} placeholder="TR plan: MO / BOM / SOI… (Enter)" wide />
    </form>
  );
}

// ---------------------------------------------------------------- the load against the capacity

const LOAD_CELL: Record<LoadState, string> = { short: TONE_CELL.bad, tight: TONE_CELL.warn, ok: "", unmeasured: "text-muted" };

/** Each centre a row, each coming working day a column: the std-hours due that
 *  day over what the centre can work a day, in the state of its running totals. */
export function LoadMatrix({ rows }: { rows: readonly LoadMatrixRow[] }) {
  const { open } = useDetail();
  if (rows.length === 0) return <EmptyState compact icon={Info} title="No load to show" hint="The weekly plan has nothing left to make, or nothing is priced yet." />;
  const days = rows[0].cells.map((c) => c.dayISO);
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Cell states">
        {(["short", "tight", "ok", "unmeasured"] as const).map((s) => (
          <li key={s} className="inline-flex items-center gap-1.5"><span className={`inline-block w-3 h-3 rounded-sm border ${LOAD_CELL[s]}`} aria-hidden />{LOAD_STATE_LABEL[s]}</li>
        ))}
        <li className="explain text-muted">due h / can work h a day · state of the running totals</li>
      </ul>
      <TableFrame className="!max-h-[22rem]">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th label="Centre" />
              {days.map((d) => <Th key={d} label={formatDayShort(d)} num className="text-right" />)}
              <Th label="Short at end" num className="text-right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.centre}>
                <td className="px-2 whitespace-nowrap">
                  <a {...open(`tr-load:${r.centre}`)} className="font-semibold hover:underline">{WORK_CENTRE_LABEL[r.centre]}</a>
                </td>
                {r.cells.map((c) => {
                  const said = `${WORK_CENTRE_LABEL[r.centre]} ${formatDate(c.dayISO)}: ${fmt(c.dueH, 1)} h due${c.capacityH === null ? ", capacity not measured" : `, can work ${fmt(c.capacityH, 1)} h a day; owed so far ${fmt(c.owedCum, 1)} h of ${fmt(c.canCum ?? 0, 1)} h`} — ${LOAD_STATE_LABEL[c.state]}`;
                  return (
                    <td key={c.dayISO} className={`px-1.5 text-right tabnum whitespace-nowrap ${LOAD_CELL[c.state]}`} title={said} aria-label={said}>
                      {c.state === "short" && <span aria-hidden>▲ </span>}
                      {c.dueH > 0 ? fmt(c.dueH, 1) : "·"}
                      {/* the muted ink falls under 4.5:1 on a status fill — a filled cell keeps its own ink */}
                      <span className={`font-normal ${c.state === "short" || c.state === "tight" ? "" : "text-muted"}`}>/{c.capacityH === null ? "—" : fmt(c.capacityH, 0)}</span>
                    </td>
                  );
                })}
                <td className={`px-2 text-right tabnum font-bold ${r.shortH > 0 ? "text-bad-fg" : ""}`}>{!r.measured ? "—" : r.shortH > 0 ? `${fmt(r.shortH, 1)} h` : "0"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}

// ---------------------------------------------------------------- at risk

const RISK_TONE: Record<RiskStatus, BadgeTone> = { late: "danger", urgent: "danger", "at-risk": "warning", short: "warning", "on-hold": "neutral" };

export function RiskBadge({ status }: { status: RiskStatus }) {
  return <Badge tone={RISK_TONE[status]}>{RISK_LABEL[status]}</Badge>;
}

/** The plan's lines that are late or will be, each with the stage holding it,
 *  why, and where to act on it. */
/** Rows the table draws — the worst first; the rest are a filter (or the assistant) away. */
const AT_RISK_SHOWN = 100;

export function AtRiskTable({ rows: all, empty }: { rows: readonly AtRiskRow[]; empty: { title: string; hint: string } }) {
  if (all.length === 0) return <EmptyState compact icon={CheckCircle2} title={empty.title} hint={empty.hint} />;
  const rows = all.slice(0, AT_RISK_SHOWN);
  return (
    <>
    {all.length > rows.length && <p className="text-xs text-muted mb-2">The worst {rows.length} of {all.length} — narrow them with the filters, or ask the assistant for all of them.</p>}
    <TableFrame className="!max-h-[30rem]">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th label="Line" /><Th label="Status" /><Th label="MO" /><Th label="SOI" /><Th label="BOM" /><Th label="Item" /><Th label="Stage due" />
            <Th label="Required" num className="text-right" /><Th label="Done" num className="text-right" /><Th label="Left" num className="text-right" />
            <Th label="Held at" /><Th label="Std-h left" num className="text-right" /><Th label="Why" /><Th label="Open" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.line}-${r.mo}-${r.bom}-${r.item}-${r.stageDueISO}-${i}`}>
              <td className="px-2"><span className="pill pill-muted">{r.line}</span></td>
              <td className="px-2"><RiskBadge status={r.status} /></td>
              <td className="px-2 whitespace-nowrap max-w-[12rem] truncate" title={r.mo}>{r.mo || "—"}</td>
              <td className="px-2 whitespace-nowrap">{r.soi ?? "—"}</td>
              <td className="px-2 whitespace-nowrap font-semibold">{r.bom}</td>
              <td className="px-2">{r.item}</td>
              <td className="px-2 tabnum whitespace-nowrap" title={r.stageDueISO ? undefined : "The panels' plan carries no delivery date"}>{r.stageDueISO ? formatDate(r.stageDueISO) : "—"}</td>
              <td className="px-2 text-right tabnum">{fmt(r.required)}</td>
              <td className="px-2 text-right tabnum">{fmt(r.done)}</td>
              <td className="px-2 text-right tabnum font-bold">{fmt(r.remaining)}</td>
              <td className="px-2 whitespace-nowrap">{r.stage ?? "—"}</td>
              <td className="px-2 text-right tabnum whitespace-nowrap" title={r.hoursLeft === null ? "No standard hours for the order's class" : undefined}>{r.hoursLeft === null ? "not priced" : fmt(r.hoursLeft, 1)}</td>
              <td className="px-2 min-w-[14rem]">{r.reason}</td>
              <td className="px-2 whitespace-nowrap">
                <Link href={r.href} className="text-brand-ink font-semibold hover:underline">Trace</Link>
                {r.worklist && <> · <Link href={r.worklist} className="text-brand-ink font-semibold hover:underline">Worklist</Link></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
    </>
  );
}

// ---------------------------------------------------------------- the rows behind a figure

export interface DetailColumn { label: string; num?: boolean }

/** Columns as labels, a number column as [label, true]. */
export const cols = (...labels: (string | [string, true])[]): DetailColumn[] => labels.map((l) => (typeof l === "string" ? { label: l } : { label: l[0], num: true }));

const noSubscribe = () => () => {};

/** The popup a figure opens (?detail=): its rows, and the total they add up
 *  to — the figure itself. Closing it goes back to the page as it was. */
export function DetailModal({ title, sub, columns, rows, total, empty = "Nothing behind this figure." }: {
  title: string;
  sub?: ReactNode;
  columns: readonly DetailColumn[];
  rows: readonly ReactNode[][];
  total?: readonly ReactNode[];
  empty?: string;
}) {
  const { close } = useDetail();
  // a popup lives in the browser: an address opened with ?detail= renders the page first, then the popup
  const client = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!client) return null;
  return (
    <Modal title={title} sub={sub} onClose={close} width="max-w-5xl" focusField={false}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <TableFrame className="!max-h-[60vh]">
          <table className="w-full text-sm">
            <thead><tr>{columns.map((c) => <Th key={c.label} label={c.label} num={c.num} className={c.num ? "text-right" : ""} />)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((cell, j) => <td key={j} className={`px-2 ${columns[j]?.num ? "text-right tabnum" : ""}`}>{cell}</td>)}</tr>
              ))}
            </tbody>
            {total && (
              <tfoot>
                <tr>{total.map((cell, j) => <td key={j} className={`px-2 ${columns[j]?.num ? "text-right tabnum" : ""}`}>{cell}</td>)}</tr>
              </tfoot>
            )}
          </table>
        </TableFrame>
      )}
    </Modal>
  );
}

/** One department's month in people, as the people popups list it. */
export interface PeopleRow { key: string; line?: string; label: string; requiredH: number; doneH: number; leftH: number; neededNow: number | null; present: number | null; gap: number | null }

/** The people behind a "People to add" figure — each department's hours and
 *  who it needs from today against who comes, the figure as the total. */
export function PeopleDetail({ title, sub, rows, toAdd }: { title: string; sub: ReactNode; rows: readonly PeopleRow[]; toAdd: number | null }) {
  const withLine = rows.some((r) => r.line);
  const dash = (v: number | null, f: (n: number) => string = (n) => fmt(n, 1)) => (v === null ? "—" : f(v));
  return (
    <DetailModal title={title} sub={sub}
      columns={cols(...(withLine ? ["Line"] : []), "Department", ["Plan h", true], ["Done h", true], ["Left h", true], ["Needed from today", true], ["Present", true], ["Gap", true])}
      rows={rows.map((r) => [...(withLine ? [r.line ?? ""] : []), r.label, fmt(r.requiredH, 1), fmt(r.doneH, 1), fmt(r.leftH, 1), dash(r.neededNow), dash(r.present), dash(r.gap, signed)])}
      total={[...(withLine ? [""] : []), "Short by half a person or more", "", "", "", "", "", toAdd === null ? "—" : `${toAdd} to add`]} />
  );
}
