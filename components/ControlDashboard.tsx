import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import type { ControlDashboardData } from "@/lib/server/controlDashboard";
import type { TargetDashboard } from "@/lib/server/dashboard";
import { BACKLOG_LABEL, LOAD_LABEL, type BacklogStage } from "@/lib/domain/control";
import { itemColor } from "@/lib/domain/productColors";
import { FINISHING_LABEL, ITEMS, ITEM_NAME, itemDailyTarget, type Item } from "@/lib/domain/constants";
import { BacklogChart, HistoryChart, LoadRings, PipelineFunnel, PromisesChart, WeekTrendChart } from "@/components/LazyCharts";
import { Sparkline } from "@/components/charts/kit";

// The production-control screen, in three bands:
//   NOW        — one row of six figures: where the month stands (the pace
//                tile carries the period's finishing output as a sparkline)
//   THE FLOOR  — six cards of equal size, two to a row: output vs target,
//                the backlog over a month, the pipeline and today's backlog,
//                load vs capacity, the last six weeks, the orders that need
//                a hand
//   a footer strip with the control loops (Odoo closing · material · shift log)
// One line of words per card at most; the explanations ride on hover.

const fmt = (n: number) => n.toLocaleString();
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const dmy = (iso: string | null) => formatDate(iso);
const one = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

type Tone = "ok" | "warn" | "bad" | "muted";
const toneCls: Record<Tone, string> = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg", muted: "text-muted" };
const toneVar: Record<Tone, string> = { ok: "var(--ok-fg)", warn: "var(--warn-fg)", bad: "var(--bad-fg)", muted: "var(--border-strong)" };

function Band({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="text-[11px] font-extrabold text-muted uppercase tracking-[0.14em] px-1">{label}</div>
      {children}
    </section>
  );
}

/** A figure tile: label, one big figure, one line under it. Same height as its neighbours. */
function Kpi({ label, value, sub, tone, href, title, meter, spark }: { label: string; value: string; sub?: React.ReactNode; tone?: Tone; href?: string; title?: string; meter?: { value: number; tone: Tone }; spark?: number[] }) {
  const body = (
    <div className="flex h-full flex-col">
      <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</div>
      <div className="flex items-end justify-between gap-2 mt-2">
        <div className={`text-[2rem] font-extrabold leading-none ${tone ? toneCls[tone] : ""}`}>{value}</div>
        {spark && spark.length > 1 && <Sparkline values={spark} width={72} height={26} />}
      </div>
      {meter && (
        <div className="mt-2 h-1.5 rounded-sm bg-border/70 overflow-hidden"><div className="h-full rounded-sm" style={{ width: `${Math.min(100, meter.value * 100)}%`, background: toneVar[meter.tone] }} /></div>
      )}
      {sub && <div className="text-[11px] text-muted mt-auto pt-2 leading-snug">{sub}</div>}
    </div>
  );
  const cls = "bg-surface border rounded-xl px-4 py-3 min-w-0 min-h-[7.5rem]";
  return href ? <Link href={href} className={`${cls} block hover:border-brand/60 transition-colors`} title={title}>{body}</Link> : <div className={cls} title={title}>{body}</div>;
}

/** A chart card: title, one line, then the content — every card the same height in its row. */
function Card({ title, sub, aside, children }: { title: string; sub?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface border rounded-xl p-4 min-w-0 flex flex-col" title={sub}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="font-bold text-sm sm:truncate">{title}</h3>
        {aside && <div className="text-xs text-muted whitespace-nowrap">{aside}</div>}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

/** A horizontal bar: label · track · value. */
function Bar({ label, value, max, color, badge, tip }: { label: string; value: number; max: number; color: string; badge?: string; tip?: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[9.5rem_1fr_auto] items-center gap-2 text-sm" title={tip}>
      <span className="truncate text-xs">{label}</span>
      <span className="h-2.5 rounded-sm bg-border/70 overflow-hidden"><span className="block h-full rounded-sm" style={{ width: `${w}%`, background: color }} /></span>
      <span className="inline-flex items-center justify-end gap-1.5 min-w-[3.5rem]">
        {badge && <span className="pill pill-warn text-[10px]">{badge}</span>}
        <span className="tabnum font-bold text-xs">{fmt(value)}</span>
      </span>
    </div>
  );
}

const pctOf = (v: number, t: number) => (t > 0 ? v / t : 0);


const attainTone = (f: number): Tone => (f >= 1 ? "ok" : f >= 0.5 ? "muted" : "bad");

/** The component's chip — its product colour as a swatch, its code, the name on hover. */
function ItemChip({ item }: { item: Item }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-extrabold" title={ITEM_NAME[item]}>
      <span className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: itemColor(item) }} aria-hidden />
      {item}
    </span>
  );
}

/** A cell that is a figure over a small meter: done of need, coloured by the stage ramp or by attainment. */
function MeterCell({ value, max, color, label }: { value: number; max: number; color: string; label?: string }) {
  const f = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <td className="py-1.5 px-2 align-middle" title={label}>
      <div className="tabnum text-xs font-bold leading-none">{fmt(value)}{max > 0 && <span className="text-muted font-normal"> / {fmt(max)}</span>}</div>
      <div className="mt-1 h-1.5 rounded-sm bg-border/70 overflow-hidden"><div className="h-full rounded-sm" style={{ width: `${f * 100}%`, background: color }} /></div>
    </td>
  );
}

export function ControlDashboard({ c, d, controls, machinePlanning = true }: { c: ControlDashboardData; d: TargetDashboard; controls?: React.ReactNode; /** Off, the worklists, the shift log and the machines are not part of the app — what reads them goes with them. */ machinePlanning?: boolean }) {
  const p = c.plan;
  const pace = c.pace;
  const paceTone: Tone = pace.ratio === null ? "muted" : pace.ratio >= 1 ? "ok" : pace.ratio >= 0.8 ? "warn" : "bad";
  const paceWord = pace.ratio === null ? "no pace yet" : pace.ratio >= 1 ? "on track" : pace.ratio >= 0.8 ? "slightly behind" : "behind";
  const handTotal = c.attentionCounts.late + c.attentionCounts.dueSoon + c.attentionCounts.blocked;
  const handTone: Tone = c.attentionCounts.late > 0 ? "bad" : c.attentionCounts.dueSoon > 0 ? "warn" : "ok";
  const otdTone: Tone = c.otd.pct === null ? "muted" : c.otd.pct >= 0.9 ? "ok" : c.otd.pct >= 0.7 ? "warn" : "bad";
  const stageRamp = ["var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)"];
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
  const shiftsIn = c.shifts.filter((s) => s.hours !== null).length;
  const periodWord = d.mode === "week" ? "this week" : "this period";
  const attain = [
    { name: "Fab", v: d.period.cut.total, t: d.targetPerDeptPeriod },
    { name: "Weld", v: d.period.weld.total, t: d.targetPerDeptPeriod },
    { name: "Fin", v: d.period.paint.total, t: d.paintTargetPeriod },
  ];

  // the plan the figures are read over: the one picked, else this month's
  const planLabel = c.planMonth ?? c.monthLabel;

  return (
    <div className="space-y-7">
      {/* ==== NOW: six figures ==== */}
      <Band label={c.planMonth ? `Plan · ${c.planMonth} · its orders only` : `Now · ${c.monthLabel}`}>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Kpi
            label="Plan completion"
            value={pct(p.pct)}
            meter={{ value: p.pct ?? 0, tone: "ok" }}
            sub={<><b className="text-foreground">{fmt(p.complete)}</b> of {fmt(p.required)} tanks · {fmt(p.orders)} orders, {fmt(p.openOrders)} open</>}
            href="/tracker"
            title={`${fmt(p.complete)} tanks painted of ${fmt(p.required)} on ${planLabel}'s plan, closed orders included — the unit closes on its tank · ${fmt(p.delivered)} units delivered in full`}
          />
          <Kpi
            label="Pace vs month"
            value={pace.actualPerDay === null ? "—" : `${one(pace.actualPerDay)}/day`}
            tone={paceTone}
            spark={d.days.filter((x) => !x.isFuture).map((x) => x.paint.total)}
            sub={pace.requiredPerDay === null ? "no working days left" : <>{paceWord} · needs <b className="text-foreground">{one(pace.requiredPerDay)}</b>/day</>}
            title={`Tanks painted per working day over the last ${pace.windowDays} working days, against what the ${fmt(p.remaining)} tanks left on ${planLabel}'s plan need by month end`}
          />
          <Kpi
            label="Lands in"
            value={pace.daysNeeded === null ? "—" : `${fmt(pace.daysNeeded)} days`}
            tone={pace.daysNeeded === null ? "muted" : pace.daysNeeded <= pace.daysLeft ? "ok" : "bad"}
            sub={<>{fmt(pace.daysLeft)} working days left</>}
            title={`Working days the ${fmt(p.remaining)} tanks left on the plan take at the current pace, against the working days left in the month`}
          />
          <Kpi
            label="Needs a hand"
            value={fmt(handTotal)}
            tone={handTone}
            sub={<>{c.attentionCounts.late} late · {c.attentionCounts.dueSoon} due this week · {c.attentionCounts.blocked} no forecast</>}
            href="/tracker"
          />
          <Kpi
            label="On hold · flagged"
            value={`${fmt(p.onHold)} · ${fmt(p.urgent + p.priority)}`}
            tone={p.onHold > 0 ? "warn" : "muted"}
            sub={<>{fmt(p.onHold)} paused · {fmt(p.urgent)} urgent · {fmt(p.priority)} priority</>}
            href="/tracker"
          />
          <Kpi
            label="On-time delivery"
            value={pct(c.otd.pct)}
            tone={otdTone}
            sub={<>{fmt(c.otd.openLate)} open past their date{c.otd.avgLateDays !== null ? ` · avg ${one(c.otd.avgLateDays)}d late` : ""}</>}
            href="/report"
            title={`${fmt(c.otd.due)} promises fell due`}
          />
        </div>
      </Band>

      {/* ==== THE FLOOR: six cards, two to a row ==== */}
      <Band label="The floor">
        {controls}
        <div className="grid lg:grid-cols-2 gap-4">
          <Card
            title={`Daily output vs target · ${periodWord}`}
            sub={`Pieces per department per day · dashed line = ${d.targetPerDeptDay} pcs a department a working day`}
            aside={attain.map((a) => <span key={a.name} className="ms-3"><span className="text-muted">{a.name}</span> <b className="tabnum" style={{ color: pctOf(a.v, a.t) >= 1 ? "var(--ok-fg)" : pctOf(a.v, a.t) >= 0.5 ? "var(--foreground)" : "var(--bad-fg)" }}>{Math.round(pctOf(a.v, a.t) * 100)}%</b></span>)}
          >
            <WeekTrendChart days={d.days} targetPerDeptDay={d.targetPerDeptDay} />
          </Card>
          <Card title="Backlog · last 30 days" sub="Pieces waiting at each stage, day by day, for the orders open today — a line that climbs is a stage falling behind the one before it">
            <BacklogChart history={c.backlogHistory} />
          </Card>
          <Card title="Needs a hand today" sub="Late forecasts first (most late on top), then promises due this week, then orders with no forecast, then holds · Left = tanks still to paint" aside={<Link href="/tracker" className="text-accent font-semibold hover:underline">tracker →</Link>}>
            {c.attention.length === 0 ? (
              <p className="text-sm text-muted">Nothing late, nothing due this week, nothing on hold.</p>
            ) : (
              <div className="overflow-x-auto"><table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-[11px] text-muted uppercase tracking-wide">
                    <th className="py-1 pe-2 font-bold">MO</th><th className="py-1 pe-2 font-bold">BOM</th><th className="py-1 pe-2 font-bold text-center">Left</th><th className="py-1 pe-2 font-bold">Promise</th><th className="py-1 font-bold">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {c.attention.slice(0, 6).map((a) => (
                    <tr key={a.mo} className="border-t">
                      <td className="py-1.5 pe-2 font-bold text-xs whitespace-nowrap">
                        <Link href={`/trace?mo=${encodeURIComponent(a.mo)}`} className="text-accent hover:underline">{a.mo}</Link>
                        {a.urgent && <span className="pill pill-bad ms-1">U</span>}
                        {a.priority && <span className="ms-1" title="Priority">⭐</span>}
                      </td>
                      <td className="py-1.5 pe-2 font-semibold whitespace-nowrap text-xs">{a.bom}</td>
                      <td className="py-1.5 pe-2 text-center tabnum font-bold">{fmt(a.remaining)}</td>
                      <td className="py-1.5 pe-2 tabnum text-xs whitespace-nowrap">{dmy(a.dueISO)}</td>
                      <td className="py-1.5"><span className={`pill ${kindPill[a.kind].cls}`}>{kindPill[a.kind].text(a)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
          <Card
            title="Promises · next 14 days"
            sub="Tanks promised per day (the latest scheduled delivery of every open order with tanks left); the at-risk share is what the forecast says lands late, has no forecast, or is on hold"
            aside={<>{c.promises.overdue.orders > 0 ? <span className="text-bad-fg font-bold">{fmt(c.promises.overdue.units)} units on {fmt(c.promises.overdue.orders)} overdue promise{c.promises.overdue.orders === 1 ? "" : "s"}</span> : <span className="text-ok-fg">no overdue promises</span>}{c.promises.unscheduled > 0 && <> · {fmt(c.promises.unscheduled)} unscheduled</>}</>}
          >
            <PromisesChart days={c.promises.days} />
          </Card>
          <Card title="Pipeline and backlog · now" sub={`Of ${fmt(c.pieces.need)} required pieces the plant makes itself, over the open orders`} aside={<>{fmt(c.pieces.need)} pieces required</>}>
            <div className="space-y-3">
              <div>
                <div className="text-[11px] font-bold text-muted uppercase tracking-wide mb-1">Through each stage</div>
                <PipelineFunnel need={c.pieces.need} steps={stages.map((s) => ({ label: s.label, done: s.done }))} />
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-bold text-muted uppercase tracking-wide">Waiting at each stage</div>
                {(["fab", "weld", "finish", "deliver"] as BacklogStage[]).map((k) => (
                  <Bar key={k} label={BACKLOG_LABEL[k].replace("Waiting for ", "").replace("Finished, not delivered", "delivery")} value={c.backlog[k]} max={backlogMax} color="var(--series-fab)" badge={c.bottleneck === k ? "bottleneck" : undefined} tip={`${BACKLOG_LABEL[k]}: ${fmt(c.backlog[k])} pieces`} />
                ))}
              </div>
            </div>
          </Card>
          <Card
            title="Load vs capacity · std-hours queued"
            sub={`What the open orders still owe each stage, against the pace it earns over the last ${c.load.windowDays} working days · the meter is days of work against the ${fmt(pace.daysLeft)} working days left`}
            aside={c.load.uncoveredOrders > 0 ? <span title="Open orders with no standard times — not counted">{fmt(c.load.uncoveredOrders)} uncounted</span> : undefined}
          >
            <div className="space-y-3">
              <LoadRings stages={c.load.stages} daysLeft={pace.daysLeft} />
              {c.load.stages.map((l) => {
                const days = l.daysOfWork;
                const ratio = days === null ? null : pace.daysLeft > 0 ? days / pace.daysLeft : Infinity;
                const tone: Tone = ratio === null ? "muted" : ratio <= 1 ? "ok" : ratio <= 1.25 ? "warn" : "bad";
                return (
                  <div key={l.stage} title={`${LOAD_LABEL[l.stage]}: ${one(l.queuedHours)} std-hours queued · earns ${one(l.earnedPerDay)} h a day${l.capacityPerDay !== null ? ` · capacity ${one(l.capacityPerDay)} h a day (${pct(l.utilisation)} turned into output)` : " · no capacity set"}${l.recordedPerDay !== null ? ` · shift log ${one(l.recordedPerDay)} h a day` : ""}`}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-semibold">{LOAD_LABEL[l.stage]}</span>
                      <span className="text-xs text-muted tabnum"><b className="text-foreground">{fmt(Math.round(l.queuedHours))} h</b> · {days === null ? "no pace" : <><b className={toneCls[tone]}>{one(days)}</b> days of work</>}</span>
                    </div>
                    <div className="mt-1 h-2.5 rounded-sm bg-border/70 overflow-hidden"><div className="h-full rounded-sm" style={{ width: `${ratio === null ? 0 : Math.min(100, ratio * 100)}%`, background: toneVar[tone] }} /></div>
                    <div className="text-[11px] text-muted mt-0.5 tabnum">
                      earns {one(l.earnedPerDay)} h/day{l.capacityPerDay !== null ? ` · capacity ${one(l.capacityPerDay)} h/day` : ""}{l.recordedPerDay !== null ? ` · logged ${one(l.recordedPerDay)} h/day` : ""}
                      {l.capacityPerDay === null && <> · <Link href="/admin/standard-times" className="text-accent hover:underline">no capacity set</Link></>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card title="By component · now" sub="Each component's pieces through the stages over the open orders, and where the most of it waits" aside={<>{c.byItem.length} components</>}>
            <div className="overflow-x-auto"><table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[11px] text-muted uppercase tracking-wide">
                  <th className="py-1 px-2 font-bold">Item</th>
                  {(["Fab", "Weld", "Fin", "Dlvd"] as const).map((h) => <th key={h} className="py-1 px-2 font-bold">{h}</th>)}
                  <th className="py-1 px-2 font-bold">Waiting most at</th>
                </tr>
              </thead>
              <tbody>
                {c.byItem.length === 0 && <tr className="border-t"><td colSpan={6} className="py-3 px-2 text-sm text-muted">No open orders.</td></tr>}
                {c.byItem.map((b) => (
                  <tr key={b.item} className="border-t">
                    <td className="py-1.5 px-2 whitespace-nowrap"><ItemChip item={b.item} /></td>
                    <MeterCell value={b.pieces.cut} max={b.pieces.need} color={stageRamp[0]} label={`${ITEM_NAME[b.item]}: ${fmt(b.pieces.cut)} of ${fmt(b.pieces.need)} fabricated`} />
                    <MeterCell value={b.pieces.weld} max={b.pieces.need} color={stageRamp[1]} label={`${ITEM_NAME[b.item]}: ${fmt(b.pieces.weld)} of ${fmt(b.pieces.need)} welded`} />
                    <MeterCell value={b.pieces.finished} max={b.pieces.need} color={stageRamp[2]} label={`${ITEM_NAME[b.item]}: ${fmt(b.pieces.finished)} of ${fmt(b.pieces.need)} finished`} />
                    <MeterCell value={b.pieces.delivered} max={b.pieces.need} color={stageRamp[3]} label={`${ITEM_NAME[b.item]}: ${fmt(b.pieces.delivered)} of ${fmt(b.pieces.need)} delivered`} />
                    <td className="py-1.5 px-2 whitespace-nowrap text-xs">
                      {b.bottleneck === null ? <span className="text-muted">nothing waiting</span> : <><span className="pill pill-warn text-[10px]">{BACKLOG_LABEL[b.bottleneck].replace("Waiting for ", "").replace("Finished, not delivered", "delivery")}</span> <b className="tabnum">{fmt(b.backlog[b.bottleneck])}</b></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </Card>
          <Card title={`Output by component · ${periodWord}`} sub={`Pieces per component per department against its target for the period (${d.targetPerItem} a day; AR & MB ${itemDailyTarget("AR", d.targetPerItem)} a day only while an open order needs them) · ${d.workingDays} working days`}>
            <div className="overflow-x-auto"><table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[11px] text-muted uppercase tracking-wide">
                  <th className="py-1 px-2 font-bold">Item</th>
                  <th className="py-1 px-2 font-bold text-center">Target</th>
                  <th className="py-1 px-2 font-bold">Fab</th>
                  <th className="py-1 px-2 font-bold">Weld</th>
                  <th className="py-1 px-2 font-bold">Fin</th>
                </tr>
              </thead>
              <tbody>
                {ITEMS.map((it) => {
                  // no open order needs it → no target, its output just shows
                  const t = d.targetItems.includes(it) ? itemDailyTarget(it, d.targetPerItem) * d.workingDays : 0;
                  const cells = [
                    { v: d.period.cut.items[it], word: "fabricated" },
                    { v: d.period.weld.items[it], word: "welded" },
                    { v: d.period.paint.items[it], word: "finished" },
                  ];
                  return (
                    <tr key={it} className="border-t">
                      <td className="py-1.5 px-2 whitespace-nowrap"><ItemChip item={it} /></td>
                      <td className="py-1.5 px-2 text-center tabnum text-xs text-muted" title={t === 0 ? "No open order needs this component — no target" : undefined}>{t === 0 ? "—" : fmt(t)}</td>
                      {cells.map((x) => <MeterCell key={x.word} value={x.v} max={t} color={t === 0 ? "var(--border-strong)" : toneVar[attainTone(pctOf(x.v, t))]} label={t === 0 ? `${ITEM_NAME[it]}: ${fmt(x.v)} ${x.word} ${periodWord} — no open order needs it, so no target` : `${ITEM_NAME[it]}: ${fmt(x.v)} ${x.word} of ${fmt(t)} targeted ${periodWord} (${Math.round(pctOf(x.v, t) * 100)}%)`} />)}
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Card>
          <Card title="By customer · now" sub="The open orders per customer: units finished (tanks painted) and delivered of required" aside={<>{c.customers.length} customer{c.customers.length === 1 ? "" : "s"}</>}>
            <div className="space-y-3">
              {c.customers.map((k) => (
                <div key={k.customer} title={`${k.customer}: ${fmt(k.complete)} finished and ${fmt(k.delivered)} delivered of ${fmt(k.required)} units on ${fmt(k.orders)} open orders`}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-semibold">{k.customer}{k.urgent > 0 && <span className="pill pill-bad ms-2">U×{k.urgent}</span>}</span>
                    <span className="text-xs text-muted tabnum"><b className="text-foreground">{fmt(k.complete)}</b> finished · <b className="text-foreground">{fmt(k.delivered)}</b> delivered · of {fmt(k.required)} on {fmt(k.orders)} orders</span>
                  </div>
                  <div className="mt-1 h-2.5 rounded-sm bg-border/70 overflow-hidden relative">
                    <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${k.required > 0 ? (k.complete / k.required) * 100 : 0}%`, background: "var(--stage-2)" }} />
                    <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${k.required > 0 ? (k.delivered / k.required) * 100 : 0}%`, background: "var(--stage-4)" }} />
                  </div>
                </div>
              ))}
              {c.customers.length === 0 && <p className="text-sm text-muted">No open orders.</p>}
            </div>
          </Card>
          <Card title={`This month vs ${c.months.lastMonthLabel.split(" ")[0]}`} sub={`Pieces per department: this month to date after ${c.months.elapsedWd} of ${c.months.monthWd} working days, against all of last month; "lands at" projects the month from the run-rate so far`}>
            <div className="space-y-3">
              {c.months.rows.map((m) => {
                const max = Math.max(1, m.lastMonth, m.projected ?? 0, m.mtd);
                const tone: Tone = m.projected === null ? "muted" : m.projected >= m.lastMonth ? "ok" : m.projected >= m.lastMonth * 0.9 ? "warn" : "bad";
                return (
                  <div key={m.dept} title={`${m.dept}: ${fmt(m.mtd)} so far this month · ${fmt(m.lastMonth)} all of last month${m.projected !== null ? ` · lands at ${fmt(m.projected)} at this pace` : ""}`}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-semibold">{m.dept}</span>
                      <span className="text-xs text-muted tabnum"><b className="text-foreground">{fmt(m.mtd)}</b> so far · last month {fmt(m.lastMonth)}{m.projected !== null && <> · lands at <b className={toneCls[tone]}>{fmt(m.projected)}</b></>}</span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      <div className="h-1.5 rounded-sm bg-border/70 overflow-hidden"><div className="h-full rounded-sm" style={{ width: `${(m.lastMonth / max) * 100}%`, background: "var(--border-strong)" }} /></div>
                      <div className="h-2.5 rounded-sm bg-border/70 overflow-hidden relative">
                        {m.projected !== null && <span className="absolute inset-y-0 left-0 rounded-sm opacity-35" style={{ width: `${(m.projected / max) * 100}%`, background: toneVar[tone] }} />}
                        <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${(m.mtd / max) * 100}%`, background: "var(--series-fab)" }} />
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="text-[11px] text-muted"><span className="inline-block w-2.5 h-1.5 align-middle me-1 rounded-sm" style={{ background: "var(--border-strong)" }} />last month · <span className="inline-block w-2.5 h-2.5 align-middle me-1 rounded-sm" style={{ background: "var(--series-fab)" }} />this month so far · faded = where it lands</div>
            </div>
          </Card>
          <Card
            title="Floor · today"
            sub={machinePlanning
              ? "Attendance as the shift log has it, machine downtime this work week, and pieces a downstream department sent back that are not re-delivered yet"
              : "Pieces a downstream department sent back that are not re-delivered yet"}
          >
            <div className={`grid gap-3 text-sm ${machinePlanning ? "sm:grid-cols-3" : ""}`}>
              {machinePlanning && <>
              <div>
                <div className="text-[11px] font-bold text-muted uppercase tracking-wide mb-1">Attendance</div>
                {c.floor.attendance.map((a) => (
                  <div key={a.dept} className="flex items-baseline justify-between gap-2 border-t py-1">
                    <span className="text-xs">{a.label}</span>
                    {a.logged === 0 ? <span className="text-xs text-warn-fg">not logged</span> : <span className="tabnum text-xs"><b>{a.present}</b> / {a.logged}</span>}
                  </div>
                ))}
                <Link href="/shifts" className="text-xs text-accent font-semibold hover:underline">shift log →</Link>
              </div>
              <div>
                <div className="text-[11px] font-bold text-muted uppercase tracking-wide mb-1">Downtime · this week</div>
                <div className={`text-[2rem] font-extrabold leading-none ${c.floor.downtime.hours > 0 ? "text-warn-fg" : "text-ok-fg"}`}>{one(c.floor.downtime.hours)} h</div>
                <div className="text-[11px] text-muted mt-1">{c.floor.downtime.machines === 0 ? "no machine stood still" : `across ${fmt(c.floor.downtime.machines)} machine${c.floor.downtime.machines === 1 ? "" : "s"}`}</div>
                <Link href="/worklist/machines" className="text-xs text-accent font-semibold hover:underline">machines →</Link>
              </div>
              </>}
              <div>
                <div className="text-[11px] font-bold text-muted uppercase tracking-wide mb-1">Returns open</div>
                <div className={`text-[2rem] font-extrabold leading-none ${c.floor.openReturns.pieces > 0 ? "text-bad-fg" : "text-ok-fg"}`}>{fmt(c.floor.openReturns.pieces)}</div>
                <div className="text-[11px] text-muted mt-1">{c.floor.openReturns.lines === 0 ? "nothing sent back" : `pieces on ${fmt(c.floor.openReturns.lines)} return${c.floor.openReturns.lines === 1 ? "" : "s"} — fix first, they re-enter the flow`}</div>
                {machinePlanning && <Link href="/worklist/cut" className="text-xs text-accent font-semibold hover:underline">worklist →</Link>}
              </div>
            </div>
          </Card>
          <Card title="Last 6 weeks" sub={`Pieces per department per work week · dashed line = ${d.targetPerDeptDay * 6} a week`}>
            <HistoryChart history={d.history} targetPerDeptWeek={d.targetPerDeptDay * 6} />
          </Card>
        </div>
      </Band>

      {/* ==== the control loops, one line ==== */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted border rounded-xl bg-surface px-4 py-2">
        <Link href="/odoo" className="hover:text-accent"><b className={c.closing.open > 0 ? "text-warn-fg" : "text-ok-fg"}>{fmt(c.closing.open)}</b> Odoo closings open · <b className="text-foreground">{fmt(c.closing.needMo)}</b> need an MO</Link>
        <Link href="/material" className="hover:text-accent"><b className={c.material.overBom > 0 ? "text-bad-fg" : "text-ok-fg"}>{fmt(c.material.overBom)}</b> material lines over BOM · {fmt(c.material.notNested)} not nested</Link>
        {machinePlanning && <Link href="/shifts" className="hover:text-accent"><b className={shiftsIn === c.shifts.length ? "text-ok-fg" : "text-warn-fg"}>{shiftsIn}/{c.shifts.length}</b> shift logs in today · {c.shifts.map((s) => `${s.label} ${s.hours === null ? "—" : `${one(s.hours)}h`}`).join(" · ")}</Link>}
        <span className="ms-auto">{FINISHING_LABEL} = painting + the core&apos;s shot blast · <Link href="/report" className="text-accent hover:underline">printable report</Link></span>
      </div>
    </div>
  );
}
