"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Timer } from "lucide-react";
import { ITEMS, ITEM_NAME } from "@/lib/domain/constants";
import { centreApplies, centreField } from "@/lib/domain/centreTimes";
import { DEPT_CENTRES, WORK_CENTRES, WORK_CENTRE_LABEL, round1, type WorkCentre } from "@/lib/domain/shifts";
import { Note, SectionCard, Tabs } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { saveCentreTimes } from "./actions";

// The planner's own hours ONE piece takes at each work centre, typed by hand,
// one KVA class at a time. An empty cell keeps the estimate — the stage's
// standard hours split over the centres the item routes through — shown as the
// placeholder. A typed figure replaces that estimate everywhere the app prices
// work: earned hours, efficiency, the load and the capacity check.

export interface CentreTimesProps {
  classes: number[];
  /** How each centre has really worked against its hours a piece lately. */
  pace?: { fromISO: string; centres: { centre: WorkCentre; days: number; efficiency: number | null }[] };
  /** kva → item → centre → hours a piece, as typed. */
  typed: Record<number, Record<string, Partial<Record<WorkCentre, number>>>>;
  /** kva → item → centre → the estimate, for the placeholder. */
  estimates: Record<number, Record<string, Record<WorkCentre, number>>>;
}

const key = centreField;
const minutes = (h: number) => Math.round(h * 60);
const fmt = (h: number) => String(Math.round(h * 100) / 100);

/** Fewer recorded days than this and the measured pace is not offered. */
const MIN_PACE_DAYS = 5;

export function CentreTimesManager({ classes, typed, estimates, pace }: CentreTimesProps) {
  const paceOf = (c: WorkCentre) => {
    const p = pace?.centres.find((x) => x.centre === c);
    return p && p.days >= MIN_PACE_DAYS && p.efficiency !== null && p.efficiency > 0 ? p : null;
  };
  const router = useRouter();
  const [kva, setKva] = useState(() => (classes.includes(1000) ? 1000 : classes[0]));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const valueOf = (item: string, c: WorkCentre) => draft[key(kva, item, c)] ?? (typed[kva]?.[item]?.[c] !== undefined ? String(typed[kva][item][c]) : "");
  const dirty = Object.keys(draft).length > 0;
  const typedCount = useMemo(() => Object.fromEntries(classes.map((k) => [k, Object.values(typed[k] ?? {}).reduce((s, r) => s + Object.keys(r).length, 0)])), [classes, typed]);

  const save = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(draft)) fd.set(k, v);
    setMsg(null);
    start(async () => {
      const res = await saveCentreTimes(fd);
      if (res.ok) {
        setDraft({});
        setMsg({ ok: true, text: `Saved — ${res.saved ?? 0} figure(s) set, ${res.cleared ?? 0} back on the estimate.` });
        router.refresh();
      } else setMsg({ ok: false, text: res.error ?? "Could not save." });
    });
  };

  /** What a cell counts: typed, else the estimate. */
  const effective = (item: string, c: WorkCentre) => {
    const v = valueOf(item, c);
    return v !== "" && Number.isFinite(Number(v)) ? Number(v) : (estimates[kva]?.[item]?.[c] ?? 0);
  };

  return (
    <SectionCard
      icon={<Timer size={16} aria-hidden />}
      title="Hours a piece, by work centre"
      description="What one piece of each item takes at each centre, typed by hand for each kVA class. An empty cell keeps the estimate shown in grey; a figure you type replaces it in every earned hour, efficiency, load and capacity figure. A painted part's Painting record earns its shot blast and its painting together. Calibration rescales the estimates only — typed figures stay as you typed them."
      padded={false}
    >
      <Tabs
        label="kVA class"
        className="px-2"
        items={classes.map((k) => ({ id: String(k), label: `${k} kVA`, count: typedCount[k] || undefined }))}
        value={String(kva)}
        onChange={(id) => setKva(Number(id))}
      />
      <TableFrame>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th label="Item" className="ps-4 md:ps-5" />
              {WORK_CENTRES.map((c) => {
                const p = paceOf(c);
                return <Th key={c} label={WORK_CENTRE_LABEL[c]} center full={`${WORK_CENTRE_LABEL[c]} — hours one piece takes`} hint={p ? `Measured since ${pace!.fromISO}: the floor worked at ${Math.round(p.efficiency! * 100)}% of these hours over ${p.days} recorded days, so a piece really took about ${Math.round((1 / p.efficiency!) * 100) / 100}× the figure. The ≈ under a cell is that figure; click it to take it.` : undefined} />;
              })}
              <Th label="Fabrication" num className="text-right pe-4" hint="Laser / punch + bending + fin folding: the item's whole fabrication stage." />
            </tr>
          </thead>
          <tbody>
            {ITEMS.map((item) => {
              const fab = DEPT_CENTRES.Cut.reduce((s, c) => s + effective(item, c), 0);
              return (
                <tr key={item}>
                  <td className="ps-4 md:ps-5 whitespace-nowrap"><span className="code-chip">{item}</span> <span className="text-muted ms-1">{ITEM_NAME[item]}</span></td>
                  {WORK_CENTRES.map((c) => {
                    if (!centreApplies(item, c)) {
                      return <td key={c} className="text-center text-muted" title={c === "Painting" ? "The core frame is not painted" : `A ${ITEM_NAME[item].toLowerCase()} does not pass this centre`}>—</td>;
                    }
                    const est = estimates[kva]?.[item]?.[c] ?? 0;
                    const v = valueOf(item, c);
                    return (
                      <td key={c} className="p-1 text-center align-top">
                        <input
                          type="number" min={0} step={0.05} inputMode="decimal"
                          value={v}
                          disabled={pending}
                          aria-label={`${ITEM_NAME[item]}, ${WORK_CENTRE_LABEL[c]}, ${kva} kVA: hours a piece`}
                          placeholder={est > 0 ? fmt(est) : "—"}
                          title={est > 0 ? `Estimate: ${fmt(est)} h (${minutes(est)} min) a piece` : "No estimate — a figure here is the only one there is"}
                          onChange={(e) => setDraft((d) => ({ ...d, [key(kva, item, c)]: e.target.value }))}
                          className={`ctl w-20 text-center tabnum ltr ${v ? "font-bold" : ""}`}
                        />
                        {v !== "" && Number(v) > 0 && <div className="text-xs text-muted tabnum">{minutes(Number(v))} min</div>}
                        {(() => {
                          const p = paceOf(c);
                          const now = effective(item, c);
                          if (!p || !(now > 0)) return null;
                          const real = Math.round((now / p.efficiency!) * 100) / 100;
                          return (
                            <button
                              type="button" disabled={pending}
                              onClick={() => setDraft((d) => ({ ...d, [key(kva, item, c)]: String(real) }))}
                              title={`Measured: the floor took about ${real} h a piece here (${Math.round(p.efficiency! * 100)}% pace over ${p.days} days). Click to take it.`}
                              className="block w-full text-xs tabnum text-brand-ink hover:underline"
                            >
                              ≈ {real}
                            </button>
                          );
                        })()}
                      </td>
                    );
                  })}
                  <td className="pe-4 text-right tabnum font-semibold">{fab > 0 ? round1(fab) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableFrame>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-5 border-t">
        <span className="text-xs text-muted">Hours for one piece · grey = the estimate · empty a cell to go back to it</span>
        <Note msg={msg} />
        {dirty && <button type="button" className="btn btn-ghost btn-sm ms-auto" disabled={pending} onClick={() => { setDraft({}); setMsg(null); }}>Undo changes</button>}
        <button type="button" className={`btn btn-primary btn-sm ${dirty ? "" : "ms-auto"}`} disabled={pending || !dirty} onClick={save}>
          <Save size={14} aria-hidden /> {pending ? "Saving…" : "Save times"}
        </button>
      </div>
    </SectionCard>
  );
}
