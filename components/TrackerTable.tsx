"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { TrackerRow } from "@/lib/domain/tracker";
import { pctStyle, Num } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { ITEMS } from "@/lib/domain/constants";

type Progress = "complete" | "inprogress" | "notstarted";

function progressOf(r: TrackerRow): Progress {
  if (r.required > 0 && r.complete >= r.required) return "complete";
  if (r.complete > 0) return "inprogress";
  return "notstarted";
}

export function TrackerTable({ rows, planNo }: { rows: TrackerRow[]; planNo: number }) {
  const [q, setQ] = useState("");
  const [progress, setProgress] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (needle && !(`${r.bom} ${r.moLabel} ${r.kva}`.toUpperCase().includes(needle))) return false;
      if (progress && progressOf(r) !== progress) return false;
      return true;
    });
  }, [rows, q, progress]);

  const hasActive = !!(q || progress);
  const reset = () => { setQ(""); setProgress(""); };

  const exportRows = filtered.map((r) => ({
    BOM: r.bom,
    MO: r.moLabel,
    KVA: r.kva,
    Required: r.required,
    "CF Cut": r.items.CF.cutDone, "CF Weld": r.items.CF.weldDone, "CF Paint": r.items.CF.paintDone,
    "TC Cut": r.items.TC.cutDone, "TC Weld": r.items.TC.weldDone, "TC Paint": r.items.TC.paintDone,
    "TN Cut": r.items.TN.cutDone, "TN Weld": r.items.TN.weldDone, "TN Paint": r.items.TN.paintDone,
    "CB Cut": r.items.CB.cutDone, "CB Weld": r.items.CB.weldDone, "CB Paint": r.items.CB.paintDone,
    Complete: r.complete,
    Left: r.remaining,
    "Achievement %": r.achievement === null ? "" : Math.round(r.achievement * 100),
  }));

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={reset} hasActive={hasActive}>
        <SearchBox value={q} onChange={setQ} placeholder="Search BOM / MO / KVA…" />
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
        <ExportButton rows={exportRows} filename={`plan-tracker-${planNo}.xlsx`} sheetName={`Plan ${planNo}`} />
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white">
              <th rowSpan={2} className="p-2 text-left">BOM</th>
              <th rowSpan={2} className="p-2 text-left">MO</th>
              <th rowSpan={2} className="p-2">KVA</th>
              <th rowSpan={2} className="p-2">Required</th>
              {ITEMS.map((it) => (
                <th key={it} colSpan={3} className="p-2 border-r border-white/25">{it}</th>
              ))}
              <th rowSpan={2} className="p-2 border-r border-white/25">Complete</th>
              <th rowSpan={2} className="p-2">Left</th>
              <th rowSpan={2} className="p-2">Achv.</th>
            </tr>
            <tr className="bg-brand text-white text-xs">
              {ITEMS.map((it) => (
                <CutWeldHead key={it} />
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={19} className="p-4 text-center text-muted">No rows match the filters.</td></tr>
            )}
            {filtered.map((r, i) => (
              <tr key={r.bom} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-2 font-bold whitespace-nowrap">
                  <Link href={`/trace?plan=${planNo}&bom=${encodeURIComponent(r.bom)}`} className="text-accent hover:underline">
                    {r.bom}
                  </Link>
                </td>
                <td className="p-2 text-xs whitespace-nowrap">{r.moLabel}</td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.kva}</td>
                <td className="p-2 text-center font-bold"><Num v={r.required} /></td>
                {ITEMS.map((it) => (
                  <CutWeldCells key={it} cut={r.items[it].cutDone} weld={r.items[it].weldDone} paint={r.items[it].paintDone} />
                ))}
                <td className="p-2 text-center font-extrabold border-r"><Num v={r.complete} /></td>
                <td className="p-2 text-center font-bold" style={{ color: r.remaining > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>
                  <Num v={r.remaining} />
                </td>
                <td className="p-2 text-center font-bold tabnum" style={pctStyle(r.achievement)}>
                  {r.achievement === null ? "—" : `${(r.achievement * 100).toFixed(0)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CutWeldHead() {
  return (
    <>
      <th className="p-1 font-medium bg-brand-dark">Cut</th>
      <th className="p-1 font-medium bg-brand-dark">Weld</th>
      <th className="p-1 font-medium bg-brand-dark border-r border-white/25">Paint</th>
    </>
  );
}

function CutWeldCells({ cut, weld, paint }: { cut: number; weld: number; paint: number }) {
  return (
    <>
      <td className="p-2 text-center tabnum" style={{ background: "var(--cut-tint)" }}>{cut}</td>
      <td className="p-2 text-center tabnum" style={{ background: "var(--weld-tint)" }}>{weld}</td>
      <td className="p-2 text-center tabnum border-r" style={{ background: "var(--paint-tint)" }}>{paint}</td>
    </>
  );
}
