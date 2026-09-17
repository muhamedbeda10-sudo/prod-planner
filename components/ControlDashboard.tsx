import Link from "next/link";
import type { ControlDashboardData } from "@/lib/server/controlDashboard";
import { BACKLOG_LABEL, LOAD_LABEL, type BacklogStage } from "@/lib/domain/control";
import { BacklogChart } from "@/components/LazyCharts";
import { toDisplayDate, parseISODate } from "@/lib/domain/dates";

// The production-control screen. Server-rendered: numbers, meters and bars in
// plain HTML — nothing to download before the first figure paints. The two
// throughput charts sit below it on the page, lazy-loaded.
//
// Layout answers the engineer's questions in order: where the month stands
// (hero + tiles) → where the work sits and where it is stuck (pipeline and
// backlog bars) → which orders need a hand today (the list) → the control
// loops around the floor (OTD, Odoo closing, material, today's shift log).

const fmt = (n: number) => n.toLocaleString();
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const dmy = (iso: string | null) => (iso ? toDisplayDate(parseISODate(iso)!) : "—");
const one = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

type Tone = "ok" | "warn" | "bad" | "muted";
const toneCls: Record<Tone, string> = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg", muted: "text-muted" };

/** A stat tile: label, one figure in proportional digits, a line under it. */
export function Tile({ label, value, sub, tone, href, title }: { label: string; value: string; sub?: React.ReactNode; tone?: Tone; href?: string; title?: string }) {
  const body = (
    <>
      <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-3xl font-extrabold leading-tight mt-0.5 ${tone ? toneCls[tone] : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5 leading-snug">{sub}</div>}
    </>
  );
  const cls = "bg-surface border rounded-xl px-4 py-3 min-w-0";
  return href ? <Link href={href} className={`${cls} block hover:border-brand/60 transition-colors`} title={title}>{body}</Link> : <div className={cls} title={title}>{body}</div>;
}

/** A horizontal bar: label · track · value at the tip. `max` sets the scale. */
function Bar({ label, value, max, color, tip, badge }: { label: string; value: number; max: number; color: string; tip: string; badge?: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[12rem_1fr_auto] items-center gap-3 text-sm" title={tip}>
      <span className="truncate">{label}</span>
      <span className="h-3 rounded-sm bg-border/70 overflow-hidden"><span className="block h-full rounded-sm" style={{ width: `${w}%`, background: color }} /></span>
      <span className="inline-flex items-center justify-end gap-2 min-w-[4rem]">
        {badge && <span className="pill pill-warn text-[10px]">{badge}</span>}
        <span className="tabnum font-bold text-xs">{fmt(value)}</span>
      </span>
    </div>
  );
}

export function ControlDashboard({ c }: { c: ControlDashboardData }) {
  const p = c.plan;
  const pace = c.pace;
  const paceTone: Tone = pace.ratio === null ? "muted" : pace.ratio >= 1 ? "ok" : pace.ratio >= 0.8 ? "warn" : "bad";
  const paceWord = pace.ratio === null ? "no pace yet" : pace.ratio >= 1 ? "on track" : pace.ratio >= 0.8 ? "slightly behind" : "behind";
  const attentionTone: Tone = c.attentionCounts.late > 0 ? "bad" : c.attentionCounts.dueSoon > 0 ? "warn" : "ok";
  const ramp = ["var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)"];
  const stages: { key: BacklogStage; label: string; done: number }[] = [
    { key: "fab", label: "Fabricated", done: c.pieces.cut },
    { key: "weld", label: "Welded", done: c.pieces.weld },
    { key: "finish", label: "Finished", done: c.pieces.finished },
    { key: "deliver", label: "Delivered", done: c.pieces.delivered },
  ];
  const backlogMax = Math.max(1, ...Object.values(c.backlog));
  const kindPill: Record<string, { cls: string; text: (a: ControlDashboardData["attention"][number]) => string }> = {
    late: { cls: "pill-bad", text: (a) => `late ${a.days}d` },
    dueSoon: { cls: "pill-warn", text: (a) => (a.days <= 0 ? "due today" : `due in ${a.days}d`) },
    blocked: { cls: "pill-muted", text: () => "no forecast" },
    hold: { cls: "pill-warn", text: () => "on hold" },
  };
  const shiftsMissing = c.shifts.filter((s) => s.hours === null).length;

  return (
    <div className="space-y-6">
      {/* ==== 1. where the month stands ==== */}
      <section className="grid gap-4 lg:grid-cols-[minmax(18rem,1.2fr)_2fr]">
        <div className="bg-surface border rounded-xl px-5 py-4 flex flex-col justify-between">
          <div>
            <div className="text-[11px] font-bold text-muted uppercase tracking-wide">Plan completion · {c.monthLabel}</div>
            <div className="text-6xl font-extrabold leading-none mt-1">{pct(p.pct)}</div>
            <div className="text-sm text-muted mt-2">
              <b className="text-foreground">{fmt(p.complete)}</b> of <b className="text-foreground">{fmt(p.required)}</b> units finished · {fmt(p.remaining)} left across {fmt(p.orders)} open orders
            </div>
          </div>
          {/* the meter: finished, then delivered as the darker end */}
          <div className="mt-4" title={`${fmt(p.delivered)} delivered · ${fmt(p.complete)} finished · ${fmt(p.required)} required`}>
            <div className="h-3 rounded-sm bg-border/70 overflow-hidden relative">
              <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${p.required > 0 ? (p.complete / p.required) * 100 : 0}%`, background: "var(--stage-2)" }} />
              <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${p.required > 0 ? (p.delivered / p.required) * 100 : 0}%`, background: "var(--stage-4)" }} />
            </div>
            <div className="flex justify-between text-[11px] text-muted mt-1">
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle me-1" style={{ background: "var(--stage-4)" }} />delivered {fmt(p.delivered)}</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle me-1" style={{ background: "var(--stage-2)" }} />finished {fmt(p.complete)}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Tile
            label="Pace vs month"
            value={pace.actualPerDay === null ? "—" : `${one(pace.actualPerDay)} / day`}
            tone={paceTone}
            sub={pace.requiredPerDay === null ? "no working days left this month" : <>{paceWord} · needs <b>{one(pace.requiredPerDay)}</b> pcs a day for the {fmt(pace.daysLeft)} working days left</>}
            title={`Pieces finished per working day over the last ${pace.windowDays} working days (${fmt(pace.finishedInWindow)} pcs), against what the remaining ${fmt(c.pieces.need - c.pieces.finished)} pieces need`}
          />
          <Tile
            label="Lands in"
            value={pace.daysNeeded === null ? "—" : `${fmt(pace.daysNeeded)} days`}
            tone={pace.daysNeeded === null ? "muted" : pace.daysNeeded <= pace.daysLeft ? "ok" : "bad"}
            sub={<>{fmt(pace.daysLeft)} working days left in {c.monthLabel.split(" ")[0]}</>}
            title="Working days the remaining pieces take at the current pace"
          />
          <Tile
            label="Needs a hand"
            value={fmt(c.attentionCounts.late + c.attentionCounts.dueSoon + c.attentionCounts.blocked)}
            tone={attentionTone}
            sub={<>{c.attentionCounts.late} late · {c.attentionCounts.dueSoon} due this week · {c.attentionCounts.blocked} no forecast</>}
            href="/tracker"
          />
          <Tile label="Delivered" value={fmt(p.delivered)} sub={<>units the customer received in full · {pct(p.required > 0 ? p.delivered / p.required : null)} of the plan</>} href="/tracker" />
          <Tile label="On hold" value={fmt(p.onHold)} tone={p.onHold > 0 ? "warn" : "muted"} sub="orders paused — out of every queue" href="/tracker" />
          <Tile label="Flagged" value={`${fmt(p.urgent)} · ${fmt(p.priority)}`} sub="urgent · priority" href="/tracker" />
        </div>
      </section>

      {/* ==== 2. where the work sits ==== */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="bg-surface border rounded-xl p-4 min-w-0">
          <h3 className="font-bold text-sm">Pipeline — pieces through each stage</h3>
          <p className="text-xs text-muted mb-3">of {fmt(c.pieces.need)} required pieces the plant makes itself (OSP excluded), over the open orders</p>
          <div className="space-y-2">
            {stages.map((s, i) => <Bar key={s.key} label={s.label} value={s.done} max={c.pieces.need} color={ramp[i]} tip={`${s.label}: ${fmt(s.done)} of ${fmt(c.pieces.need)} pieces (${pct(c.pieces.need > 0 ? s.done / c.pieces.need : null)})`} />)}
          </div>
        </div>
        <div className="bg-surface border rounded-xl p-4 min-w-0">
          <h3 className="font-bold text-sm">Backlog — pieces waiting at each stage</h3>
          <p className="text-xs text-muted mb-3">what the stage before released and this one has not done yet · the longest queue is the bottleneck</p>
          <div className="space-y-2">
            {(["fab", "weld", "finish", "deliver"] as BacklogStage[]).map((k) => (
              <Bar key={k} label={BACKLOG_LABEL[k]} value={c.backlog[k]} max={backlogMax} color="var(--series-fab)" badge={c.bottleneck === k ? "bottleneck" : undefined} tip={`${BACKLOG_LABEL[k]}: ${fmt(c.backlog[k])} pieces`} />
            ))}
          </div>
        </div>
      </section>

      {/* ==== 2b. the queues in hours, and how they moved ==== */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="bg-surface border rounded-xl p-4 min-w-0">
          <h3 className="font-bold text-sm">Load vs capacity — standard hours queued</h3>
          <p className="text-xs text-muted mb-3">
            what the open orders still owe each stage, in std-hours, against the pace the stage earns (last {c.load.windowDays} working days) · the meter is days of work vs the {fmt(pace.daysLeft)} working days left
            {c.load.uncoveredOrders > 0 && <> · {fmt(c.load.uncoveredOrders)} open order{c.load.uncoveredOrders === 1 ? "" : "s"} carry no standard times and are not counted</>}
          </p>
          <div className="space-y-3">
            {c.load.stages.map((l) => {
              const days = l.daysOfWork;
              const ratio = days === null ? null : pace.daysLeft > 0 ? days / pace.daysLeft : Infinity;
              const tone = ratio === null ? "var(--border-strong)" : ratio <= 1 ? "var(--ok-fg)" : ratio <= 1.25 ? "var(--warn-fg)" : "var(--bad-fg)";
              const w = ratio === null ? 0 : Math.min(100, ratio * 100);
              return (
                <div key={l.stage} className="text-sm" title={`${LOAD_LABEL[l.stage]}: ${one(l.queuedHours)} std-hours queued · earns ${one(l.earnedPerDay)} h a day${l.capacityPerDay !== null ? ` · capacity ${one(l.capacityPerDay)} h a day` : ""}${l.recordedPerDay !== null ? ` · shift log ${one(l.recordedPerDay)} h a day` : ""}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{LOAD_LABEL[l.stage]}</span>
                    <span className="text-xs text-muted tabnum">
                      <b className="text-foreground">{fmt(Math.round(l.queuedHours))} h</b> queued · {days === null ? "no pace yet" : <><b className="text-foreground">{one(days)}</b> days of work</>}
                    </span>
                  </div>
                  <div className="mt-1 h-3 rounded-sm bg-border/70 overflow-hidden"><div className="h-full rounded-sm" style={{ width: `${w}%`, background: tone }} /></div>
                  <div className="text-[11px] text-muted mt-0.5 tabnum">
                    earns {one(l.earnedPerDay)} h/day
                    {l.capacityPerDay !== null && <> · capacity {one(l.capacityPerDay)} h/day{l.utilisation !== null && <> ({pct(l.utilisation)} turned into output)</>}</>}
                    {l.recordedPerDay !== null && <> · shift log {one(l.recordedPerDay)} h/day</>}
                    {l.capacityPerDay === null && l.recordedPerDay === null && <> · no capacity set and no shift log — <Link href="/admin/standard-times" className="text-accent hover:underline">set it</Link></>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="bg-surface border rounded-xl p-4 min-w-0">
          <h3 className="font-bold text-sm">Backlog — last 30 days</h3>
          <p className="text-xs text-muted mb-1">pieces waiting at each stage, day by day, for the orders open today · a line that climbs is a stage falling behind the one before it</p>
          <BacklogChart history={c.backlogHistory} />
        </div>
      </section>

      {/* ==== 3. the orders that need a hand today ==== */}
      <section className="bg-surface border rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b bg-surface-2/60">
          <h3 className="font-bold text-sm">Needs a hand today</h3>
          <span className="text-xs text-muted">late forecasts first, then promises due this week, then orders with no forecast, then holds · <Link href="/tracker" className="text-accent font-semibold hover:underline">open the tracker →</Link></span>
        </div>
        {c.attention.length === 0 ? (
          <p className="p-4 text-sm text-muted">Nothing late, nothing due this week, nothing on hold. A good day.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="p-2 ps-4">MO</th><th className="p-2">BOM</th><th className="p-2">SOI</th><th className="p-2">Customer</th>
                  <th className="p-2 text-center">Left</th><th className="p-2">Promise</th><th className="p-2">Forecast</th><th className="p-2 pe-4">Why</th>
                </tr>
              </thead>
              <tbody>
                {c.attention.map((a) => (
                  <tr key={a.mo} className="border-t">
                    <td className="p-2 ps-4 font-bold text-xs whitespace-nowrap">
                      <Link href={`/trace?mo=${encodeURIComponent(a.mo)}`} className="text-accent hover:underline">{a.mo}</Link>
                      {a.urgent && <span className="pill pill-bad ms-1">U</span>}
                      {a.priority && <span className="ms-1" title="Priority">⭐</span>}
                    </td>
                    <td className="p-2 font-semibold whitespace-nowrap">{a.bom}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{a.soi ?? "—"}</td>
                    <td className="p-2 text-xs">{a.customer ?? "—"}</td>
                    <td className="p-2 text-center tabnum font-bold">{fmt(a.remaining)}</td>
                    <td className="p-2 tabnum text-xs whitespace-nowrap">{dmy(a.dueISO)}</td>
                    <td className="p-2 tabnum text-xs whitespace-nowrap">{dmy(a.etaISO)}</td>
                    <td className="p-2 pe-4"><span className={`pill ${kindPill[a.kind].cls}`}>{kindPill[a.kind].text(a)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ==== 4. the control loops around the floor ==== */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          label="On-time delivery"
          value={pct(c.otd.pct)}
          tone={c.otd.pct === null ? "muted" : c.otd.pct >= 0.9 ? "ok" : c.otd.pct >= 0.7 ? "warn" : "bad"}
          sub={<>{fmt(c.otd.due)} promises fell due · {fmt(c.otd.openLate)} still open past their date{c.otd.avgLateDays !== null ? ` · avg ${one(c.otd.avgLateDays)}d late` : ""}</>}
          href="/report"
        />
        <Tile
          label="Odoo closing"
          value={fmt(c.closing.open)}
          tone={c.closing.open > 0 ? "warn" : "ok"}
          sub={<>closings not done yet · <b>{fmt(c.closing.needMo)}</b> still need Odoo&apos;s MO number</>}
          href="/odoo"
        />
        <Tile
          label="Material · this month"
          value={fmt(c.material.overBom)}
          tone={c.material.overBom > 0 ? "bad" : c.material.lines === 0 ? "muted" : "ok"}
          sub={c.material.lines === 0 ? "no nesting lines imported for this month" : <>lines over their BOM · {fmt(c.material.notNested)} of {fmt(c.material.lines)} not nested yet</>}
          href="/material"
        />
        <Tile
          label="Shift log today"
          value={shiftsMissing === 0 ? "all in" : `${c.shifts.length - shiftsMissing} / ${c.shifts.length}`}
          tone={shiftsMissing === 0 ? "ok" : "warn"}
          sub={<>{c.shifts.map((s) => `${s.label} ${s.hours === null ? "—" : `${one(s.hours)}h`}`).join(" · ")}</>}
          href="/shifts"
          title="Departments whose attendance and hours are recorded for today — the rates need them"
        />
      </section>
    </div>
  );
}
