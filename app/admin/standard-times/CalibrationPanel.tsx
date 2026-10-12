"use client";

import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Activity, Clock } from "lucide-react";
import { applyCalibration } from "./actions";
import { deptLabel } from "@/lib/domain/constants";
import { EmptyState, SectionCard } from "@/components/primitives";

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
    <div className="space-y-4">
      {err && <p className="alert alert-bad">{err}</p>}

      {/* ================= calibration readings ================= */}
      <SectionCard
        icon={Activity}
        title="Calibration — are the standard times this plant's real pace?"
        description={`Recorded hours against earned standard hours over the last ${windowDays} days. Applying a factor rescales that stage across every KVA class.`}
        padded={false}
      >
        <div className="overflow-x-auto border-t">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-start ps-4 md:ps-5">Stage</th>
                <th className="text-center">Recorded days</th>
                <th className="text-center">Worked (mh)</th>
                <th className="text-center">Earned (std-h)</th>
                <th className="text-center">Efficiency</th>
                <th className="text-center">Suggested factor</th>
                <th className="text-end pe-4 md:pe-5 w-44"></th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => (
                <tr key={s.dept} className="text-center">
                  <td className="text-start ps-4 md:ps-5 font-bold">{deptLabel(s.dept)}</td>
                  <td className="tabnum">{s.days}</td>
                  <td className="tabnum">{s.days ? fmt(s.actualH) : "—"}</td>
                  <td className="tabnum">{s.days ? fmt(s.earnedH) : "—"}</td>
                  <td className={`tabnum font-bold ${s.efficiency === null ? "" : s.efficiency >= 0.95 && s.efficiency <= 1.05 ? "text-ok-fg" : "text-warn-fg"}`}>
                    {s.efficiency === null ? "—" : `${Math.round(s.efficiency * 100)}%`}
                  </td>
                  <td className="tabnum">{s.factor === null ? "—" : `× ${(Math.round(s.factor * 1000) / 1000).toFixed(3)}`}</td>
                  <td className="text-end pe-4 md:pe-5">
                    {s.ready && s.factor !== null ? (
                      Math.abs(s.factor - 1) < 0.005 ? (
                        <span className="pill pill-ok">Calibrated</span>
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
        <p className="px-4 md:px-5 py-3 border-t text-xs text-muted">
          Efficiency 80% means the crews worked 100 hours for every 80 standard hours earned — the standards are tighter than this plant&apos;s pace. Applying the factor makes future earned hours track the real effort; after applying, the reading here converges to 100%.
        </p>
      </SectionCard>

      {/* ================= daily recordings ================= */}
      <SectionCard
        icon={Clock}
        title="Actual work-hours — from the shift log"
        description={
          <>
            Summed per stage from what each department&apos;s supervisor records on the{" "}
            <Link href="/shifts" className="text-brand font-semibold hover:underline">Shift log</Link> — present workers × their shift + overtime.
          </>
        }
        padded={false}
      >
        {rows.length === 0 ? (
          <EmptyState compact icon={Clock} title="No day recorded yet" hint="The shift log fills this in." />
        ) : (
          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-start ps-4 md:ps-5">Day</th>
                  {STAGES.map((s) => <th key={s} className="text-center">{deptLabel(s)}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 14).map((r) => (
                  <tr key={r.dateISO} className="text-center">
                    <td className="text-start ps-4 md:ps-5 font-bold tabnum">{formatDate(r.dateISO)}</td>
                    {STAGES.map((s) => (
                      <td key={s} className="tabnum">
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
        {rows.length > 14 && <p className="px-4 md:px-5 py-2.5 border-t text-xs text-muted">Showing the latest 14 of {rows.length} recorded days — older days still count in the calibration.</p>}
      </SectionCard>
    </div>
  );
}
