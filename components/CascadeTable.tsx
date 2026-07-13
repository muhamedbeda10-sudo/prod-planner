"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CascadeRow } from "@/lib/domain/execution";
import { recordOutput } from "@/app/worklist/actions";
import { Num } from "@/components/ui";
import { SearchBox, FilterBar } from "@/components/FilterControls";

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function CascadeTable({
  rows,
  day,
  planNo,
  hideFilter = false, // the cut page has ONE shared filter above all tables
}: {
  rows: CascadeRow[];
  day: string; // ISO (today — computed by the app)
  planNo: number;
  hideFilter?: boolean;
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

  const keyOf = (r: CascadeRow) => `${r.bom}|${r.mo}|${r.item}`;
  const totalPool = filtered.reduce((s, r) => s + r.available, 0);

  // shared BOMs: one summary row per BOM × item, expandable to its MOs
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (gk: string) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(gk)) n.delete(gk);
      else n.add(gk);
      return n;
    });
  const groups = useMemo(() => {
    const map = new Map<string, CascadeRow[]>();
    for (const r of filtered) {
      const gk = `${r.bom}|${r.item}`;
      if (!map.has(gk)) map.set(gk, []);
      map.get(gk)!.push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  function save(r: CascadeRow) {
    const k = keyOf(r);
    const n = Number(qty[k]);
    if (!qty[k] || !Number.isFinite(n) || n <= 0) {
      setMsg((s) => ({ ...s, [k]: "Enter a quantity > 0" }));
      return;
    }
    const fd = new FormData();
    fd.set("date", day);
    fd.set("dept", "Cut");
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

  return (
    <>
      {!hideFilter && (
        <FilterBar count={filtered.length} total={rows.length} onReset={() => setQ("")} hasActive={!!q}>
          <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM…" />
          <span className="text-xs text-muted">
            Open backlog pool (shown): <b className="text-foreground tabnum">{totalPool}</b> pcs
          </span>
        </FilterBar>
      )}

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-accent-gray/90 text-white text-left">
              <th className="p-2">Deliver on</th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">Week target</th>
              <th className="p-2 text-center">Scheduled</th>
              <th className="p-2 text-center">Done</th>
              <th className="p-2 text-center">Pool</th>
              <th className="p-2 text-center w-44">Pull &amp; record</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No unscheduled backlog — everything is on the schedule." : "No lines match the search."}
              </td></tr>
            )}
            {groups.map(([gk, members]) => {
              if (members.length === 1) return renderRow(members[0]);
              const open = openGroups.has(gk);
              const [gBom, gItem] = gk.split("|");
              const gDesc = members.find((m) => m.description)?.description ?? "";
              const sum = (f: (r: CascadeRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const minDel = members.map((m) => m.deliveryISO).filter((d): d is string => !!d).sort()[0] ?? null;
              return (
                <Fragment key={`g|${gk}`}>
                  <tr
                    className="cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold"
                    onClick={() => toggleGroup(gk)}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM"}
                  >
                    <td className="p-2 whitespace-nowrap">
                      {minDel ? (
                        <span className={`pill ${minDel < day ? "pill-bad" : minDel === day ? "pill-warn" : "pill-ok"}`}>📅 {ddmm(minDel)}</span>
                      ) : (
                        <span className="pill pill-muted">—</span>
                      )}
                    </td>
                    <td className="p-2 text-xs font-bold whitespace-nowrap">
                      <span className={`inline-block mr-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
                      {members.length} MOs
                    </td>
                    <td className="p-2 font-bold whitespace-nowrap">{gBom}</td>
                    <td className="p-2 text-xs text-muted whitespace-nowrap">{gDesc}</td>
                    <td className="p-2 text-center font-bold">{gItem}</td>
                    <td className="p-2 text-center font-bold"><Num v={sum((r) => r.target)} /></td>
                    <td className="p-2 text-center font-bold"><Num v={sum((r) => r.scheduled)} /></td>
                    <td className="p-2 text-center font-bold"><Num v={sum((r) => r.done)} /></td>
                    <td className="p-2 text-center font-extrabold tabnum" style={{ color: "var(--warn-fg)" }}>{sum((r) => r.available)}</td>
                    <td className="p-2 text-center text-xs text-muted whitespace-nowrap">{open ? "▲ collapse" : "▼ open MOs"}</td>
                  </tr>
                  {open && members.map((m) => renderRow(m, true))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">
        Backlog not on this week&apos;s schedule — pull from it any time; recorded output shrinks the pool and flows to the welding queue like any cut. Shared BOMs show as one row — click it to open the MOs inside.
      </p>
    </>
  );

  function renderRow(r: CascadeRow, inGroup = false) {
    const k = keyOf(r);
    return (
                <tr key={k} className={inGroup ? "bg-brand-light/10" : ""}>
                  <td className="p-2 whitespace-nowrap">
                    {r.deliveryISO ? (
                      <span className={`pill ${r.deliveryISO < day ? "pill-bad" : r.deliveryISO === day ? "pill-warn" : "pill-ok"}`}>
                        📅 {ddmm(r.deliveryISO)}
                      </span>
                    ) : (
                      <span className="pill pill-muted">—</span>
                    )}
                  </td>
                  <td className={`p-2 text-xs font-semibold whitespace-nowrap ${inGroup ? "pl-6" : ""}`}>
                    {inGroup && <span className="text-muted mr-1">↳</span>}
                    {r.mo}
                  </td>
                  <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                  <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
                  <td className="p-2 text-center font-bold">{r.item}</td>
                  <td className="p-2 text-center"><Num v={r.target} /></td>
                  <td className="p-2 text-center"><Num v={r.scheduled} /></td>
                  <td className="p-2 text-center"><Num v={r.done} /></td>
                  <td className="p-2 text-center font-extrabold tabnum" style={{ color: "var(--warn-fg)" }}>{r.available}</td>
                  <td className="p-2">
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
                        className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[k] ? "bg-ok-fg" : "bg-brand hover:bg-brand-dark"} disabled:opacity-50`}
                      >
                        {savedFlash[k] ? "✓ Saved" : "Save"}
                      </button>
                    </div>
                    {msg[k] && <div className="text-[11px] text-bad-fg mt-0.5">{msg[k]}</div>}
                  </td>
                </tr>
    );
  }
}
