"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Gauge, Plus, Tag, Timer } from "lucide-react";
import { upsertStdTier, deleteStdTier, setStageCapacity, upsertFgMap, deleteFgMap } from "./actions";
import { SearchBox } from "@/components/FilterControls";
import { deptLabel } from "@/lib/domain/constants";
import { Modal } from "@/components/Modal";
import { SectionCard } from "@/components/primitives";

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
  const [fgOpen, setFgOpen] = useState(false);
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
      className="w-20 px-1.5 py-1 text-center tabnum"
      disabled={pending}
    />
  );

  return (
    <div className="space-y-4">
      {err && <p className="alert alert-bad">{err}</p>}

      {/* ================= KVA classes ================= */}
      <SectionCard
        icon={Timer}
        title="KVA classes — man-hours per tank"
        description="What one tank of this class costs each stage. The report's earned hours and the plan capacity check are priced from these."
        padded={false}
        end={
          <button
            type="button"
            onClick={() => { setAdding(true); setEditKva(null); setDraft({ kva: "", cutMh: "", weldMh: "", shbMh: "", paintMh: "" }); }}
            disabled={pending}
            className="btn btn-secondary btn-sm"
          >
            <Plus size={14} aria-hidden /> KVA class
          </button>
        }
      >
        <div className="overflow-x-auto border-t">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-start ps-4 md:ps-5">KVA class</th>
                {STAGES.map((s) => <th key={s} className="text-center">{deptLabel(s)}</th>)}
                <th className="text-center">Total</th>
                <th className="text-end pe-4 md:pe-5 w-36"></th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const editing = editKva === t.kva;
                const total = t.cutMh + t.weldMh + t.shbMh + t.paintMh;
                return (
                  <tr key={t.kva} className="text-center">
                    <td className="text-start ps-4 md:ps-5 font-bold tabnum">{t.kva}</td>
                    {STAGES.map((s) => (
                      <td key={s} className="tabnum">
                        {editing ? numCell(STAGE_FIELD[s]) : fmt(t[STAGE_FIELD[s]])}
                      </td>
                    ))}
                    <td className="font-bold tabnum">{editing ? "…" : fmt(total)}</td>
                    <td className="text-end pe-4 md:pe-5 whitespace-nowrap">
                      {editing ? (
                        <span className="inline-flex gap-1">
                          <button onClick={() => saveTier(t.kva)} disabled={pending} className="btn btn-primary btn-sm">Save</button>
                          <button onClick={() => setEditKva(null)} disabled={pending} className="btn btn-ghost btn-sm">Cancel</button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1">
                          <button onClick={() => startEdit(t)} disabled={pending} className="btn btn-ghost btn-sm">Edit</button>
                          <button
                            onClick={() => {
                              const pointing = fgs.filter((f) => f.kva === t.kva).length;
                              if (!confirm(`Delete the ${t.kva} KVA class?${pointing ? ` ${pointing} FG code(s) point at it and will fall back to the order's numeric KVA.` : ""}`)) return;
                              const fd = new FormData();
                              fd.set("kva", String(t.kva));
                              run(deleteStdTier, fd);
                            }}
                            disabled={pending}
                            className="btn btn-ghost btn-sm text-bad-fg"
                          >
                            Delete
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 md:px-5 py-3 border-t text-xs text-muted">
          The split across components (CF/TC/TN/CB) follows the engineering shares automatically — edit the stage totals and every component follows. A new class borrows the nearest class&apos;s shares.
        </p>
        {adding && (
          <Modal title="Add a KVA class" sub="Man-hours one unit of this class takes at each stage." onClose={() => setAdding(false)} busy={pending} width="max-w-2xl">
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); saveTier(Number(draft.kva)); }}>
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="field-label">KVA class</span>
                  <input
                    type="number" min={1} required placeholder="e.g. 5000"
                    value={draft.kva ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, kva: e.target.value }))}
                    className="w-28 px-1.5 py-1 tabnum"
                    disabled={pending}
                  />
                </label>
                {STAGES.map((s) => (
                  <label key={s} className="block">
                    <span className="field-label">{deptLabel(s)}</span>
                    {numCell(STAGE_FIELD[s])}
                  </label>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t">
                <button type="button" onClick={() => setAdding(false)} disabled={pending} className="btn btn-ghost btn-sm">Cancel</button>
                <button type="submit" disabled={pending || !draft.kva} className="btn btn-primary btn-sm">Add</button>
              </div>
            </form>
          </Modal>
        )}
      </SectionCard>

      {/* ================= stage capacity ================= */}
      <SectionCard icon={Gauge} title="Stage capacity — man-hours per working day" description="What the weekly plan's required hours are measured against: people × shift hours.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {STAGES.map((s) => (
            <form
              key={s}
              className="rounded-lg border px-3 py-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                fd.set("dept", s);
                run(setStageCapacity, fd);
              }}
            >
              <span className="field-label">{deptLabel(s)}</span>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0} step="0.1" name="mhPerDay"
                  defaultValue={capacity[s] !== undefined ? fmt(capacity[s]) : ""}
                  placeholder="—"
                  aria-label={`${deptLabel(s)} man-hours per day`}
                  className="w-full min-w-0 px-2 py-1 text-center tabnum"
                  disabled={pending}
                />
                <span className="text-[11px] text-muted whitespace-nowrap">h/day</span>
                <button type="submit" disabled={pending} className="btn btn-secondary btn-sm">Save</button>
              </div>
            </form>
          ))}
        </div>
      </SectionCard>

      {/* ================= FG map ================= */}
      <SectionCard
        icon={Tag}
        title="FG code → KVA class"
        description="Outranks the order's numeric KVA — use it when a product belongs to a different class than its size suggests."
        padded={false}
        end={
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Search FG code…" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFgOpen(true)} disabled={pending}>
              <Plus size={14} aria-hidden /> FG code
            </button>
          </>
        }
      >
        {fgOpen && (
          <Modal title="Add or update an FG code" sub="Point an FG code at the KVA class it is costed as." onClose={() => setFgOpen(false)} busy={pending} width="max-w-lg">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData();
                fd.set("fg", fgNew.fg);
                fd.set("kva", fgNew.kva);
                run(upsertFgMap, fd, () => { setFgNew({ fg: "", kva: "" }); setFgOpen(false); });
              }}
            >
              <input
                value={fgNew.fg}
                onChange={(e) => setFgNew((v) => ({ ...v, fg: e.target.value }))}
                placeholder="FG-12345"
                aria-label="FG code"
                className="w-36 px-2 py-1.5 text-sm ltr"
                disabled={pending}
              />
              <select
                value={fgNew.kva}
                onChange={(e) => setFgNew((v) => ({ ...v, kva: e.target.value }))}
                aria-label="KVA class"
                className="px-2 py-1.5 text-sm"
                disabled={pending}
              >
                <option value="">KVA class…</option>
                {tiers.map((t) => <option key={t.kva} value={t.kva}>{t.kva}</option>)}
              </select>
              <button type="submit" disabled={pending || !fgNew.fg || !fgNew.kva} className="btn btn-primary btn-sm">Add / update</button>
            </form>
          </Modal>
        )}
        <div className="overflow-x-auto border-t">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-start ps-4 md:ps-5">FG code</th>
                <th className="text-center">KVA class</th>
                <th className="text-end pe-4 md:pe-5 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {shownFgs.length === 0 && (
                <tr><td colSpan={3} className="p-4 text-center text-muted">No codes match.</td></tr>
              )}
              {shownFgs.map((f) => (
                <tr key={f.fg}>
                  <td className="ps-4 md:ps-5 font-bold tabnum ltr">{f.fg}</td>
                  <td className="text-center tabnum">{f.kva}</td>
                  <td className="text-end pe-4 md:pe-5">
                    <button
                      onClick={() => {
                        if (!confirm(`Remove ${f.fg}? Its orders will fall back to their numeric KVA.`)) return;
                        const fd = new FormData();
                        fd.set("fg", f.fg);
                        run(deleteFgMap, fd);
                      }}
                      disabled={pending}
                      className="btn btn-ghost btn-sm text-bad-fg"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 md:px-5 py-2.5 border-t text-xs text-muted tabnum">{shownFgs.length < fgTotal ? `Showing ${shownFgs.length} of ${fgTotal} codes — search to narrow it` : `${fgTotal} code${fgTotal === 1 ? "" : "s"}`}</p>
      </SectionCard>
    </div>
  );
}
