"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExecRow } from "@/lib/domain/execution";
import { recordOutput } from "@/app/worklist/actions";
import { Num } from "@/components/ui";
import { SearchBox, FilterBar } from "@/components/FilterControls";
import { useMemo } from "react";

export function ExecutionTable({
  rows,
  dept,
  day,
  planNo,
}: {
  rows: ExecRow[];
  dept: "Cut" | "Welding";
  day: string; // ISO
  planNo: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.bom} ${r.mo} ${r.description}`.toUpperCase().includes(needle));
  }, [rows, q]);

  const keyOf = (r: ExecRow) => `${r.bom}|${r.mo}|${r.item}`;

  function save(r: ExecRow) {
    const k = keyOf(r);
    const v = qty[k];
    const n = Number(v);
    if (!v || !Number.isFinite(n) || n <= 0) {
      setMsg({ ...msg, [k]: "Enter a quantity > 0" });
      return;
    }
    const fd = new FormData();
    fd.set("date", day);
    fd.set("dept", dept);
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    fd.set("qty", String(n));
    fd.set("planNo", String(planNo));
    startTransition(async () => {
      const res = await recordOutput(fd);
      if (res.ok) {
        setQty((s) => ({ ...s, [k]: "" }));
        setMsg((s) => ({ ...s, [k]: "" }));
        setSavedFlash((s) => ({ ...s, [k]: true }));
        setTimeout(() => setSavedFlash((s) => ({ ...s, [k]: false })), 1800);
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [k]: res.error ?? "Failed" }));
      }
    });
  }

  const totalStill = filtered.reduce((s, r) => s + r.still, 0);

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={() => setQ("")} hasActive={!!q}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM…" />
        <span className="text-xs text-muted">
          Still due (shown lines): <b className="text-foreground tabnum">{totalStill}</b>
        </span>
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">Due (to date)</th>
              <th className="p-2 text-center">Done</th>
              <th className="p-2 text-center">Today</th>
              <th className="p-2 text-center">Still</th>
              {dept === "Welding" && <th className="p-2 text-center">Cut Ready</th>}
              <th className="p-2 text-center w-44">Record output</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={dept === "Welding" ? 10 : 9} className="p-4 text-center text-muted">
                {rows.length === 0 ? "Nothing due on this day." : "No lines match the search."}
              </td></tr>
            )}
            {filtered.map((r) => {
              const k = keyOf(r);
              const doneLine = r.still === 0;
              const blocked = dept === "Welding" && (r.cutReady ?? 0) === 0 && !doneLine;
              return (
                <tr key={k} className={doneLine ? "opacity-60" : ""}>
                  <td className="p-2 text-xs font-semibold whitespace-nowrap">{r.mo}</td>
                  <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                  <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
                  <td className="p-2 text-center font-bold">{r.item}</td>
                  <td className="p-2 text-center"><Num v={r.dueToDate} /></td>
                  <td className="p-2 text-center"><Num v={r.doneToDate} /></td>
                  <td className="p-2 text-center"><Num v={r.doneToday} /></td>
                  <td className="p-2 text-center font-extrabold tabnum" style={{ color: r.still > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>
                    {r.still}
                  </td>
                  {dept === "Welding" && (
                    <td className="p-2 text-center">
                      <span className={`pill ${(r.cutReady ?? 0) >= r.still && r.still > 0 ? "pill-ok" : (r.cutReady ?? 0) > 0 ? "pill-warn" : doneLine ? "pill-muted" : "pill-bad"}`}>
                        {r.cutReady ?? 0}
                      </span>
                    </td>
                  )}
                  <td className="p-2">
                    {doneLine ? (
                      <span className="pill pill-ok">✓ Done</span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={1}
                          placeholder="qty"
                          value={qty[k] ?? ""}
                          onChange={(e) => setQty((s) => ({ ...s, [k]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && save(r)}
                          className="w-16 border rounded-md px-1.5 py-1 text-center font-bold tabnum"
                          disabled={pending}
                        />
                        <button
                          type="button"
                          onClick={() => save(r)}
                          disabled={pending}
                          className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[k] ? "bg-ok-fill" : "bg-brand-fill hover:bg-brand-dark"} disabled:opacity-50`}
                          title={blocked ? "Nothing cut and ready yet — recording anyway is allowed" : "Save"}
                        >
                          {savedFlash[k] ? "✓ Saved" : "Save"}
                        </button>
                      </div>
                    )}
                    {msg[k] && <div className="text-[11px] text-bad-fg mt-0.5">{msg[k]}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">
        Every save writes a dated record to the daily logs — nothing else to fill in.
        {dept === "Cut" && " What Cut records lands in the welding queue immediately."}
      </p>
    </>
  );
}
