"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ITEMS } from "@/lib/domain/constants";
import { CENTER_LABEL, SHIFT_DEPTS, machineWord, type ShiftDept } from "@/lib/domain/shifts";
import { deptLabel } from "@/lib/domain/constants";
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {SHIFT_DEPTS.map((d) => (
          <Link
            key={d}
            href={`${path}?dept=${d}`}
            className={`btn btn-sm ${d === dept ? "btn-primary" : "btn-ghost"}`}
            scroll={false}
          >
            {deptLabel(d)}
          </Link>
        ))}
        <span className="text-xs text-muted ms-auto">
          Hours ONE piece takes on that {machineWord(dept)}. Empty = the standard time (which follows the kVA class).
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">No {machineWord(dept, true)} on the list for {deptLabel(dept)} yet — add them in Tools → Machines.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-[11px] uppercase tracking-wide text-muted border-b">
                <th className="p-2 text-start">{machineWord(dept)}</th>
                <th className="p-2 text-start">Work centre</th>
                <th className="p-2 text-center">h / day</th>
                {ITEMS.map((item) => <th key={item} className="p-2 text-center">{item}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2 whitespace-nowrap"><b className="ltr tabnum">{m.code}</b> <span className="text-muted">{m.name}</span></td>
                  <td className="p-2 text-xs text-muted whitespace-nowrap">{CENTER_LABEL[m.center] ?? m.center}</td>
                  <td className="p-2 text-center tabnum text-xs">{m.hoursPerDay ?? "—"}</td>
                  {ITEMS.map((item) => {
                    const est = estimates[m.id]?.[item];
                    const v = valueOf(m.id, item);
                    return (
                      <td key={item} className="p-1 text-center">
                        <input
                          type="number" min={0} step={0.05} inputMode="decimal"
                          value={v}
                          disabled={!canEdit || pending}
                          placeholder={est ? String(Math.round(est * 100) / 100) : "—"}
                          title={est ? `The estimate for a mid-size tank is ${Math.round(est * 100) / 100} h (${minutes(est)} min) a piece` : "No standard time for this item — a figure here is the only one there is"}
                          onChange={(e) => setDraft((d) => ({ ...d, [key(m.id, item)]: e.target.value }))}
                          className={`border rounded-md px-1 py-1 bg-surface text-sm tabnum w-20 text-center ltr ${v ? "font-bold" : "text-muted"}`}
                        />
                        {v && Number(v) > 0 && <div className="text-[10px] text-muted tabnum">{minutes(Number(v))} min</div>}
                        {(() => {
                          const mm = measured[m.id]?.[item];
                          if (!mm) return null;
                          const same = v && Math.abs(Number(v) - mm.hoursPerPc) < 0.005;
                          return (
                            <button
                              type="button"
                              disabled={!canEdit || pending || !!same}
                              onClick={() => setDraft((d) => ({ ...d, [key(m.id, item)]: String(mm.hoursPerPc) }))}
                              title={`Measured: ${mm.pieces} pcs over ${mm.hours} man-hours on ${mm.days} day(s) — ${minutes(mm.hoursPerPc)} min a piece. Click to take it as the figure.`}
                              className={`block w-full text-[10px] tabnum ${same ? "text-ok-fg" : "text-accent hover:underline cursor-pointer"}`}
                            >
                              {same ? "✓ " : "≈ "}{mm.hoursPerPc} <span className="text-muted">({mm.pieces} pcs)</span>
                            </button>
                          );
                        })()}
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
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-primary" disabled={pending || !dirty} onClick={save}>
            {pending ? "Saving…" : "Save times"}
          </button>
          {dirty && <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => { setDraft({}); setMsg(null); }}>Undo changes</button>}
          {msg && <span className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}
