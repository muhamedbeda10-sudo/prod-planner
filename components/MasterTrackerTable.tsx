"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { setOrderStatus, setExcludedItems, setOrderQty, setOrderPriority, pushOrderToWorklist, removeOrderMonth } from "@/app/orders/actions";
import { recordTrackerTotal } from "@/app/worklist/actions";
import { pctStyle, Num } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { ITEMS, DEPTS, isPaintExempt, deptLabel, type Item, type Dept } from "@/lib/domain/constants";

type Progress = "complete" | "inprogress" | "notstarted";

function progressOf(r: MasterTrackerRow): Progress {
  if (r.required > 0 && r.complete >= r.required) return "complete";
  if (r.complete > 0 || ITEMS.some((it) => r.items[it].cut > 0 || r.items[it].weld > 0)) return "inprogress";
  return "notstarted";
}

export function MasterTrackerTable({
  rows,
  features = [],
  editableDepts = [],
}: {
  rows: MasterTrackerRow[];
  /** The tracker feature-permission keys this user holds (admin = all):
   *  tracker.status / tracker.components / tracker.qty / tracker.priority / tracker.push */
  features?: string[];
  /** Stage columns this user may record on (their OWN tracker permissions —
   *  separate from the worklist ones): Cut | Welding | Painting | Delivered. */
  editableDepts?: string[];
}) {
  const can = (k: string) => features.includes(k);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // inline stage-cell editor: one cell at a time (mo|item|dept)
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [cellErr, setCellErr] = useState("");
  // inline Required-qty editor (manual order-qty change, e.g. after a revision
  // lowered a quantity — the import never lowers it automatically)
  const [qtyEditMo, setQtyEditMo] = useState<string | null>(null);
  const [qtyVal, setQtyVal] = useState("");
  const [qtyErr, setQtyErr] = useState("");

  function saveQty(mo: string) {
    const fd = new FormData();
    fd.set("mo", mo);
    fd.set("qty", qtyVal);
    setQtyErr("");
    startTransition(async () => {
      const res = await setOrderQty(fd);
      if (res.ok) {
        setQtyEditMo(null);
        router.refresh();
      } else {
        setQtyErr(res.error ?? "Failed");
      }
    });
  }
  // filters survive navigating away and back (sessionStorage per tab)
  const [q, setQ] = useSavedFilter("tracker.q");
  const [progress, setProgress] = useSavedFilter("tracker.progress");
  const [urgent, setUrgent] = useSavedFilter("tracker.urgent");
  const [status, setStatus] = useSavedFilter("tracker.status", "open"); // lifecycle: closed orders are hidden by default
  const [month, setMonth] = useSavedFilter("tracker.month"); // monthly plan (import source), "" = all months
  const [openConfig, setOpenConfig] = useState<string | null>(null); // per-MO "required components" editor

  function saveExcluded(r: MasterTrackerRow, form: HTMLFormElement) {
    const fd = new FormData(form);
    const required = fd.getAll("req").map(String);
    // only the order's own components can be toggled; excluded = eligible − checked
    const eligible = ITEMS.filter((it) => r.items[it].eligible);
    const excluded = eligible.filter((it) => !required.includes(it)).join(",");
    const out = new FormData();
    out.set("mo", r.mo);
    out.set("excluded", excluded);
    startTransition(async () => {
      const res = await setExcludedItems(out);
      if (res.ok) {
        setOpenConfig(null);
        router.refresh();
      } else {
        alert(res.error ?? "Failed");
      }
    });
  }

  const closedCount = useMemo(() => rows.filter((r) => r.status === "closed").length, [rows]);

  // the monthly plans present in the registry, newest first ("July 2026" labels)
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthKey = (label: string) => {
    const m = /^(\w+)\s+(\d{4})$/.exec(label.trim());
    const idx = m ? MONTH_NAMES.indexOf(m[1]) : -1;
    return m && idx >= 0 ? Number(m[2]) * 12 + idx : -1; // unparseable labels sort last
  };
  const months = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) for (const m of r.months) seen.add(m);
    return [...seen].sort((a, b) => monthKey(b) - monthKey(a));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasNoMonth = useMemo(() => rows.some((r) => r.months.length === 0), [rows]);

  // month scope — an order carried across plans belongs to EVERY month it
  // appeared in. The summary cards follow THIS filter (each month's plan
  // progress on its own), while search/progress/urgent only narrow the table
  const monthRows = useMemo(
    () => (month ? rows.filter((r) => (month === "—" ? r.months.length === 0 : r.months.includes(month))) : rows),
    [rows, month]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return monthRows.filter((r) => {
      if (status && r.status !== status) return false;
      if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.kva ?? ""}`.toUpperCase().includes(needle))) return false;
      if (progress && progressOf(r) !== progress) return false;
      if (urgent === "yes" && !r.urgent) return false;
      return true;
    });
  }, [monthRows, q, progress, urgent, status]);

  const hasActive = !!(q || progress || urgent || month || status !== "open");

  // shared BOMs: one summary row per BOM, expandable to its MOs
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (gk: string) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(gk)) n.delete(gk);
      else n.add(gk);
      return n;
    });
  const groups = useMemo(() => {
    const map = new Map<string, MasterTrackerRow[]>();
    for (const r of filtered) {
      if (!map.has(r.bom)) map.set(r.bom, []);
      map.get(r.bom)!.push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  // 🔁 months editor: fix a wrongly-tagged plan month (admin)
  const [openMonths, setOpenMonths] = useState<string | null>(null);

  function dropMonth(r: MasterTrackerRow, m: string) {
    if (!confirm(`Remove "${m}" from ${r.mo}? It will stop showing under that month's filter.`)) return;
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("month", m);
    startTransition(async () => {
      const res = await removeOrderMonth(fd);
      if (res.ok) {
        setOpenMonths(null);
        router.refresh();
      } else {
        alert(res.error ?? "Failed");
      }
    });
  }

  // ⭐ priority toggle — the order shows in the priority table on every worklist
  function togglePriority(r: MasterTrackerRow) {
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("priority", String(!r.priority));
    startTransition(async () => {
      const res = await setOrderPriority(fd);
      if (res.ok) router.refresh();
      else alert(res.error ?? "Failed");
    });
  }

  // 📤 send-to-worklist panel: one MO at a time, dept + qty per item
  const [openPush, setOpenPush] = useState<string | null>(null);
  const [pushDept, setPushDept] = useState<Dept>("Cut");
  const [pushQty, setPushQty] = useState<Record<string, string>>({}); // item -> qty
  const [pushErr, setPushErr] = useState("");

  // what each dept still owes on an item — the push panel's ceiling
  function remainingFor(r: MasterTrackerRow, it: Item, dept: Dept): number {
    const c = r.items[it];
    if (!c.eligible || c.excluded) return 0; // AR/MB the order doesn't need, or N/A
    if (dept === "Painting" && isPaintExempt(it)) return 0; // the core is never painted
    const need = Math.max(0, r.required - c.osp);
    const done = dept === "Cut" ? c.cut : dept === "Welding" ? c.weld : c.paint;
    return Math.max(0, need - done);
  }

  function openPushPanel(r: MasterTrackerRow) {
    setOpenPush(openPush === r.mo ? null : r.mo);
    setPushDept("Cut");
    setPushQty(Object.fromEntries(ITEMS.map((it) => [it, String(remainingFor(r, it, "Cut"))])));
    setPushErr("");
  }

  function submitPush(r: MasterTrackerRow) {
    const fd = new FormData();
    fd.set("mo", r.mo);
    fd.set("dept", pushDept);
    for (const it of ITEMS) fd.set(`qty${it}`, pushQty[it] ?? "");
    setPushErr("");
    startTransition(async () => {
      const res = await pushOrderToWorklist(fd);
      if (res.ok) {
        setOpenPush(null);
        router.refresh();
      } else {
        setPushErr(res.error ?? "Failed");
      }
    });
  }

  function changeStatus(mo: string, next: "open" | "closed") {
    if (next === "closed" && !confirm(`Close order ${mo}? It will drop out of the daily screens (you can reopen it any time).`)) return;
    const fd = new FormData();
    fd.set("mo", mo);
    fd.set("status", next);
    startTransition(async () => {
      await setOrderStatus(fd);
      router.refresh();
    });
  }

  // per-component plan progress — follows the MONTH filter (each month's plan
  // progress on its own; all months when no month is picked):
  // need = required − OSP (excluded items don't count), done = the FINAL stage
  const itemStats = ITEMS.map((it) => {
    // final stage = SHOT BLAST for the paint-exempt core (CF), Painting otherwise
    const finalIsShp = isPaintExempt(it);
    let need = 0;
    let done = 0;
    for (const r of monthRows) {
      const c = r.items[it];
      if (!c.eligible || c.excluded) continue; // AR/MB only count on orders that need them
      const n = Math.max(0, r.required - c.osp);
      need += n;
      done += Math.min(finalIsShp ? c.shp : c.paint, n);
    }
    return { it, finalIsShp, need, done, remaining: Math.max(0, need - done), pct: need > 0 ? done / need : null };
  });

  const exportRows = filtered.map((r) => ({
    MO: r.mo,
    BOM: r.bom,
    "Plan months": r.months.join(", "),
    SOI: r.soi ?? "",
    Urgent: r.urgent ? "Yes" : "",
    KVA: r.kva ?? "",
    Required: r.required,
    "CF Fab": r.items.CF.cut, "CF Weld": r.items.CF.weld, "CF SHB": r.items.CF.shp, "CF Dlvd": r.items.CF.delivered,
    "TC Fab": r.items.TC.cut, "TC Weld": r.items.TC.weld, "TC Paint": r.items.TC.paint, "TC Dlvd": r.items.TC.delivered,
    "TN Fab": r.items.TN.cut, "TN Weld": r.items.TN.weld, "TN Paint": r.items.TN.paint, "TN Dlvd": r.items.TN.delivered,
    "CB Fab": r.items.CB.cut, "CB Weld": r.items.CB.weld, "CB Paint": r.items.CB.paint, "CB Dlvd": r.items.CB.delivered,
    "AR Fab": r.items.AR.cut, "AR Weld": r.items.AR.weld, "AR Paint": r.items.AR.paint, "AR Dlvd": r.items.AR.delivered,
    "MB Fab": r.items.MB.cut, "MB Weld": r.items.MB.weld, "MB Paint": r.items.MB.paint, "MB Dlvd": r.items.MB.delivered,
    OSP: ITEMS.filter((it) => r.items[it].osp > 0).map((it) => `${it}×${r.items[it].osp}`).join(" "),
    Welded: r.welded,
    "Complete (painted)": r.complete,
    Left: r.remaining,
    "Achievement %": r.achievement === null ? "" : Math.round(r.achievement * 100),
    Status: r.status,
  }));

  return (
    <>
      {/* the summary cards + filters stay pinned below the nav on desktop so
          only the table scrolls under them */}
      <div className="md:sticky md:top-16 md:z-20 bg-background">
      {/* per-component plan progress — remaining / of total / execution % (display only) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        {itemStats.map(({ it, finalIsShp, need, done, remaining, pct }) => (
          <div key={it} className="bg-surface border rounded-xl px-4 py-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-extrabold text-muted">{it}</span>
              <span className="text-[11px] font-bold tabnum rounded px-1.5 py-0.5" style={pctStyle(pct)}>
                {pct === null ? "—" : `${Math.round(pct * 100)}%`}
              </span>
            </div>
            <div className="text-2xl font-extrabold tabnum" style={{ color: remaining > 0 ? "var(--warn-fg)" : "var(--ok-fg)" }}>
              {remaining}
            </div>
            <div className="text-[11px] text-muted tabnum">
              left of <b className="text-foreground">{need}</b> · {finalIsShp ? "shot blasted" : "painted"} {done}
            </div>
            <div className="mt-1 h-1.5 rounded bg-border overflow-hidden">
              <div
                className="h-full transition-all"
                style={{ width: `${Math.min(100, (pct ?? 0) * 100)}%`, background: (pct ?? 0) >= 1 ? "var(--ok-fg)" : "var(--brand)" }}
              />
            </div>
          </div>
        ))}
      </div>

      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setProgress(""); setUrgent(""); setStatus("open"); setMonth(""); }} hasActive={hasActive}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / KVA…" />
        <SelectFilter
          label="Plan month"
          value={month}
          onChange={setMonth}
          options={[
            ...months.map((m) => ({ value: m, label: m })),
            ...(hasNoMonth ? [{ value: "—", label: "No month" }] : []),
          ]}
        />
        <SelectFilter
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: `Closed (${closedCount})` },
          ]}
        />
        <SelectFilter
          label="Progress"
          value={progress}
          onChange={setProgress}
          options={[
            { value: "complete", label: "Complete (100%)" },
            { value: "inprogress", label: "In progress" },
            { value: "notstarted", label: "Not started" },
          ]}
        />
        <SelectFilter label="Urgent" value={urgent} onChange={setUrgent} options={[{ value: "yes", label: "Urgent only" }]} />
        <ExportButton rows={exportRows} filename="plan-tracker.xlsx" sheetName="Tracker" />
      </FilterBar>
      </div>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white">
              <th rowSpan={2} className="p-2 text-left">MO</th>
              <th rowSpan={2} className="p-2 text-left">BOM</th>
              <th rowSpan={2} className="p-2">KVA</th>
              <th rowSpan={2} className="p-2">Required</th>
              {ITEMS.map((it) => (
                <th key={it} colSpan={4} className="p-2 border-r border-border-strong">{it}</th>
              ))}
              <th rowSpan={2} className="p-2 border-r border-border-strong">Complete</th>
              <th rowSpan={2} className="p-2">Left</th>
              <th rowSpan={2} className="p-2">Achv.</th>
              <th rowSpan={2} className="p-2 no-print">Status</th>
            </tr>
            <tr className="bg-brand text-white text-xs">
              {ITEMS.map((it) => (
                <StageHead key={it} shp={isPaintExempt(it)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={32} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No orders yet — import a monthly plan." : "No rows match the filters."}
              </td></tr>
            )}
            {groups.map(([gBom, members]) => {
              if (members.length === 1) return renderRow(members[0]);
              const open = openGroups.has(gBom);
              const sum = (f: (r: MasterTrackerRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const gReq = sum((r) => r.required);
              const gComplete = sum((r) => r.complete);
              const gLeft = sum((r) => r.remaining);
              const gAch = gReq > 0 ? gComplete / gReq : null;
              const urgentCount = members.filter((m) => m.urgent).length;
              const gKva = members.find((m) => m.kva)?.kva ?? "—";
              return (
                <Fragment key={`g|${gBom}`}>
                  <tr
                    className={`cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    onClick={() => toggleGroup(gBom)}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM"}
                  >
                    <td className="p-2 font-bold whitespace-nowrap text-xs">
                      <span className={`inline-block mr-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
                      {members.length} MOs
                      {urgentCount > 0 && <span className="pill pill-bad ml-1">U×{urgentCount}</span>}
                    </td>
                    <td className="p-2 font-bold whitespace-nowrap">
                      <Link href={`/trace?bom=${encodeURIComponent(gBom)}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">{gBom}</Link>
                    </td>
                    <td className="p-2 text-xs whitespace-nowrap text-muted text-center">{gKva}</td>
                    <td className="p-2 text-center font-bold"><Num v={gReq} /></td>
                    {ITEMS.map((it) => (
                      <StageCells
                        key={it}
                        cut={sum((r) => r.items[it].cut)}
                        weld={sum((r) => r.items[it].weld)}
                        paint={sum((r) => r.items[it].paint)}
                        shp={sum((r) => r.items[it].shp)}
                        delivered={sum((r) => r.items[it].delivered)}
                        noPaint={isPaintExempt(it)}
                      />
                    ))}
                    <td className="p-2 text-center font-extrabold border-r"><Num v={gComplete} /></td>
                    <td className="p-2 text-center font-bold" style={{ color: gLeft > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>
                      <Num v={gLeft} />
                    </td>
                    <td className="p-2 text-center font-bold tabnum" style={pctStyle(gAch)}>
                      {gAch === null ? "—" : `${(gAch * 100).toFixed(0)}%`}
                    </td>
                    <td className="p-2 text-center no-print text-xs text-muted whitespace-nowrap">{open ? "▲ collapse" : "▼ open MOs"}</td>
                  </tr>
                  {open && members.map((m, i) => renderRow(m, true, i === members.length - 1))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );

  /** One stage cell on a single-MO row. For depts the user can edit, clicking
   *  the number opens an inline editor: type the NEW cumulative total, the
   *  difference is recorded in the Daily Log dated today (and flows to the
   *  dept's worklist). A LOWER total records a NEGATIVE correction entry —
   *  the chain guard (painted ≤ welded ≤ cut ≤ order) blocks contradictions. */
  function stageCell(r: MasterTrackerRow, it: Item, dept: string, value: number, tint: string, borderR = false) {
    const k = `${r.mo}|${it}|${dept}`;
    const editing = editKey === k;
    const editable = editableDepts.includes(dept);
    const added = editing ? Number(editVal) - value : 0;

    function save() {
      const fd = new FormData();
      fd.set("dept", dept);
      fd.set("bom", r.bom);
      fd.set("mo", r.mo);
      fd.set("item", it);
      fd.set("total", editVal);
      setCellErr("");
      startTransition(async () => {
        const res = await recordTrackerTotal(fd);
        if (res.ok) {
          setEditKey(null);
          router.refresh();
        } else {
          setCellErr(res.error ?? "Failed");
        }
      });
    }

    return (
      <td className={`p-1 text-center tabnum ${borderR ? "border-r" : ""}`} style={{ background: tint }}>
        {editing ? (
          <span className="inline-flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={editVal}
                autoFocus
                onChange={(e) => { setEditVal(e.target.value); setCellErr(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") setEditKey(null);
                }}
                className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface"
                disabled={pending}
              />
              <button type="button" onClick={save} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save — the difference lands in today's Daily Log (a lower total records a negative correction)">
                ✓
              </button>
              <button type="button" onClick={() => setEditKey(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">
                ✕
              </button>
            </span>
            {added > 0 && !cellErr && <span className="text-[10px] font-bold text-ok-fg whitespace-nowrap">+{added} today</span>}
            {added < 0 && !cellErr && (
              <span className="text-[10px] font-bold text-bad-fg whitespace-nowrap" title="Recorded as a negative correction entry in today's Daily Log">
                −{-added} correction
              </span>
            )}
            {cellErr && <span className="text-[10px] text-bad-fg whitespace-normal max-w-48 text-start leading-tight">{cellErr}</span>}
          </span>
        ) : editable ? (
          <button
            type="button"
            onClick={() => { setEditKey(k); setEditVal(String(value)); setCellErr(""); }}
            disabled={pending}
            className="w-full min-w-8 rounded px-1 py-1 tabnum hover:ring-2 hover:ring-brand/60 hover:font-bold transition-all cursor-text"
            title={`${deptLabel(dept)} · ${r.mo} · ${it} — click to record: type the NEW total (lower = negative correction in today's Daily Log)`}
          >
            {value}
          </button>
        ) : (
          value
        )}
      </td>
    );
  }

  function renderRow(r: MasterTrackerRow, inGroup = false, lastInGroup = false) {
    // frame: open groups get a clear border so their extent is obvious
    const frame = inGroup ? `bg-brand-light/10 border-x-2 border-brand ${lastInGroup ? "border-b-2" : ""}` : "";
    return (
      <Fragment key={r.mo}>
              <tr className={frame}>
                <td className={`p-2 font-bold whitespace-nowrap text-xs ${inGroup ? "pl-6" : ""}`}>
                  {inGroup && <span className="text-muted mr-1">↳</span>}
                  <Link href={`/trace?mo=${encodeURIComponent(r.mo)}`} className="text-accent hover:underline">{r.mo}</Link>
                  {r.priority && <span className="ml-1" title="Priority order — shown on top of every dept worklist">⭐</span>}
                  {r.months.length > 1 && (
                    can("admin") ? (
                      <button
                        type="button"
                        onClick={() => setOpenMonths(openMonths === r.mo ? null : r.mo)}
                        disabled={pending}
                        className="pill pill-warn ml-1 cursor-pointer hover:ring-2 hover:ring-brand/60 transition-all"
                        title={`Carried across ${r.months.length} monthly plans: ${r.months.join(" · ")} — click to fix a wrong tag`}
                      >
                        🔁 ×{r.months.length}
                      </button>
                    ) : (
                      <span
                        className="pill pill-warn ml-1"
                        title={`Carried across ${r.months.length} monthly plans: ${r.months.join(" · ")}`}
                      >
                        🔁 ×{r.months.length}
                      </span>
                    )
                  )}
                  {r.urgent && <span className="pill pill-bad ml-1">U</span>}
                  {ITEMS.filter((it) => r.items[it].osp > 0).map((it) => (
                    <span key={it} className="pill ml-1" style={{ background: "#ece3f7", color: "#6b45a8" }} title={`${it}: ${r.items[it].osp} pcs outsourced (OSP) — not made by our departments`}>
                      OSP {it}×{r.items[it].osp}
                    </span>
                  ))}
                  {ITEMS.filter((it) => r.items[it].excluded).map((it) => (
                    <span key={`x${it}`} className="pill pill-muted ml-1" title={`${it} is not required for this project — it doesn't gate completion and never appears in the worklists`}>
                      N/A {it}
                    </span>
                  ))}
                </td>
                <td className="p-2 font-bold whitespace-nowrap">
                  <Link href={`/trace?bom=${encodeURIComponent(r.bom)}`} className="text-accent hover:underline">{r.bom}</Link>
                </td>
                <td className="p-2 text-xs whitespace-nowrap text-muted text-center">{r.kva ?? "—"}</td>
                <td className="p-2 text-center font-bold">
                  {qtyEditMo === r.mo ? (
                    <span className="inline-flex flex-col items-center gap-0.5">
                      <span className="inline-flex items-center gap-1">
                        <input
                          type="number"
                          min={1}
                          value={qtyVal}
                          autoFocus
                          onChange={(e) => { setQtyVal(e.target.value); setQtyErr(""); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveQty(r.mo);
                            if (e.key === "Escape") setQtyEditMo(null);
                          }}
                          className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface"
                          disabled={pending}
                        />
                        <button type="button" onClick={() => saveQty(r.mo)} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save the new order quantity">
                          ✓
                        </button>
                        <button type="button" onClick={() => setQtyEditMo(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">
                          ✕
                        </button>
                      </span>
                      {qtyErr && <span className="text-[10px] text-bad-fg whitespace-normal max-w-48 leading-tight">{qtyErr}</span>}
                    </span>
                  ) : can("tracker.qty") ? (
                    <button
                      type="button"
                      onClick={() => { setQtyEditMo(r.mo); setQtyVal(String(r.required)); setQtyErr(""); }}
                      disabled={pending}
                      className="w-full min-w-10 rounded px-1 py-1 tabnum font-bold hover:ring-2 hover:ring-brand/60 transition-all cursor-text"
                      title={`${r.mo} — click to change the required quantity (revisions that LOWER a qty are applied here manually)`}
                    >
                      <Num v={r.required} />
                    </button>
                  ) : (
                    <Num v={r.required} />
                  )}
                </td>
                {ITEMS.map((it) => {
                  const c = r.items[it];
                  // AR/MB the order's KVA/rating rule doesn't match, or a manual
                  // N/A, show as blank dashes and don't gate completion
                  if (!c.eligible || c.excluded) {
                    return (
                      <Fragment key={it}>
                        <td className="p-2 text-center text-muted">—</td>
                        <td className="p-2 text-center text-muted">—</td>
                        <td className="p-2 text-center text-muted">—</td>
                        <td className="p-2 text-center text-muted border-r">—</td>
                      </Fragment>
                    );
                  }
                  return (
                    <Fragment key={it}>
                      {stageCell(r, it, "Cut", c.cut, "var(--cut-tint)")}
                      {stageCell(r, it, "Welding", c.weld, "var(--weld-tint)")}
                      {isPaintExempt(it) ? (
                        stageCell(r, it, "ShotBlast", c.shp, "var(--shp-tint)")
                      ) : (
                        stageCell(r, it, "Painting", c.paint, "var(--paint-tint)")
                      )}
                      {stageCell(r, it, "Delivered", c.delivered, "var(--dlvd-tint)", true)}
                    </Fragment>
                  );
                })}
                <td className="p-2 text-center font-extrabold border-r"><Num v={r.complete} /></td>
                <td className="p-2 text-center font-bold" style={{ color: r.remaining > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>
                  <Num v={r.remaining} />
                </td>
                <td className="p-2 text-center font-bold tabnum" style={pctStyle(r.achievement)}>
                  {r.achievement === null ? "—" : `${(r.achievement * 100).toFixed(0)}%`}
                </td>
                <td className="p-2 text-center no-print whitespace-nowrap">
                  {r.status === "closed" ? (
                    <>
                      <span className="pill pill-muted">Closed</span>
                      {can("tracker.status") && (
                        <button onClick={() => changeStatus(r.mo, "open")} disabled={pending} className="text-accent text-xs px-1.5 hover:underline">Reopen</button>
                      )}
                    </>
                  ) : can("tracker.status") && r.required > 0 && r.complete >= r.required ? (
                    <button onClick={() => changeStatus(r.mo, "closed")} disabled={pending} className="rounded-md px-2 py-0.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                      ✓ Close
                    </button>
                  ) : (
                    <span className="pill pill-ok">Open</span>
                  )}
                  {can("tracker.components") && (
                    <button
                      onClick={() => setOpenConfig(openConfig === r.mo ? null : r.mo)}
                      disabled={pending}
                      className="text-muted text-xs px-1.5 hover:text-accent"
                      title="Which components does this project actually need?"
                    >
                      ⚙
                    </button>
                  )}
                  {r.status === "open" && (
                    <>
                      {can("tracker.priority") && (
                        <button
                          onClick={() => togglePriority(r)}
                          disabled={pending}
                          className={`text-xs px-1 ${r.priority ? "" : "grayscale opacity-50 hover:opacity-100"}`}
                          title={r.priority ? "Remove the priority flag" : "Flag as PRIORITY — shows in a dedicated table on top of every dept worklist"}
                        >
                          ⭐
                        </button>
                      )}
                      {can("tracker.push") && (
                        <button
                          onClick={() => openPushPanel(r)}
                          disabled={pending}
                          className="text-muted text-xs px-1 hover:text-accent"
                          title="Send this order down to a worklist — pick the dept, items and quantities"
                        >
                          📤
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
              {openMonths === r.mo && (
                <tr className={inGroup ? "border-x-2 border-brand" : ""}>
                  <td colSpan={32} className="p-3 bg-brand-light/30 border-y">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-bold text-xs">🔁 {r.mo} appears under:</span>
                      {r.months.map((m) => (
                        <span key={m} className="pill pill-muted inline-flex items-center gap-1">
                          {m}
                          <button
                            type="button"
                            onClick={() => dropMonth(r, m)}
                            disabled={pending || r.months.length <= 1}
                            className="text-bad-fg font-extrabold px-0.5 disabled:opacity-30"
                            title={r.months.length <= 1 ? "An order must keep at least one plan month" : `Remove "${m}" — wrong tag`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      <button type="button" onClick={() => setOpenMonths(null)} className="text-muted text-xs hover:underline">Close</button>
                      <span className="text-[11px] text-muted w-full">
                        A month is tagged automatically when the MO appears as a row in that month&apos;s imported sheet. Remove a wrong tag here — re-importing that month&apos;s file would tag it again only if the MO is still in the file.
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              {openPush === r.mo && (
                <tr className={inGroup ? "border-x-2 border-brand" : ""}>
                  <td colSpan={32} className="p-3 bg-brand-light/30 border-y">
                    <form
                      onSubmit={(e) => { e.preventDefault(); submitPush(r); }}
                      className="flex flex-wrap items-center gap-3 text-sm"
                    >
                      <span className="font-bold text-xs">📤 Send {r.mo} to:</span>
                      <select
                        value={pushDept}
                        onChange={(e) => {
                          const d = e.target.value as Dept;
                          setPushDept(d);
                          setPushQty(Object.fromEntries(ITEMS.map((it) => [it, String(remainingFor(r, it, d))])));
                          setPushErr("");
                        }}
                        className="border rounded-md px-2 py-1 bg-surface text-sm font-semibold"
                        disabled={pending}
                      >
                        {DEPTS.map((d) => (
                          <option key={d} value={d}>{deptLabel(d)} worklist</option>
                        ))}
                      </select>
                      {ITEMS.filter((it) => r.items[it].eligible).map((it) => {
                        const max = remainingFor(r, it, pushDept);
                        return (
                          <label key={it} className={`inline-flex items-center gap-1 font-semibold ${max === 0 ? "opacity-40" : ""}`}>
                            {it}
                            <input
                              type="number"
                              min={0}
                              max={max}
                              value={pushQty[it] ?? ""}
                              onChange={(e) => { setPushQty((s) => ({ ...s, [it]: e.target.value })); setPushErr(""); }}
                              className="w-16 border rounded-md px-1 py-0.5 text-center tabnum bg-surface"
                              disabled={pending || max === 0}
                              title={max === 0 ? `${it}: nothing left for ${deptLabel(pushDept)}` : `${it}: up to ${max} pcs still open`}
                            />
                            <span className="text-[10px] text-muted tabnum">/{max}</span>
                          </label>
                        );
                      })}
                      <button type="submit" disabled={pending} className="rounded-md px-3 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                        Send
                      </button>
                      <button type="button" onClick={() => setOpenPush(null)} className="text-muted text-xs hover:underline">Cancel</button>
                      {pushErr && <span className="text-xs text-bad-fg font-semibold w-full">{pushErr}</span>}
                      <span className="text-[11px] text-muted w-full">
                        Quantities are capped at what the department still owes on this order. The line lands date-less on the chosen worklist — schedule it there (📅✎). Sending again replaces the previous push; all-zero clears it.
                      </span>
                    </form>
                  </td>
                </tr>
              )}
              {openConfig === r.mo && (
                <tr className={inGroup ? "border-x-2 border-brand" : ""}>
                  <td colSpan={32} className="p-3 bg-brand-light/30 border-y">
                    <form
                      onSubmit={(e) => { e.preventDefault(); saveExcluded(r, e.currentTarget); }}
                      className="flex flex-wrap items-center gap-4 text-sm max-w-2xl"
                    >
                      <span className="font-bold text-xs">Components {r.mo} actually needs:</span>
                      {ITEMS.filter((it) => r.items[it].eligible).map((it) => (
                        <label key={it} className="inline-flex items-center gap-1.5 font-semibold cursor-pointer">
                          <input type="checkbox" name="req" value={it} defaultChecked={!r.items[it].excluded} className="accent-[var(--brand)]" />
                          {it}
                        </label>
                      ))}
                      <button type="submit" disabled={pending} className="rounded-md px-3 py-1 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                        Save
                      </button>
                      <button type="button" onClick={() => setOpenConfig(null)} className="text-muted text-xs hover:underline">Cancel</button>
                      <span className="text-[11px] text-muted w-full">Unchecked components are N/A for this project: they leave the cut worklist and stop gating completion &amp; OTD.</span>
                    </form>
                  </td>
                </tr>
              )}
      </Fragment>
    );
  }
}

// stage sub-headers sit on the same tints as their data columns — readable
// in both themes (the old dark-green fill swallowed the muted header text)
function StageHead({ shp = false }: { shp?: boolean }) {
  return (
    <>
      <th className="p-1 font-medium" style={{ background: "var(--cut-tint)" }}>Fab</th>
      <th className="p-1 font-medium" style={{ background: "var(--weld-tint)" }}>Weld</th>
      {/* the core (CF) is never painted — its final stage is SHOT BLAST */}
      {shp ? (
        <th className="p-1 font-medium" style={{ background: "var(--shp-tint)" }} title="Shot Blast — the core's final stage after welding">SHB</th>
      ) : (
        <th className="p-1 font-medium" style={{ background: "var(--paint-tint)" }}>Paint</th>
      )}
      <th className="p-1 font-medium border-r" style={{ background: "var(--dlvd-tint)" }} title="Delivered — received by the customer">Dlvd</th>
    </>
  );
}

function StageCells({ cut, weld, paint, shp, delivered, excluded = false, noPaint = false }: { cut: number; weld: number; paint: number; shp: number; delivered: number; excluded?: boolean; noPaint?: boolean }) {
  if (excluded) {
    return (
      <>
        <td className="p-2 text-center text-muted">—</td>
        <td className="p-2 text-center text-muted">—</td>
        <td className="p-2 text-center text-muted">—</td>
        <td className="p-2 text-center text-muted border-r">—</td>
      </>
    );
  }
  return (
    <>
      <td className="p-2 text-center tabnum" style={{ background: "var(--cut-tint)" }}>{cut}</td>
      <td className="p-2 text-center tabnum" style={{ background: "var(--weld-tint)" }}>{weld}</td>
      {/* the core (CF) has no paint stage — SHOT BLAST is its final step */}
      {noPaint ? (
        <td className="p-2 text-center tabnum" style={{ background: "var(--shp-tint)" }}>{shp}</td>
      ) : (
        <td className="p-2 text-center tabnum" style={{ background: "var(--paint-tint)" }}>{paint}</td>
      )}
      <td className="p-2 text-center tabnum border-r" style={{ background: "var(--dlvd-tint)" }}>{delivered}</td>
    </>
  );
}
