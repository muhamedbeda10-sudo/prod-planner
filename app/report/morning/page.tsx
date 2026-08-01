import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { buildMorningDigest } from "@/lib/server/morningReport";
import { PageHeader } from "@/components/ui";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";

export const metadata = { title: "Morning Brief — ATC" };
export const dynamic = "force-dynamic";

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");
const dd = (iso: string) => toDisplayDate(parseISODate(iso)!);

/* The same digest the 7am email carries, always available in-app — including
   before SMTP is ever configured. */
export default async function MorningBriefPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const d = await buildMorningDigest();
  return (
    <div className="max-w-3xl">
      <PageHeader title="🌅 Morning Brief" />
      <p className="text-xs text-muted -mt-2 mb-4">
        Report for <b>{dd(d.dayISO)}</b> (the last working day) — the daily 7am email carries exactly this.{" "}
        <Link href="/report" className="text-accent hover:underline">Full daily report →</Link>
      </p>

      <div className="space-y-4">
        {/* output */}
        <section className="bg-surface border rounded-xl px-4 py-3">
          <h2 className="mb-2">Output</h2>
          {d.output.length === 0 ? (
            <p className="text-sm font-semibold text-bad-fg">No output was recorded for {dd(d.dayISO)}.</p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-1.5">
              {d.output.map((o) => (
                <span key={o.dept} className="text-sm">
                  <b>{o.dept}</b> <span className="tabnum font-extrabold">{fmt(o.pcs)}</span>{" "}
                  <span className="text-[10px] text-muted">pcs</span>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* earned hours */}
        <section className="bg-surface border rounded-xl px-4 py-3">
          <h2 className="mb-2">Standard hours earned</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1.5 items-baseline">
            {d.earned.map((e) => (
              <span key={e.stage} className="text-sm">
                <span className="text-muted font-semibold">{e.stage}</span>{" "}
                <span className="tabnum font-extrabold">{fmt(e.hours)}</span>
                {e.capacity ? (
                  <span className="text-[10px] text-muted tabnum"> / {fmt(e.capacity)} h · {Math.round((e.hours / e.capacity) * 100)}%</span>
                ) : (
                  <span className="text-[10px] text-muted"> h</span>
                )}
              </span>
            ))}
            <span className="text-sm sm:ml-auto">
              <span className="text-muted font-semibold">Total</span>{" "}
              <span className="tabnum font-extrabold text-brand text-lg">{fmt(d.earnedTotal)}</span>{" "}
              <span className="text-[10px] text-muted">h</span>
            </span>
          </div>
          {d.uncoveredPcs > 0 && (
            <p className="mt-1.5 text-[11px] text-warn-fg">
              ⚠ {d.uncoveredPcs} of {d.totalPcs} pcs earned no hours (order missing FG code / KVA) — the totals undercount the day.
            </p>
          )}
        </section>

        {/* pace */}
        {d.pace && (
          <section className="bg-surface border rounded-xl px-4 py-3">
            <h2 className="mb-1">Weekly plan {d.pace.planNo} — pace</h2>
            <p
              className="text-sm font-bold tabnum"
              style={{ color: d.pace.coverage >= 1 ? "var(--ok-fg)" : d.pace.coverage >= 0.9 ? "var(--warn-fg)" : "var(--bad-fg)" }}
            >
              After {d.pace.elapsedWd} of {d.pace.workingDays} working days the week is closing at {Math.round(d.pace.coverage * 100)}%
              {d.pace.worst && <> — worst: {d.pace.worst}</>}
            </p>
          </section>
        )}

        {/* late orders */}
        {d.lateOrders.length > 0 && (
          <section className="bg-surface border rounded-xl px-4 py-3">
            <h2 className="mb-2">Orders forecast LATE</h2>
            <table className="text-sm border-collapse">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="pr-6 pb-1">MO</th><th className="pr-6 pb-1">Due</th><th className="pb-1">Forecast</th>
                </tr>
              </thead>
              <tbody>
                {d.lateOrders.map((o) => (
                  <tr key={o.mo}>
                    <td className="pr-6 py-0.5 font-bold">{o.mo}</td>
                    <td className="pr-6 py-0.5 tabnum">{dd(o.dueISO)}</td>
                    <td className="py-0.5 tabnum font-bold text-bad-fg">⚠ {dd(o.etaISO)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* data guard */}
        {d.flagged.length > 0 && (
          <section className="bg-surface border rounded-xl px-4 py-3">
            <h2 className="mb-2">The data guard wants a human to check</h2>
            <ul className="space-y-1 text-sm">
              {d.flagged.map((f, i) => (
                <li key={i}>
                  <span className="pill pill-warn mr-1.5">⚠</span>
                  <b>{f.bom}</b> · {f.dept} · {dd(f.dateISO)} · {fmt(f.qty)} pcs — <span className="text-muted">{f.detail}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted">Open <Link href="/handover" className="text-accent hover:underline">Logs</Link> and use the ⚠ filter to fix or dismiss these.</p>
          </section>
        )}
      </div>
    </div>
  );
}
