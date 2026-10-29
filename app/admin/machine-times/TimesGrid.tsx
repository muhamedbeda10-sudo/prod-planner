"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Save } from "lucide-react";
import { ITEMS } from "@/lib/domain/constants";
import { CENTER_LABEL, SHIFT_DEPTS, machineWord, type ShiftDept } from "@/lib/domain/shifts";
import { deptLabel } from "@/lib/domain/constants";
import { EmptyState, Note, Tabs } from "@/components/primitives";
import { saveMachineItemTimes } from "./actions";

// The planner's own time per piece: one row per machine, one column per item.
// A cell left empty keeps that machine on the standard-times estimate — which
// follows the tank's kVA class — and the estimate for a mid-size tank is shown
// under the column head so a typed figure can be compared with it.

export interface TimeMachine {
  id: number;
  code: string;
  name: string;
  dept: string;
  center: string;
  hoursPerDay: number | null;
  active: boolean;
}

const minutes = (h: number) => Math.round(h * 60);

export interface Measured {
  pieces: number;
  hours: number;
  hoursPerPc: number;
  days: number;
}

export function TimesGrid({ machines, times, estimates, measured = {}, canEdit }: {
  machines: TimeMachine[];
  /** machineId → item → hours a piece, as saved. */
  times: Record<number, Record<string, number>>;
  /** The estimate a machine's centre carries for a mid-size tank, for comparison. */
  estimates: Record<number, Record<string, number>>;
  /** machineId → item → what the floor actually did. */
  measured?: Record<number, Record<string, Measured>>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const dept = (SHIFT_DEPTS as readonly string[]).includes(sp.get("dept") ?? "") ? (sp.get("dept") as ShiftDept) : "Cut";
  const rows = useMemo(() => machines.filter((m) => m.dept === dept && m.active), [machines, dept]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const key = (id: number, item: string) => `t:${id}:${item}`;
  const valueOf = (id: number, item: string) => draft[key(id, item)] ?? (times[id]?.[item] !== undefined ? String(times[id][item]) : "");
  const dirty = Object.keys(draft).length > 0;

  const save = () => {
    const fd = new FormData();
    for (const m of rows) for (const item of ITEMS) fd.set(key(m.id, item), valueOf(m.id, item));
    setMsg(null);
    start(async () => {
      const res = await saveMachineItemTimes(fd);
      if (res.ok) {
        setDraft({});
        setMsg({ ok: true, text: `Saved — ${res.saved ?? 0} figure(s) kept, ${res.cleared ?? 0} back on the estimate.` });
        router.refresh();
      } else setMsg({ ok: false, text: res.error ?? "Failed to save." });
    });
  };

  return (
    <div>
      <Tabs
        label="Department"
        className="px-2"
        items={SHIFT_DEPTS.map((d) => ({ id: d, label: deptLabel(d), count: machines.filter((m) => m.dept === d && m.active).length }))}
        value={dept}
        onChange={(id) => router.push(`${path}?dept=${id}`, { scroll: false })}
        end={<span className="text-xs text-muted pe-2 hidden md:inline">Hours one piece takes on that {machineWord(dept)} · empty = the standard time</span>}
      />

      {rows.length === 0 ? (
        <EmptyState compact icon={Save} title={`No ${machineWord(dept, true)} for ${deptLabel(dept)} yet`} hint="Add them under Machines & lines." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-start ps-4 md:ps-5">{machineWord(dept)}</th>
                <th className="text-start">Work centre</th>
                <th className="text-center">h / day</th>
                {ITEMS.map((item) => <th key={item} className="text-center">{item}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="ps-4 md:ps-5 whitespace-nowrap"><span className="code-chip">{m.code}</span> <span className="text-muted ms-1">{m.name}</span></td>
                  <td className="text-xs text-muted whitespace-nowrap">{CENTER_LABEL[m.center] ?? m.center}</td>
                  <td className="text-center tabnum text-xs">{m.hoursPerDay ?? "—"}</td>
                  {ITEMS.map((item) => {
                    const est = estimates[m.id]?.[item];
                    const v = valueOf(m.id, item);
                    const mm = measured[m.id]?.[item];
                    const same = !!mm && !!v && Math.abs(Number(v) - mm.hoursPerPc) < 0.005;
                    return (
                      <td key={item} className="p-1 text-center align-top">
                        <input
                          type="number" min={0} step={0.05} inputMode="decimal"
                          value={v}
                          disabled={!canEdit || pending}
                          placeholder={est ? String(Math.round(est * 100) / 100) : "—"}
                          title={est ? `The estimate for a mid-size tank is ${Math.round(est * 100) / 100} h (${minutes(est)} min) a piece` : "No standard time for this item — a figure here is the only one there is"}
                          onChange={(e) => setDraft((d) => ({ ...d, [key(m.id, item)]: e.target.value }))}
                          className={`px-1 py-1 text-sm tabnum w-20 text-center ltr ${v ? "font-bold" : "text-muted"}`}
                        />
                        {v && Number(v) > 0 && <div className="text-[11px] text-muted tabnum">{minutes(Number(v))} min</div>}
                        {mm && (
                          <button
                            type="button"
                            disabled={!canEdit || pending || same}
                            onClick={() => setDraft((d) => ({ ...d, [key(m.id, item)]: String(mm.hoursPerPc) }))}
                            title={`Measured: ${mm.pieces} pcs over ${mm.hours} man-hours on ${mm.days} day(s) — ${minutes(mm.hoursPerPc)} min a piece. Click to take it as the figure.`}
                            className={`block w-full text-[11px] tabnum ${same ? "text-ok-fg" : "text-brand-ink hover:underline cursor-pointer"}`}
                          >
                            {same ? "✓ " : "≈ "}{mm.hoursPerPc} <span className="text-muted">({mm.pieces} pcs)</span>
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-5 border-t">
          <Note msg={msg} />
          {dirty && <button type="button" className="btn btn-ghost btn-sm ms-auto" disabled={pending} onClick={() => { setDraft({}); setMsg(null); }}>Undo changes</button>}
          <button type="button" className={`btn btn-primary btn-sm ${dirty ? "" : "ms-auto"}`} disabled={pending || !dirty} onClick={save}>
            <Save size={14} aria-hidden /> {pending ? "Saving…" : "Save times"}
          </button>
        </div>
      )}
    </div>
  );
}
