"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Bullet, ChartCard, StatTile, fmt, pctOrDash } from "@/components/charts/kit";
import { EmptyState } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { stopDurationLabel } from "@/lib/domain/downtime";
import { formatDate } from "@/lib/domain/format";
import type { FloorPeriod } from "@/lib/server/kpis";

// The transformers' Production dashboard beyond the floor's figures: the
// machines (the stops still open, the machines that stood still the most)
// and quality & rework (the tanks' leak test and waits while tanks are
// tracked piece by piece, the pieces sent back). Read from the same period
// as the Floor performance section (getFloorPeriod).

const dOrDash = (v: number | null) => (v === null ? "—" : `${fmt(v, 1)} d`);
/** A wait's line under its median: how many tanks, and the longest. */
const cycleSub = (c: { n: number; maxDays: number | null }) => `median · ${c.n} tanks${c.maxDays !== null ? ` · max ${fmt(c.maxDays, 0)} d` : ""}`;

export function ProductionExtras({ period }: { period: FloorPeriod }) {
  const { stops, quality: q } = period;
  const t = q.tanks;
  return (
    <div className="grid gap-3 xl:grid-cols-12">
      <ChartCard
        className="xl:col-span-6"
        title="Which machines stand still?"
        sub="The stops still open now, with the time stopped so far, and the machines that lost the most unplanned hours in the period. A stop is recorded on the machine, by department — the punches carry the panels too, so a stop is never one line's."
        table={{ rows: [
          ...stops.open.map((s) => ({ Row: "Open now", Machine: s.machine, Department: s.dept, Since: s.sinceISO, Hours: s.hours, Cause: s.cause, Stops: 1 })),
          ...stops.byMachine.map((m) => ({ Row: "Most stopped", Machine: m.machine, Department: m.dept, Since: "", Hours: m.hours, Cause: "", Stops: m.stops })),
        ] }}
      >
        {stops.open.length === 0 && stops.byMachine.length === 0 ? (
          <EmptyState compact icon={Info} title="No machine stopped" hint={<>Nothing is stopped now and no unplanned stop was recorded in the period. Stops are recorded on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts → Machine stops</Link>.</>} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-bold text-muted mb-1">Stopped now</h3>
              {stops.open.length === 0 ? <p className="text-sm text-ok-fg font-semibold">Nothing is stopped now.</p> : (
                <ul className="space-y-1.5 text-sm">
                  {stops.open.map((s, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0"><b>{s.machine}</b> <span className="text-muted">{s.dept}</span> · {s.cause}</span>
                      <span className="tabnum shrink-0 text-bad-fg font-bold" title={`since ${formatDate(s.sinceISO)}`}>{stopDurationLabel(s.hours)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-bold text-muted mb-1">Most stopped in the period</h3>
              {stops.byMachine.length === 0 ? <p className="text-sm text-muted">No unplanned stop in the period.</p> : (
                <div className="space-y-2">
                  {stops.byMachine.map((m) => (
                    <Bullet key={`${m.dept}|${m.machine}`} label={`${m.machine} · ${m.dept}`} value={m.hours} target={null} max={stops.byMachine[0].hours} text={`${stopDurationLabel(m.hours)} · ${m.stops} stop${m.stops === 1 ? "" : "s"} · ${Math.round(m.share * 100)}%`} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </ChartCard>

      <ChartCard
        className="xl:col-span-6"
        title="Quality and rework"
        sub={t
          ? `The tanks, tracked one by one: where the open ones stand, the leak test passed first time over the tanks first tested in the period (every attempt is kept, so a re-test never flatters it), and the days a tank waited — the median over the tanks that reached the step in the period. Then the pieces sent back upstream.`
          : "The pieces sent back upstream (Welding to Fabrication, Painting to Welding): open now, filed in the period, by reason. Tanks are recorded as quantities — turn on per-piece tank tracking in Settings for the leak-test figures."}
        table={{ rows: [
          ...(t ? [
            { Figure: "Tanks waiting for the leak test", Value: t.waitingTest, Note: "now" },
            { Figure: "Tanks in repair", Value: t.inRepair, Note: "now" },
            { Figure: "Tanks ready to paint", Value: t.readyToPaint, Note: "now" },
            { Figure: "Tanks welded", Value: t.weldedInPeriod, Note: "in the period" },
            { Figure: "Tanks painted", Value: t.paintedInPeriod, Note: "in the period" },
            { Figure: "Leak test passed first time %", Value: t.firstPass.rate === null ? "" : Math.round(t.firstPass.rate * 100), Note: `${t.firstPass.passed} of ${t.firstPass.units} tanks first tested in the period` },
            { Figure: "Welding → test, median days", Value: t.weldToTest.medianDays ?? "", Note: `${t.weldToTest.n} tanks tested in the period` },
            { Figure: "Test → painting, median days", Value: t.testToPaint.medianDays ?? "", Note: `${t.testToPaint.n} tanks painted in the period` },
          ] : []),
          { Figure: "Returns open", Value: q.returns.open.count, Note: `${q.returns.open.qty} pcs` },
          { Figure: "Returns filed in the period", Value: q.returns.filed.count, Note: `${q.returns.filed.qty} pcs` },
          ...q.returns.byReason.map((r) => ({ Figure: `Reason — ${r.reason}`, Value: r.qty, Note: `${r.count} return${r.count === 1 ? "" : "s"}` })),
        ] }}
      >
        <div className="space-y-3">
          {t && (
            <>
              <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]">
                {[
                  ["Waiting for test", fmt(t.waitingTest), "tanks, now"],
                  ["In repair", fmt(t.inRepair), "failed the test"],
                  ["Ready to paint", fmt(t.readyToPaint), "passed, not painted"],
                  ["Passed first time", pctOrDash(t.firstPass.rate), `${t.firstPass.passed} of ${t.firstPass.units} first tested`],
                  ["Welding → test", dOrDash(t.weldToTest.medianDays), cycleSub(t.weldToTest)],
                  ["Test → painting", dOrDash(t.testToPaint.medianDays), cycleSub(t.testToPaint)],
                ].map(([label, value, sub]) => <StatTile key={label} compact label={label} value={value} sub={sub} />)}
              </div>
              <p className="text-xs text-muted">{t.weldedInPeriod} tanks welded and {t.paintedInPeriod} painted in the period. The waits are read on the tanks the records can follow; a tank welded before tracking began has no welding day here.</p>
            </>
          )}
          <div>
            <h3 className="text-sm font-bold text-muted mb-1">Pieces sent back</h3>
            {q.returns.open.count === 0 && q.returns.filed.count === 0 ? (
              <p className="text-sm text-ok-fg font-semibold">No return open, none filed in the period.</p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <TableFrame className="!max-h-none">
                  <table className="w-full text-sm">
                    <thead><tr><Th label="" /><Th label="Returns" num className="text-right" /><Th label="Pieces" num className="text-right" /></tr></thead>
                    <tbody>
                      <tr><td className="px-2 font-semibold">Open now{q.returns.openOnUrgent > 0 ? <span className="text-bad-fg font-normal"> · {q.returns.openOnUrgent} on urgent orders</span> : ""}</td><td className="px-2 text-right tabnum">{fmt(q.returns.open.count)}</td><td className="px-2 text-right tabnum font-bold">{fmt(q.returns.open.qty)}</td></tr>
                      <tr><td className="px-2 font-semibold">Filed in the period</td><td className="px-2 text-right tabnum">{fmt(q.returns.filed.count)}</td><td className="px-2 text-right tabnum font-bold">{fmt(q.returns.filed.qty)}</td></tr>
                      {q.returnsByWeek.map((w) => (
                        <tr key={w.weekISO} className="text-muted"><td className="px-2 ps-5">week of {formatDate(w.weekISO)}</td><td className="px-2 text-right tabnum">{fmt(w.count)}</td><td className="px-2 text-right tabnum">{fmt(w.qty)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-muted">By reason (open and the period&apos;s)</h4>
                  {q.returns.byReason.map((r) => (
                    <Bullet key={r.reason} label={r.reason} value={r.qty} target={null} max={q.returns.byReason[0].qty} text={`${fmt(r.qty)} pcs · ${r.count}`} />
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-xs text-muted">Open returns are worked on the <Link href="/worklist/cut" className="text-brand-ink font-semibold hover:underline">Fabrication</Link> and <Link href="/worklist/welding" className="text-brand-ink font-semibold hover:underline">Welding</Link> worklists. The panels keep no return or test of their own.</p>
        </div>
      </ChartCard>
    </div>
  );
}
