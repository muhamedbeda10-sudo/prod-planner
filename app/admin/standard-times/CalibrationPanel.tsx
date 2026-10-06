"use client";

import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyCalibration } from "./actions";
import { deptLabel } from "@/lib/domain/constants";

/* Calibration: the supervisors' shift log says how many man-hours each stage
   ACTUALLY worked per day; against the std-hours the ledger says those days
   earned, each stage gets an efficiency reading and a one-click rescale of
   its standard times. */

const STAGES = ["Cut", "Welding", "ShotBlast", "Painting"] as const;

export interface DayRow { dateISO: string; hours: Partial<Record<(typeof STAGES)[number], number>> }
export interface StageCal {
  dept: (typeof STAGES)[number];
  days: number;
  actualH: number;
  earnedH: number;
  efficiency: number | null;
  factor: number | null;
  ready: boolean;
  reason: string | null;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en");

export function CalibrationPanel({ rows, stages, windowDays }: { rows: DayRow[]; stages: StageCal[]; windowDays: number }) {
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

  return (
    <div className="space-y-6">
      {err && <p className="text-sm font-semibold text-bad-fg bg-bad-bg rounded-lg px-3 py-2">{err}</p>}

      {/* ================= calibration readings ================= */}
      <section>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2>Calibration — are the standard times this plant&apos;s real pace?</h2>
          <span className="text-[11px] text-muted">
            recorded hours vs earned std-hours over the last {windowDays} days · apply rescales that stage across every KVA class
          </span>
        </div>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th className="p-2 text-left">Stage</th>
                <th className="p-2">Recorded days</th>
                <th className="p-2">Worked (mh)</th>
                <th className="p-2">Earned (std-h)</th>
                <th className="p-2">Efficiency</th>
                <th className="p-2">Suggested factor</th>
                <th className="p-2 w-40"></th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => (
                <tr key={s.dept} className="text-center">
                  <td className="p-2 text-left font-bold">{deptLabel(s.dept)}</td>
                  <td className="p-2 tabnum">{s.days}</td>
                  <td className="p-2 tabnum">{s.days ? fmt(s.actualH) : "—"}</td>
                  <td className="p-2 tabnum">{s.days ? fmt(s.earnedH) : "—"}</td>
                  <td className={`p-2 tabnum font-bold ${s.efficiency === null ? "" : s.efficiency >= 0.95 && s.efficiency <= 1.05 ? "text-ok-fg" : "text-warn-fg"}`}>
                    {s.efficiency === null ? "—" : `${Math.round(s.efficiency * 100)}%`}
                  </td>
                  <td className="p-2 tabnum">{s.factor === null ? "—" : `× ${(Math.round(s.factor * 1000) / 1000).toFixed(3)}`}</td>
                  <td className="p-2">
                    {s.ready && s.factor !== null ? (
                      Math.abs(s.factor - 1) < 0.005 ? (
                        <span className="text-xs text-ok-fg font-semibold">calibrated ✓</span>
                      ) : (
                        <button
                          onClick={() => {
                            if (!confirm(`Multiply every KVA class's ${deptLabel(s.dept)} hours by ${(Math.round(s.factor! * 1000) / 1000).toFixed(3)}? Every report, capacity check and forecast reprices immediately.`)) return;
                            const fd = new FormData();
                            fd.set("dept", s.dept);
                            run(applyCalibration, fd);
                          }}
                          disabled={pending}
                          className="btn btn-primary btn-sm"
                        >
                          Apply suggestion
                        </button>
                      )
                    ) : (
                      <span className="text-[11px] text-muted">{s.reason ?? ""}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          Efficiency 80% means the crews worked 100 hours for every 80 standard hours earned — the standards are tighter than this plant&apos;s pace. Applying the factor makes future earned hours track the real effort; after applying, the reading here converges to 100%.
        </p>
      </section>

      {/* ================= daily recordings ================= */}
      <section>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2>Actual work-hours — from the shift log</h2>
          <span className="text-[11px] text-muted">
            summed per stage from what each department&apos;s supervisor records on the{" "}
            <Link href="/shifts" className="text-accent font-semibold hover:underline">Shift log</Link> — present workers × their shift + overtime
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No day recorded yet — the shift log fills this in.</p>
        ) : (
          <div className="bg-surface border rounded-xl overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-center">
                  <th className="p-2 text-left">Day</th>
                  {STAGES.map((s) => <th key={s} className="p-2">{deptLabel(s)}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 14).map((r) => (
                  <tr key={r.dateISO} className="text-center">
                    <td className="p-2 text-left font-bold tabnum">{formatDate(r.dateISO)}</td>
                    {STAGES.map((s) => (
                      <td key={s} className="p-2 tabnum">
                        {r.hours[s] !== undefined ? (
                          <Link href={`/shifts?dept=${s}&day=${r.dateISO}`} className="hover:underline" title="Open this day on the shift log">{fmt(r.hours[s]!)}</Link>
                        ) : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 14 && <p className="mt-1 text-[11px] text-muted">Showing the latest 14 of {rows.length} recorded days — older days still count in the calibration.</p>}
      </section>
    </div>
  );
}
