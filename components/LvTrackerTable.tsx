"use client";

import { LineSwitch } from "@/components/LineSwitch";
import { traceHref } from "@/lib/domain/links";
import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CheckCheck, ChevronRight, CornerDownRight, Pause } from "lucide-react";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { Num, Soi } from "@/components/ui";
import { RING_GRID, RingCard } from "@/components/ProgressRing";
import { TrackerScope, type TrackerFilter } from "@/components/TrackerScope";
import { useConfirm } from "@/components/DataTable";
import { AchCell, ColumnMenu, FoldButton, meterStyle, stageState, stageWords, stickAt, useAccountSet, useColumns } from "@/components/TrackerColumns";
import { recordLvGroupTotal, recordLvTotal } from "@/app/lv/actions";
import { closeDeliveredOrders, setOrderHold, setOrderStatus } from "@/app/orders/actions";
import { holdLabel } from "@/lib/domain/hold";
import { ContextMenu, useContextMenu, type MenuEntry } from "@/components/ContextMenu";
import { spreadOverGroup, spreadWords } from "@/lib/domain/groupSpread";
import { LV_STAGES, LV_FAMILIES, LV_FAMILY_LABEL, LV_STAGE_LABEL, LV_STAGE_SHORT, lvGroupMembers, lvStageOf, type LvChainStage } from "@/lib/domain/lv";
import { filterLvTracker, lvStageStats } from "@/lib/domain/trackerSummary";
import { lvBottleneck } from "@/lib/domain/trackerView";
import type { UserPrefs } from "@/lib/domain/userPrefs";
import type { LvTrackerRow } from "@/lib/server/lvTracker";

// The Plan Tracker's LV PANELS side.
//
// A panel is one thing that passes four stages in order, so its row is four
// cells — punched, bent, welded, painted — where a transformer's
// is a grid. The cells record the way the transformer tracker's do: click,
// type the NEW total, the difference lands in today's daily log; a merged
// BOM row spreads a total over its MOs in order and shows which before it
// is saved. Same ledger, same corrections, same guard. It reads the way the
// transformer sheet does, too: frozen identifiers, quiet stage states, the
// stage holding an order back outlined, and each person's own columns.

/** ⏸️ A held row wears one quiet wash end to end and a warn stripe on its first cell. */
const HOLD_TINT = "var(--hold-row)";
const HOLD_EDGE = { boxShadow: "inset 3px 0 0 var(--warn-fg)" };

/** The frozen identifiers' widths — whichever of MO, SOI and Customer are
 *  shown, then BoM (wider when MO is hidden: it then carries the marks),
 *  then Required. */
const ID_W: Record<"mo" | "soi" | "customer", number> = { mo: 11.5, soi: 6.75, customer: 7.5 };
const BOM_W = 7.5;
const BOM_W_ALONE = 14;
const REQ_W = 7;

/** Every column the reader can show or hide (Columns ▾), in the sheet's
 *  order. BoM always shows — it is what the row is. */
type ColKey = "mo" | "soi" | "customer" | "product" | "sec" | "required" | "left" | "pct" | "status";
const COLS: { key: ColKey; label: string }[] = [
  { key: "mo", label: "MO" }, { key: "soi", label: "SOI" }, { key: "customer", label: "Customer" },
  { key: "product", label: "Product" }, { key: "sec", label: "SEC Item" },
  { key: "required", label: "Required" }, { key: "left", label: "Left" }, { key: "pct", label: "%" },
  { key: "status", label: "Status" },
];
/** What a first visit shows: BoM, Required, the stages, %, Status. */
const DEFAULT_COLS: ColKey[] = ["required", "pct", "status"];
const ID_GROUP: ColKey[] = ["mo", "soi", "customer"];
const SPEC_GROUP: ColKey[] = ["product", "sec"];
const SUMMARY_GROUP: ColKey[] = ["left"];

type MenuTarget = { kind: "mo"; row: LvTrackerRow } | { kind: "group"; bom: string; members: LvTrackerRow[] };

export function LvTrackerTable({ rows, editableStages, canStatus, prefs = {}, head }: {
  rows: LvTrackerRow[];
  /** The stages this user may record — each behind its own tracker permission. */
  editableStages: LvChainStage[];
  canStatus: boolean;
  /** This account's saved view settings (columns, hidden stages). */
  prefs?: UserPrefs;
  /** The page head — inside the sheet so only the table scrolls. */
  head?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // the row's right-click menu — hold, close, trace; the next action is one more entry
  const rowMenu = useContextMenu<MenuTarget>();
  const [confirmIt, confirmDialog] = useConfirm();
  const [q, setQ] = useSavedFilter("lvtracker.q");
  const [product, setProduct] = useSavedFilter("lvtracker.product");
  const [family, setFamily] = useSavedFilter("lvtracker.family");
  const [status, setStatus] = useSavedFilter("lvtracker.status");
  const [month, setMonth] = useSavedFilter("lvtracker.month");
  const [urgent, setUrgent] = useSavedFilter("lvtracker.urgent");
  const [progress, setProgress] = useSavedFilter("lvtracker.progress");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [cellErr, setCellErr] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");

  // the sheet each person keeps on their account: its columns and stages
  const cols = useColumns("lvtracker:cols", prefs["lvtracker:cols"], DEFAULT_COLS);
  const show = cols.isOn;
  const [hiddenStages, toggleStage] = useAccountSet("lvtracker:hiddenStages", prefs["lvtracker:hiddenStages"]);
  const stages = LV_STAGES.filter((s) => !hiddenStages.has(s));
  const moOn = show("mo");
  const idLayout = (() => {
    let left = 0;
    const at: Partial<Record<"mo" | "soi" | "customer" | "bom", React.CSSProperties>> = {};
    for (const k of ["mo", "soi", "customer"] as const) {
      if (!show(k)) continue;
      at[k] = stickAt(left, ID_W[k]);
      left += ID_W[k];
    }
    const bomW = moOn ? BOM_W : BOM_W_ALONE;
    at.bom = stickAt(left, bomW);
    left += bomW;
    return { at, req: stickAt(left, REQ_W) };
  })();
  const tableCols = 1 + COLS.filter((c) => show(c.key)).length + stages.length;

  // the products of the picked plan only — a meter box type is no panel's
  const products = useMemo(
    () => [...new Set(rows.filter((r) => !family || r.family === (family === "PNL" ? "" : family)).map((r) => r.product ?? ""))].filter(Boolean).sort(),
    [rows, family]
  );
  // "September 2026" → a sortable key, newest month first in the picker
  const monthKey = (label: string) => {
    const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(label);
    const idx = m ? ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(m[1].toLowerCase()) : -1;
    return m && idx >= 0 ? Number(m[2]) * 12 + idx : -1;
  };
  const months = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) for (const m of r.months) seen.add(m);
    return [...seen].sort((a, b) => monthKey(b) - monthKey(a));
  }, [rows]);

  // the line's plans present — the panels' and the meter boxes'
  const families = useMemo(() => LV_FAMILIES.filter((f) => rows.some((r) => r.family === f)), [rows]);

  const filtered = useMemo(
    () => filterLvTracker(rows, { q, month, family, product, status, urgent, progress }),
    [rows, q, month, family, product, status, urgent, progress]
  );

  const resetFilters = () => { setQ(""); setProduct(""); setFamily(""); setStatus(""); setMonth(""); setUrgent(""); setProgress(""); };
  const activeFilters: TrackerFilter[] = [];
  if (q) activeFilters.push({ key: "q", label: "Search", value: q, onClear: () => setQ("") });
  if (month) activeFilters.push({ key: "month", label: "Plan month", value: month, onClear: () => setMonth("") });
  if (family) activeFilters.push({ key: "family", label: "Plan", value: family === "MB" ? "Meter boxes" : "LV panels", onClear: () => setFamily("") });
  if (product) activeFilters.push({ key: "product", label: "Product", value: product, onClear: () => setProduct("") });
  if (status && status !== "open") activeFilters.push({ key: "status", label: "Status", value: status === "hold" ? "On hold" : status === "closed" ? "Closed" : "All", onClear: () => setStatus("") });
  if (progress) activeFilters.push({ key: "progress", label: "Progress", value: progress === "none" ? "Not started" : progress === "partial" ? "In progress" : "Complete", onClear: () => setProgress("") });
  if (urgent) activeFilters.push({ key: "urgent", label: "Urgent", value: urgent === "yes" ? "Urgent only" : "Not urgent", onClear: () => setUrgent("") });

  // The cards report exactly the orders currently shown in the table.
  const cards = lvStageStats(filtered);

  // shared BOMs: one summary row per BOM, expandable to its MOs — the way the
  // planner reads the transformer tracker
  const groups = useMemo(() => {
    const by = new Map<string, LvTrackerRow[]>();
    for (const r of filtered) (by.get(r.bom) ?? by.set(r.bom, []).get(r.bom)!).push(r);
    return [...by.entries()];
  }, [filtered]);

  const required = filtered.reduce((s, r) => s + r.state.required, 0);
  const complete = filtered.reduce((s, r) => s + r.complete, 0);
  const doneRows = rows.filter((r) => r.status === "open" && r.state.required > 0 && r.state.delivered >= r.state.required);
  const doneCount = doneRows.length;

  const exportRows = filtered.map((r) => ({
    MO: r.mo, SOI: r.soi ?? "", Customer: r.customer ?? "", Product: r.product ?? "", BoM: r.bom, "SEC Item": r.secItem ?? "",
    Required: r.state.required, Punched: r.state.punch, Bent: r.state.bend, Welded: r.state.weld, Painted: r.state.paint,
    Left: r.remaining, Status: r.status, "On hold": r.hold.onHold ? holdLabel(r.hold) : "",
  }));

  function run(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, after?: () => void) {
    setCellErr("");
    startTransition(async () => {
      const res = await fn(fd);
      if (res.ok) { setEditKey(null); after?.(); router.refresh(); }
      else setCellErr(res.error ?? "Failed");
    });
  }

  const orderLine = (r: LvTrackerRow) => `${r.mo} · ${r.bom}${r.customer ? ` · ${r.customer}` : ""} — ${r.state.required} pcs`;

  // every close names the orders first; a reopen just happens
  async function changeStatus(r: LvTrackerRow, next: "open" | "closed") {
    if (next === "closed") {
      const ok = await confirmIt({
        title: `Close order ${r.mo}?`,
        body: <>It drops out of the daily screens; you can reopen it any time.</>,
        items: [orderLine(r)],
        confirmLabel: "Close order",
      });
      if (!ok) return;
    }
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("status", next);
    run(setOrderStatus, fd);
  }

  /** The open MOs of a merged code delivered in full. */
  const groupDone = (members: LvTrackerRow[]) => members.filter((m) => m.status === "open" && m.state.required > 0 && m.state.delivered >= m.state.required);
  async function changeGroupStatus(bom: string, members: LvTrackerRow[], next: "open" | "closed") {
    if (members.length === 0) return;
    if (next === "closed") {
      const ok = await confirmIt({
        title: `Close ${members.length} order${members.length === 1 ? "" : "s"} of ${bom}?`,
        body: <>They drop out of the daily screens; you can reopen any of them any time.</>,
        items: members.map(orderLine),
        confirmLabel: `Close ${members.length}`,
      });
      if (!ok) return;
    }
    const fd = new FormData();
    fd.set("mos", members.map((m) => m.mo).join(","));
    fd.set("status", next);
    run(setOrderStatus, fd);
  }

  async function closeDone() {
    const ok = await confirmIt({
      title: `Close ${doneCount} delivered order${doneCount === 1 ? "" : "s"}?`,
      body: <>Every panel of these has been delivered. Closing is a display state — the logs are untouched, and a closed order can be reopened from the Closed filter. The server checks each one again before it closes it.</>,
      items: doneRows.map(orderLine),
      confirmLabel: `Close ${doneCount}`,
    });
    if (!ok) return;
    setMsg("");
    startTransition(async () => {
      const res = await closeDeliveredOrders();
      setMsg(res.ok ? `Closed ${res.closed} order(s).` : (res.error ?? "Failed"));
      if (res.ok) router.refresh();
    });
  }

  const toggleGroup = (bom: string) => setOpenGroups((s) => { const n = new Set(s); if (n.has(bom)) n.delete(bom); else n.add(bom); return n; });

  /** One stage cell — a single MO's, or a merged BOM row's (then `preview`). */
  function cell(key: string, value: number, target: number, look: { held: boolean; urgent: boolean; bottleneck?: boolean }, stage: LvChainStage, save: (total: string) => void, preview?: (delta: number) => string) {
    const editing = editKey === key;
    const editable = editableStages.includes(stage);
    const added = editing ? Number(editVal) - value : 0;
    const state = stageState(value, target, false, look.urgent, look.held);
    const meter = editing ? undefined : meterStyle(value, target);
    const words = `${LV_STAGE_LABEL[stage]}: ${stageWords(value, target)}${look.bottleneck ? " · the stage holding this order back" : ""}`;
    return (
      <td
        key={key}
        className={`stage-cell ${editable ? "stage-editable" : ""} ${state} ${meter ? "stage-meter" : ""} ${look.bottleneck ? "stage-bottleneck" : ""} p-1 text-center tabnum`}
        style={meter}
        title={editable ? undefined : words}
        onClick={(e) => e.stopPropagation()}
      >
        {editing ? (
          <span className="inline-flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              <input
                type="number" min={0} value={editVal} autoFocus disabled={pending}
                onChange={(e) => { setEditVal(e.target.value); setCellErr(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") save(editVal); if (e.key === "Escape") setEditKey(null); }}
                className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface text-foreground"
              />
              <button type="button" onClick={() => save(editVal)} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save — the difference lands in today's Daily Log">✓</button>
              <button type="button" onClick={() => setEditKey(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">✕</button>
            </span>
            {added !== 0 && !cellErr && (
              <span className={`text-[10px] font-bold whitespace-nowrap ${added > 0 ? "text-ok-fg" : "text-bad-fg"}`}>
                {(preview && preview(added)) || (added > 0 ? `+${added} today` : `−${-added} correction`)}
              </span>
            )}
            {cellErr && <span className="text-[10px] text-bad-fg whitespace-normal max-w-48 text-start leading-tight font-normal">{cellErr}</span>}
            <span className="print-only tabnum">{value}</span>
          </span>
        ) : editable ? (
          <button
            type="button" disabled={pending}
            onClick={() => { setEditKey(key); setEditVal(String(value)); setCellErr(""); }}
            className="print-as-text w-full min-w-8 rounded px-1 py-1 tabnum hover:ring-2 hover:ring-brand/60 hover:font-bold transition-all cursor-text"
            title={`${words} — type the new total; the difference is recorded in today's Daily Log`}
          >
            {value > 0 ? value : <span className="print-only">0</span>}
          </button>
        ) : value > 0 ? value : ""}
      </td>
    );
  }

  // ⏸️ hold / release — a held order stays here, yellow, and leaves every
  // stage's worklist until released
  function setHold(mos: string[], hold: boolean, note = "") {
    const fd = new FormData();
    fd.set("mos", mos.join(","));
    fd.set("hold", String(hold));
    fd.set("note", note);
    run(setOrderHold, fd);
  }
  function menuEntries(t: MenuTarget): MenuEntry[] {
    if (t.kind === "group") {
      const open = t.members.filter((m) => m.status === "open");
      const held = open.filter((m) => m.hold.onHold);
      const free = open.filter((m) => !m.hold.onHold);
      const e: MenuEntry[] = [{ heading: `${t.bom} — ${t.members.length} MOs` }];
      if (canStatus) {
        e.push(
          { key: "hold", icon: "⏸️", label: `Put ${free.length} open MO${free.length === 1 ? "" : "s"} on hold`, disabled: free.length === 0, prompt: { placeholder: "Reason (optional)", submit: "Hold", onSubmit: (note) => setHold(free.map((m) => m.mo), true, note) } },
          { key: "release", icon: "▶", label: `Release ${held.length} from hold`, disabled: held.length === 0, onSelect: () => setHold(held.map((m) => m.mo), false) },
          { sep: true }
        );
        // the head row closes and reopens like an MO row — for every MO under it
        const done = groupDone(t.members);
        const closed = t.members.filter((m) => m.status === "closed");
        e.push(
          { key: "close", icon: "✓", label: `Close ${done.length} delivered MO${done.length === 1 ? "" : "s"}`, disabled: done.length === 0, hint: "Only an order delivered in full can close", onSelect: () => void changeGroupStatus(t.bom, done, "closed") },
          { key: "reopen", icon: "↩", label: `Reopen ${closed.length} closed MO${closed.length === 1 ? "" : "s"}`, disabled: closed.length === 0, onSelect: () => void changeGroupStatus(t.bom, closed, "open") },
          { sep: true }
        );
      }
      e.push({ key: "trace", icon: "🔍", label: "Open trace for this code", href: traceHref({ bom: t.bom, line: "LV" }) });
      return e;
    }
    const r = t.row;
    const closed = r.status === "closed";
    const e: MenuEntry[] = [{ heading: r.mo }];
    if (canStatus) {
      if (r.hold.onHold) e.push({ key: "release", icon: "▶", label: "Release hold", hint: holdLabel(r.hold), onSelect: () => setHold([r.mo], false) });
      else e.push({ key: "hold", icon: "⏸️", label: "Put on hold", disabled: closed, hint: closed ? "A closed order cannot be held — reopen it first" : "Pauses the order: it stays here, yellow, and leaves every stage's worklist", prompt: { placeholder: "Reason (optional) — e.g. waiting for enclosure", submit: "Hold", onSubmit: (note) => setHold([r.mo], true, note) } });
      e.push({ sep: true });
      e.push(closed
        ? { key: "reopen", icon: "↩", label: "Reopen order", onSelect: () => void changeStatus(r, "open") }
        : { key: "close", icon: "✓", label: "Close order", hint: "It leaves the open screens; the log is untouched", onSelect: () => void changeStatus(r, "closed") });
      e.push({ sep: true });
    }
    e.push({ key: "trace", icon: "🔍", label: "Open trace", href: traceHref({ mo: r.mo, line: "LV" }) });
    return e;
  }

  function moRow(r: LvTrackerRow, inGroup: boolean, lastInGroup = false) {
    const held = r.hold.onHold;
    const bn = held || r.status === "closed" ? null : lvBottleneck(r.state);
    const edge = held ? HOLD_EDGE : {};
    const frame = inGroup ? `border-x-2 border-brand ${lastInGroup ? "border-b-2" : ""}` : "";
    const badges = (
      <>
        {r.urgent && <span className="pill pill-bad" title="Urgent order">U</span>}
        {held && <span className="pill pill-warn cursor-help max-w-full" title={holdLabel(r.hold)}><Pause size={10} className="shrink-0" aria-hidden /><span className="truncate">HOLD{r.hold.holdNote ? ` · ${r.hold.holdNote}` : ""}</span></span>}
      </>
    );
    const moLink = <Link href={traceHref({ mo: r.mo, line: "LV" })} className="text-brand-ink hover:underline whitespace-nowrap">{r.mo}</Link>;
    const bomLink = <Link href={traceHref({ bom: r.bom, line: "LV" })} className="text-brand-ink hover:underline whitespace-nowrap">{r.bom}</Link>;
    return (
      <tr
        key={r.mo}
        className={`${frame} ${r.status === "closed" ? "opacity-60" : ""}`}
        style={held ? { background: HOLD_TINT } : undefined}
        onContextMenu={(e) => rowMenu.open(e, { kind: "mo", row: r })}
        title={held ? `${holdLabel(r.hold)} · right-click for actions` : undefined}
      >
        {moOn && (
          <td className={`p-2 font-bold text-xs ${inGroup ? "pl-5" : ""} stick`} style={{ ...idLayout.at.mo, ...edge }}>
            <span className="flex flex-wrap items-center gap-1">
              {inGroup && <CornerDownRight size={12} className="text-muted shrink-0" aria-hidden />}
              {moLink}
              {badges}
            </span>
          </td>
        )}
        {show("soi") && <td className="p-2 whitespace-nowrap stick" style={idLayout.at.soi}><Soi soi={r.soi} /></td>}
        {show("customer") && (
          <td className="p-2 text-xs stick" style={idLayout.at.customer} title={r.customer || undefined}>
            <span className="block truncate">{r.customer || <span className="text-muted">—</span>}</span>
          </td>
        )}
        {moOn ? (
          <td className="p-2 font-bold text-xs whitespace-nowrap stick" style={idLayout.at.bom}>{inGroup ? <span className="text-muted">{r.bom}</span> : bomLink}</td>
        ) : (
          // without the MO column BoM carries the order's marks — and, inside
          // an opened BoM, the MO (the BoM is on the row above)
          <td className={`p-2 font-bold text-xs ${inGroup ? "pl-5" : ""} stick`} style={{ ...idLayout.at.bom, ...edge }} title={`${r.mo} · ${r.bom}${r.customer ? ` · ${r.customer}` : ""}`}>
            <span className="flex flex-wrap items-center gap-1">
              {inGroup ? <><CornerDownRight size={12} className="text-muted shrink-0" aria-hidden />{moLink}</> : bomLink}
              {badges}
            </span>
          </td>
        )}
        {show("product") && <td className="p-2 text-center"><span className="pill pill-muted">{r.product ?? "—"}</span></td>}
        {show("sec") && <td className="p-2 text-xs whitespace-nowrap tabnum text-muted">{r.secItem ?? "—"}</td>}
        {show("required") && <td className="p-2 text-center font-bold tabnum stick stick-end" style={idLayout.req}>{r.state.required}</td>}
        {stages.map((stage) =>
          cell(`${r.mo}|${stage}`, lvStageOf(r.state, stage), r.state.required, { held, urgent: r.urgent, bottleneck: bn === stage }, stage, (total) => {
            const fd = new FormData();
            fd.set("mo", r.mo); fd.set("stage", stage); fd.set("total", total); fd.set("base", String(lvStageOf(r.state, stage)));
            run(recordLvTotal, fd);
          })
        )}
        {show("left") && (
          <td className="p-2 text-center font-semibold tabnum border-l border-border-strong" style={{ color: r.remaining > 0 ? undefined : "var(--ok-fg)" }}>{r.remaining}</td>
        )}
        {show("pct") && <AchCell ach={r.achievement} />}
        {show("status") && (
          <td className="p-2 text-center whitespace-nowrap no-print">
            {/* the row's actions live on right-click; the cell keeps only the
                state, and the one call to action a delivered order earns */}
            {r.status === "closed" ? (
              <span className="pill pill-muted opacity-70" title="Right-click the row to reopen">Closed</span>
            ) : canStatus && r.state.required > 0 && r.state.delivered >= r.state.required ? (
              <button type="button" onClick={() => changeStatus(r, "closed")} disabled={pending} className="btn btn-primary btn-sm !py-0.5">
                <Check size={12} aria-hidden />Close
              </button>
            ) : (
              <span className="pill pill-muted">Open</span>
            )}
          </td>
        )}
      </tr>
    );
  }

  return (
    // On desktop the page fills the viewport below the nav so the cards and
    // filters stay put and ONLY the table scrolls (its header pinned).
    <div className="tracker-view print-flow md:flex md:flex-col md:h-[calc(100vh-5rem)]">
      {head}
      <TrackerScope count={filtered.length} total={rows.length} basis={`${!status || status === "open" ? "Open orders" : status === "closed" ? "Closed orders" : status === "hold" ? "On hold" : "All statuses"} · through painting`} filters={activeFilters} onReset={resetFilters} />
      {/* the filtered orders at a glance: panels through each making stage */}
      <div className={`print-keep ${RING_GRID} mb-3`}>
        {cards.map((c) => (
          <RingCard wide compact key={c.stage} label={LV_STAGE_SHORT[c.stage]} note={`${c.stage.toLowerCase().replace(/ing$/, "ed")}`} done={c.done} need={c.need} />
        ))}
      </div>

      <FilterBar count={filtered.length} total={rows.length} onReset={resetFilters} showReset={false} hasActive={activeFilters.length > 0}
        head={<><LineSwitch /><SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / FG / SEC…" wide /></>}
      >
        <SelectFilter label="Plan month" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: m }))} />
        {families.length > 1 && <SelectFilter label="Plan" value={family} onChange={(v) => { setFamily(v); setProduct(""); }} options={families.map((f) => ({ value: f || "PNL", label: LV_FAMILY_LABEL[f] }))} />}
        {products.length > 1 && <SelectFilter label="Product" value={product} onChange={setProduct} options={products.map((p) => ({ value: p, label: p }))} />}
        <SelectFilter label="Status" value={status || "open"} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "hold", label: `On hold (${rows.filter((r) => r.hold.onHold).length})` }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }]} />
        <SelectFilter label="Progress" value={progress} onChange={setProgress} options={[{ value: "none", label: "Not started" }, { value: "partial", label: "In progress" }, { value: "done", label: "Complete" }]} />
        <SelectFilter label="Urgent" value={urgent} onChange={setUrgent} options={[{ value: "yes", label: "Urgent only" }, { value: "no", label: "Not urgent" }]} />
        <span className="text-xs text-muted">
          {family === "MB" ? "Meter boxes" : family === "PNL" ? "Panels" : "Units"}: <b className="text-foreground tabnum">{complete}</b> / <b className="text-foreground tabnum">{required}</b> painted
        </span>
        <ExportButton rows={exportRows} filename="lv-panels-tracker.xlsx" sheetName="LV Panels" />
        {canStatus && doneCount > 0 && (
          <button type="button" className="btn btn-sm btn-secondary normal-case" disabled={pending} onClick={closeDone} title="Close every open panel order whose panels have all been delivered">
            <CheckCheck size={13} className="text-ok-fg" />
            Close {doneCount} delivered
          </button>
        )}
        {msg && <span className="text-xs font-semibold text-ok-fg">{msg}</span>}
        <ColumnMenu cols={cols} list={COLS} fixed="BoM" fixedTitle="BoM always shows — it is what the row is">
          <div>
            <div className="filter-label mb-1.5">Stages</div>
            <div className="grid grid-cols-2 gap-x-3">
              {LV_STAGES.map((s) => (
                <label key={s} className="flex items-center gap-2 py-0.5 cursor-pointer">
                  <input type="checkbox" checked={!hiddenStages.has(s)} onChange={() => toggleStage(s)} />{LV_STAGE_LABEL[s]}
                </label>
              ))}
            </div>
          </div>
        </ColumnMenu>
      </FilterBar>

      <div className="print-flow print-fit erp-scroll bg-surface border rounded-[10px] overflow-auto md:flex-1 md:min-h-0">
        <table className="erp-table grid-lines w-full border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              {moOn && <th className="p-2 text-left stick" style={idLayout.at.mo}>MO</th>}
              {show("soi") && <th className="p-2 text-left stick" style={idLayout.at.soi} title="Sales order item">SOI</th>}
              {show("customer") && <th className="p-2 text-left stick" style={idLayout.at.customer}>Customer</th>}
              <th className="p-1 text-left stick" style={idLayout.at.bom}>
                <FoldButton open={cols.anyOn(ID_GROUP)} onClick={() => cols.toggle(ID_GROUP)} label="BoM" title={cols.anyOn(ID_GROUP) ? "Fold MO, SOI and Customer away — BoM stays" : "Show MO, SOI and Customer"} />
              </th>
              {show("product") && <th className="p-2" title="The panel or meter box type">Product</th>}
              {show("sec") && <th className="p-2 text-left">SEC Item</th>}
              {show("required") && (
                <th className="p-1 stick stick-end" style={idLayout.req}>
                  <FoldButton open={cols.anyOn(SPEC_GROUP)} onClick={() => cols.toggle(SPEC_GROUP)} label="Required" title={cols.anyOn(SPEC_GROUP) ? "Fold Product and SEC Item away" : "Show Product and SEC Item"} back />
                </th>
              )}
              {stages.map((s) => (
                <th key={s} className="p-2" title={LV_STAGE_LABEL[s]}>{LV_STAGE_SHORT[s]}</th>
              ))}
              {show("left") && <th className="p-2 border-l border-border-strong" title="Required − painted">Left</th>}
              {show("pct") && (
                <th className="p-1" title="Painted ÷ required">
                  <FoldButton open={cols.anyOn(SUMMARY_GROUP)} onClick={() => cols.toggle(SUMMARY_GROUP)} label="%" title={cols.anyOn(SUMMARY_GROUP) ? "Fold Left away — % stays" : "Show Left beside %"} back />
                </th>
              )}
              {show("status") && <th className="p-2 no-print">Status</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={tableCols} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No LV panel orders yet — import their monthly plan from Tools → Orders Registry." : "No rows match the filters."}
              </td></tr>
            )}
            {groups.map(([bom, members]) => {
              if (members.length === 1) return moRow(members[0], false);
              const open = openGroups.has(bom);
              const sum = (f: (r: LvTrackerRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const gReq = sum((r) => r.state.required);
              const gComplete = sum((r) => r.complete);
              const urgentN = members.filter((m) => m.urgent).length;
              const heldCount = members.filter((m) => m.hold.onHold).length;
              const allHeld = heldCount === members.length;
              const customers = [...new Set(members.map((m) => m.customer).filter(Boolean))];
              const marks = (
                <>
                  {urgentN > 0 && <span className="pill pill-bad">U×{urgentN}</span>}
                  {heldCount > 0 && <span className="pill pill-warn" title={allHeld ? "Every MO of this code is on hold" : `${heldCount} of ${members.length} MOs on hold — open the group`}><Pause size={10} aria-hidden />{allHeld ? "HOLD" : `${heldCount}/${members.length}`}</span>}
                </>
              );
              const caret = <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden />;
              const bomLink = <Link href={traceHref({ bom: bom, line: "LV" })} onClick={(e) => e.stopPropagation()} className="text-brand-ink hover:underline whitespace-nowrap">{bom}</Link>;
              return (
                <Fragment key={`g|${bom}`}>
                  <tr
                    className={`cursor-pointer font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    style={allHeld ? { background: HOLD_TINT } : undefined}
                    onClick={() => toggleGroup(bom)}
                    onContextMenu={(e) => rowMenu.open(e, { kind: "group", bom, members })}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM · right-click for actions"}
                  >
                    {moOn && (
                      <td className="p-2 font-bold text-xs stick" style={idLayout.at.mo}>
                        <span className="flex flex-wrap items-center gap-1">{caret}{members.length} MOs{marks}</span>
                      </td>
                    )}
                    {show("soi") && <td className="p-2 whitespace-nowrap stick" style={idLayout.at.soi}><Soi soi={null} /></td>}
                    {show("customer") && (
                      <td className="p-2 text-xs text-muted stick" style={idLayout.at.customer} title={customers.join(" · ") || undefined}>
                        <span className="block truncate">{customers.join(" · ") || "—"}</span>
                      </td>
                    )}
                    <td className="p-2 font-bold text-xs stick" style={idLayout.at.bom}>
                      {moOn ? bomLink : <span className="flex flex-wrap items-center gap-1">{caret}{bomLink}<span className="text-muted font-normal">×{members.length}</span>{marks}</span>}
                    </td>
                    {show("product") && <td className="p-2 text-center">{[...new Set(members.map((m) => m.product).filter(Boolean))].map((p) => <span key={p} className="pill pill-muted me-1">{p}</span>)}</td>}
                    {show("sec") && <td className="p-2 text-xs text-muted tabnum">{[...new Set(members.map((m) => m.secItem).filter(Boolean))].join(", ") || "—"}</td>}
                    {show("required") && <td className="p-2 text-center font-bold stick stick-end" style={idLayout.req}><Num v={gReq} /></td>}
                    {stages.map((stage) =>
                      cell(
                        `g|${bom}|${stage}`,
                        sum((r) => lvStageOf(r.state, stage)),
                        gReq,
                        { held: allHeld, urgent: urgentN > 0 },
                        stage,
                        (total) => {
                          const fd = new FormData();
                          fd.set("bom", bom); fd.set("stage", stage); fd.set("total", total); fd.set("mos", members.map((m) => m.mo).join(","));
                          fd.set("base", String(sum((r) => lvStageOf(r.state, stage))));
                          run(recordLvGroupTotal, fd);
                        },
                        // which MOs the number lands on, before it is saved —
                        // the same rule the server writes with
                        (delta) => spreadWords(spreadOverGroup(lvGroupMembers(members.map((m) => ({ mo: m.mo, state: m.state })), stage), delta))
                      )
                    )}
                    {show("left") && <td className="p-2 text-center font-semibold border-l border-border-strong" style={{ color: gReq - gComplete > 0 ? undefined : "var(--ok-fg)" }}><Num v={Math.max(0, gReq - gComplete)} /></td>}
                    {show("pct") && <AchCell ach={gReq > 0 ? gComplete / gReq : null} />}
                    {show("status") && (() => {
                      const done = groupDone(members);
                      const closedN = members.filter((m) => m.status === "closed").length;
                      return (
                        <td className="p-2 text-center whitespace-nowrap no-print" onClick={(e) => e.stopPropagation()}>
                          {closedN === members.length ? (
                            <span className="pill pill-muted opacity-70" title="Right-click the row to reopen">Closed</span>
                          ) : canStatus && done.length > 0 ? (
                            <button type="button" onClick={() => changeGroupStatus(bom, done, "closed")} disabled={pending} className="btn btn-primary btn-sm !py-0.5" title={`Close the ${done.length} delivered MO${done.length === 1 ? "" : "s"} of ${bom}`}>
                              <Check size={12} aria-hidden />Close{done.length < members.length ? ` ${done.length}` : ""}
                            </button>
                          ) : (
                            <span className="pill pill-muted" title={closedN ? `${closedN} of ${members.length} closed` : undefined}>Open{closedN ? ` ${members.length - closedN}/${members.length}` : ""}</span>
                          )}
                        </td>
                      );
                    })()}
                  </tr>
                  {open && members.map((m, i) => moRow(m, true, i === members.length - 1))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rowMenu.menu && <ContextMenu x={rowMenu.menu.x} y={rowMenu.menu.y} entries={menuEntries(rowMenu.menu.payload)} ai={rowMenu.menu.ai} onClose={rowMenu.close} />}
      {confirmDialog}
    </div>
  );
}
