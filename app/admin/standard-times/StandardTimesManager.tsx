"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertStdTier, deleteStdTier, setStageCapacity, upsertFgMap, deleteFgMap } from "./actions";
import { SearchBox } from "@/components/FilterControls";
import { deptLabel } from "@/lib/domain/constants";

/* Admin editor for everything the standard-hours features read:
   1. KVA classes — man-hours ONE tank costs each stage (feeds the report's
      earned hours and the weekly capacity check)
   2. Stage capacity — available man-hours per working day
   3. FG map — which KVA class an FG code belongs to (outranks the numeric KVA)
   Seeded from the engineering timings sheet; edits here replace re-importing it. */

interface Tier { kva: number; cutMh: number; weldMh: number; shbMh: number; paintMh: number }

const STAGES = ["Cut", "Welding", "ShotBlast", "Painting"] as const;
const STAGE_FIELD: Record<(typeof STAGES)[number], keyof Omit<Tier, "kva">> = {
  Cut: "cutMh", Welding: "weldMh", ShotBlast: "shbMh", Painting: "paintMh",
};
const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

export function StandardTimesManager({
  tiers, capacity, fgs,
}: {
  tiers: Tier[];
  capacity: Record<string, number>;
  fgs: { fg: string; kva: number }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");

  const run = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, after?: () => void) => {
    setErr("");
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) setErr(res.error ?? "Failed");
      else {
        after?.();
        router.refresh();
      }
    });
  };

  // ---- section 1: KVA classes ----
  const [editKva, setEditKva] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const startEdit = (t: Tier) => {
    setEditKva(t.kva);
    setDraft({ cutMh: fmt(t.cutMh), weldMh: fmt(t.weldMh), shbMh: fmt(t.shbMh), paintMh: fmt(t.paintMh) });
  };
  const saveTier = (kva: number) => {
    const fd = new FormData();
    fd.set("kva", String(kva));
    for (const f of ["cutMh", "weldMh", "shbMh", "paintMh"]) fd.set(f, draft[f] ?? "");
    run(upsertStdTier, fd, () => { setEditKva(null); setAdding(false); });
  };

  // ---- section 3: FG map ----
  const [q, setQ] = useState("");
  const [fgNew, setFgNew] = useState({ fg: "", kva: "" });
  const shownFgs = useMemo(() => {
    const needle = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const list = needle ? fgs.filter((f) => f.fg.includes(needle)) : fgs;
    return list.slice(0, 40);
  }, [fgs, q]);
  const fgTotal = useMemo(() => {
    const needle = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    return needle ? fgs.filter((f) => f.fg.includes(needle)).length : fgs.length;
  }, [fgs, q]);

  const numCell = (field: string) => (
    <input
      type="number" min={0} step="0.01"
      value={draft[field] ?? ""}
      onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
      className="w-20 border rounded-md px-1.5 py-1 text-center tabnum bg-surface"
      disabled={pending}
    />
  );

  return (
    <div className="space-y-6">
      {err && <p className="text-sm font-semibold text-bad-fg bg-bad-bg rounded-lg px-3 py-2">{err}</p>}

      {/* ================= KVA classes ================= */}
      <section>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2>KVA classes — man-hours per tank</h2>
          <span className="text-[11px] text-muted">
            what one tank of this class costs each stage · the report&apos;s earned hours and the plan capacity check are priced from these
          </span>
        </div>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th className="p-2 text-left">KVA class</th>
                {STAGES.map((s) => <th key={s} className="p-2">{deptLabel(s)}</th>)}
                <th className="p-2">Total</th>
                <th className="p-2 w-40"></th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const editing = editKva === t.kva;
                const total = t.cutMh + t.weldMh + t.shbMh + t.paintMh;
                return (
                  <tr key={t.kva} className="text-center">
                    <td className="p-2 text-left font-bold tabnum">{t.kva}</td>
                    {STAGES.map((s) => (
                      <td key={s} className="p-2 tabnum">
                        {editing ? numCell(STAGE_FIELD[s]) : fmt(t[STAGE_FIELD[s]])}
                      </td>
                    ))}
                    <td className="p-2 font-bold tabnum">{editing ? "…" : fmt(total)}</td>
                    <td className="p-2 whitespace-nowrap">
                      {editing ? (
                        <>
                          <button onClick={() => saveTier(t.kva)} disabled={pending} className="btn btn-primary btn-sm mr-1">Save</button>
                          <button onClick={() => setEditKva(null)} disabled={pending} className="btn btn-ghost btn-sm">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(t)} disabled={pending} className="text-accent text-xs font-semibold px-1.5 hover:underline">Edit</button>
                          <button
                            onClick={() => {
                              const pointing = fgs.filter((f) => f.kva === t.kva).length;
                              if (!confirm(`Delete the ${t.kva} KVA class?${pointing ? ` ${pointing} FG code(s) point at it and will fall back to the order's numeric KVA.` : ""}`)) return;
                              const fd = new FormData();
                              fd.set("kva", String(t.kva));
                              run(deleteStdTier, fd);
                            }}
                            disabled={pending}
                            className="text-bad-fg text-xs font-semibold px-1.5 hover:underline"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {adding && (
                <tr className="text-center bg-brand-light/30">
                  <td className="p-2 text-left">
                    <input
                      type="number" min={1} placeholder="e.g. 5000"
                      value={draft.kva ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, kva: e.target.value }))}
                      className="w-24 border rounded-md px-1.5 py-1 tabnum bg-surface"
                      disabled={pending}
                      autoFocus
                    />
                  </td>
                  {STAGES.map((s) => <td key={s} className="p-2">{numCell(STAGE_FIELD[s])}</td>)}
                  <td className="p-2">—</td>
                  <td className="p-2 whitespace-nowrap">
                    <button onClick={() => saveTier(Number(draft.kva))} disabled={pending} className="btn btn-primary btn-sm mr-1">Add</button>
                    <button onClick={() => setAdding(false)} disabled={pending} className="btn btn-ghost btn-sm">Cancel</button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!adding && (
          <button
            onClick={() => { setAdding(true); setEditKva(null); setDraft({ kva: "", cutMh: "", weldMh: "", shbMh: "", paintMh: "" }); }}
            disabled={pending}
            className="btn btn-secondary btn-sm mt-2"
          >
            + Add a KVA class
          </button>
        )}
        <p className="mt-1.5 text-[11px] text-muted">
          The split across components (CF/TC/TN/CB) follows the engineering shares automatically — edit the stage totals and every component follows. A new class borrows the nearest class&apos;s shares.
        </p>
      </section>

      {/* ================= stage capacity ================= */}
      <section>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2>Stage capacity — man-hours per working day</h2>
          <span className="text-[11px] text-muted">what the weekly plan&apos;s required hours are measured against (people × shift hours)</span>
        </div>
        <div className="flex flex-wrap gap-3">
          {STAGES.map((s) => (
            <form
              key={s}
              className="bg-surface border rounded-xl px-4 py-3 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                fd.set("dept", s);
                run(setStageCapacity, fd);
              }}
            >
              <span className="text-sm font-bold">{deptLabel(s)}</span>
              <input
                type="number" min={0} step="0.1" name="mhPerDay"
                defaultValue={capacity[s] !== undefined ? fmt(capacity[s]) : ""}
                placeholder="—"
                className="w-24 border rounded-md px-2 py-1 text-center tabnum bg-surface"
                disabled={pending}
              />
              <span className="text-[10px] text-muted">h/day</span>
              <button type="submit" disabled={pending} className="btn btn-secondary btn-sm">Save</button>
            </form>
          ))}
        </div>
      </section>

      {/* ================= FG map ================= */}
      <section>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2>FG code → KVA class</h2>
          <span className="text-[11px] text-muted">
            outranks the order&apos;s numeric KVA — use it when a product belongs to a different class than its size suggests
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <SearchBox value={q} onChange={setQ} placeholder="Search FG code…" />
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData();
              fd.set("fg", fgNew.fg);
              fd.set("kva", fgNew.kva);
              run(upsertFgMap, fd, () => setFgNew({ fg: "", kva: "" }));
            }}
          >
            <input
              value={fgNew.fg}
              onChange={(e) => setFgNew((v) => ({ ...v, fg: e.target.value }))}
              placeholder="FG-12345"
              className="w-36 border rounded-md px-2 py-1.5 text-sm bg-surface"
              disabled={pending}
            />
            <select
              value={fgNew.kva}
              onChange={(e) => setFgNew((v) => ({ ...v, kva: e.target.value }))}
              className="border rounded-md px-2 py-1.5 text-sm bg-surface"
              disabled={pending}
            >
              <option value="">KVA class…</option>
              {tiers.map((t) => <option key={t.kva} value={t.kva}>{t.kva}</option>)}
            </select>
            <button type="submit" disabled={pending || !fgNew.fg || !fgNew.kva} className="btn btn-primary btn-sm">Add / update</button>
          </form>
          <span className="text-xs text-muted tabnum">{shownFgs.length < fgTotal ? `${shownFgs.length} of ${fgTotal}` : `${fgTotal} codes`}</span>
        </div>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2">FG code</th>
                <th className="p-2 text-center">KVA class</th>
                <th className="p-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {shownFgs.length === 0 && (
                <tr><td colSpan={3} className="p-4 text-center text-muted">No codes match.</td></tr>
              )}
              {shownFgs.map((f) => (
                <tr key={f.fg}>
                  <td className="p-2 font-bold tabnum">{f.fg}</td>
                  <td className="p-2 text-center tabnum">{f.kva}</td>
                  <td className="p-2 text-right">
                    <button
                      onClick={() => {
                        if (!confirm(`Remove ${f.fg}? Its orders will fall back to their numeric KVA.`)) return;
                        const fd = new FormData();
                        fd.set("fg", f.fg);
                        run(deleteFgMap, fd);
                      }}
                      disabled={pending}
                      className="text-bad-fg text-xs font-semibold hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
