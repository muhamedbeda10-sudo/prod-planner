"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import { setOrderStatus, setExcludedItems } from "@/app/orders/actions";
import { pctStyle, Num } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { ITEMS } from "@/lib/domain/constants";

type Progress = "complete" | "inprogress" | "notstarted";

function progressOf(r: MasterTrackerRow): Progress {
  if (r.required > 0 && r.complete >= r.required) return "complete";
  if (r.complete > 0 || ITEMS.some((it) => r.items[it].cut > 0 || r.items[it].weld > 0)) return "inprogress";
  return "notstarted";
}

export function MasterTrackerTable({ rows }: { rows: MasterTrackerRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [progress, setProgress] = useState("");
  const [urgent, setUrgent] = useState("");
  const [status, setStatus] = useState("open"); // lifecycle: closed orders are hidden by default
  const [openConfig, setOpenConfig] = useState<string | null>(null); // per-MO "required components" editor

  function saveExcluded(mo: string, form: HTMLFormElement) {
    const fd = new FormData(form);
    const required = fd.getAll("req").map(String);
    const excluded = ITEMS.filter((it) => !required.includes(it)).join(",");
    const out = new FormData();
    out.set("mo", mo);
    out.set("excluded", excluded);
    startTransition(async () => {
      const r = await setExcludedItems(out);
      if (r.ok) {
        setOpenConfig(null);
        router.refresh();
      } else {
        alert(r.error ?? "Failed");
      }
    });
  }

  const closedCount = useMemo(() => rows.filter((r) => r.status === "closed").length, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.kva ?? ""}`.toUpperCase().includes(needle))) return false;
      if (progress && progressOf(r) !== progress) return false;
      if (urgent === "yes" && !r.urgent) return false;
      return true;
    });
  }, [rows, q, progress, urgent, status]);

  const hasActive = !!(q || progress || urgent || status !== "open");

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

  const exportRows = filtered.map((r) => ({
    MO: r.mo,
    BOM: r.bom,
    SOI: r.soi ?? "",
    Urgent: r.urgent ? "Yes" : "",
    KVA: r.kva ?? "",
    Required: r.required,
    "CF Cut": r.items.CF.cut, "CF Weld": r.items.CF.weld, "CF Paint": r.items.CF.paint,
    "TC Cut": r.items.TC.cut, "TC Weld": r.items.TC.weld, "TC Paint": r.items.TC.paint,
    "TN Cut": r.items.TN.cut, "TN Weld": r.items.TN.weld, "TN Paint": r.items.TN.paint,
    "CB Cut": r.items.CB.cut, "CB Weld": r.items.CB.weld, "CB Paint": r.items.CB.paint,
    OSP: ITEMS.filter((it) => r.items[it].osp > 0).map((it) => `${it}×${r.items[it].osp}`).join(" "),
    Welded: r.welded,
    "Complete (painted)": r.complete,
    Left: r.remaining,
    "Achievement %": r.achievement === null ? "" : Math.round(r.achievement * 100),
    Status: r.status,
  }));

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setProgress(""); setUrgent(""); setStatus("open"); }} hasActive={hasActive}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / KVA…" />
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

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white">
              <th rowSpan={2} className="p-2 text-left">MO</th>
              <th rowSpan={2} className="p-2 text-left">BOM</th>
              <th rowSpan={2} className="p-2">KVA</th>
              <th rowSpan={2} className="p-2">Required</th>
              {ITEMS.map((it) => (
                <th key={it} colSpan={3} className="p-2 border-r border-white/25">{it}</th>
              ))}
              <th rowSpan={2} className="p-2 border-r border-white/25">Complete</th>
              <th rowSpan={2} className="p-2">Left</th>
              <th rowSpan={2} className="p-2">Achv.</th>
              <th rowSpan={2} className="p-2 no-print">Status</th>
            </tr>
            <tr className="bg-brand text-white text-xs">
              {ITEMS.map((it) => (
                <StageHead key={it} />
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={20} className="p-4 text-center text-muted">
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

  function renderRow(r: MasterTrackerRow, inGroup = false, lastInGroup = false) {
    // frame: open groups get a clear border so their extent is obvious
    const frame = inGroup ? `bg-brand-light/10 border-x-2 border-brand ${lastInGroup ? "border-b-2" : ""}` : "";
    return (
      <Fragment key={r.mo}>
              <tr className={frame}>
                <td className={`p-2 font-bold whitespace-nowrap text-xs ${inGroup ? "pl-6" : ""}`}>
                  {inGroup && <span className="text-muted mr-1">↳</span>}
                  <Link href={`/trace?mo=${encodeURIComponent(r.mo)}`} className="text-accent hover:underline">{r.mo}</Link>
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
                <td className="p-2 text-center font-bold"><Num v={r.required} /></td>
                {ITEMS.map((it) => (
                  <StageCells key={it} cut={r.items[it].cut} weld={r.items[it].weld} paint={r.items[it].paint} excluded={r.items[it].excluded} />
                ))}
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
                      <button onClick={() => changeStatus(r.mo, "open")} disabled={pending} className="text-accent text-xs px-1.5 hover:underline">Reopen</button>
                    </>
                  ) : r.required > 0 && r.complete >= r.required ? (
                    <button onClick={() => changeStatus(r.mo, "closed")} disabled={pending} className="rounded-md px-2 py-0.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50">
                      ✓ Close
                    </button>
                  ) : (
                    <span className="pill pill-ok">Open</span>
                  )}
                  <button
                    onClick={() => setOpenConfig(openConfig === r.mo ? null : r.mo)}
                    disabled={pending}
                    className="text-muted text-xs px-1.5 hover:text-accent"
                    title="Which components does this project actually need?"
                  >
                    ⚙
                  </button>
                </td>
              </tr>
              {openConfig === r.mo && (
                <tr className={inGroup ? "border-x-2 border-brand" : ""}>
                  <td colSpan={20} className="p-3 bg-brand-light/30 border-y">
                    <form
                      onSubmit={(e) => { e.preventDefault(); saveExcluded(r.mo, e.currentTarget); }}
                      className="flex flex-wrap items-center gap-4 text-sm max-w-2xl"
                    >
                      <span className="font-bold text-xs">Components {r.mo} actually needs:</span>
                      {ITEMS.map((it) => (
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

function StageHead() {
  return (
    <>
      <th className="p-1 font-medium bg-brand-dark">Cut</th>
      <th className="p-1 font-medium bg-brand-dark">Weld</th>
      <th className="p-1 font-medium bg-brand-dark border-r border-white/25">Paint</th>
    </>
  );
}

function StageCells({ cut, weld, paint, excluded = false }: { cut: number; weld: number; paint: number; excluded?: boolean }) {
  if (excluded) {
    return (
      <>
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
      <td className="p-2 text-center tabnum border-r" style={{ background: "var(--paint-tint)" }}>{paint}</td>
    </>
  );
}
