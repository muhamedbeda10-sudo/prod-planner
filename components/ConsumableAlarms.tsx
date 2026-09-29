import { ChartCard, StatTile, type TableRow } from "@/components/charts/kit";
import { departmentLabel } from "@/lib/domain/consumables";
import { PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import type { AlarmRow, LimitDashboard } from "@/lib/server/consumableLimits";

// The CONSUMABLES dashboard's alarms: the limits, in two tenses —
//   now ........ every rule in its current window (this month, this
//                quarter …) that is past its number — an alarm is a limit
//                exceeded, nothing less;
//   the period . every finished window touching the slicer's period that
//                ended over a limit, and the hand-outs recorded over one
//                with the reason the recorder gave.

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 3 }));

/** Used against the limit: the bar is scaled to whichever is larger, the
 *  limit marked on it, so "over" reads as the part past the mark. */
function BulletBar({ used, limit }: { used: number; limit: number }) {
  const top = Math.max(used, limit, 1e-9);
  const over = used > limit + 1e-9;
  const tone = over ? "var(--bad-fg)" : "var(--ok-fg)";
  return (
    <div className="relative h-2.5 rounded-full bg-surface-2 min-w-[8rem]" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(used / top) * 100}%`, background: tone }} />
      <div className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-[var(--foreground)]" style={{ left: `calc(${(limit / top) * 100}% - 1px)` }} title={`limit ${fmt(limit)}`} />
    </div>
  );
}

function AlarmLine({ a }: { a: AlarmRow }) {
  const over = a.basis === "person" ? a.over.length > 0 : a.used > a.limit + 1e-9;
  return (
    <li className="py-2 grid gap-1 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center">
      <div className="min-w-0">
        <div className="font-semibold truncate" title={a.item}>
          {over ? "⚠ " : ""}{a.item} <span className="text-xs text-muted ltr font-normal">{a.code ?? ""}</span>
        </div>
        <div className="text-xs text-muted">
          {a.departmentsLabel} · {fmt(a.limit)} {a.uom} {PERIOD_LABEL[a.period]}{a.basis === "person" ? " per person" : ""} · {a.windowLabel}
        </div>
        {a.basis === "person" && a.over.length > 0 && (
          <div className="text-xs text-bad-fg">{a.over.slice(0, 4).map((w) => `${w.name} (${w.empId}) ${fmt(w.used)}`).join(" · ")}{a.over.length > 4 ? ` · +${a.over.length - 4} more` : ""}</div>
        )}
      </div>
      <BulletBar used={a.used} limit={a.limit} />
      <div className="text-sm tabnum text-end whitespace-nowrap">
        <b className={over ? "text-bad-fg" : ""}>{fmt(a.used)}</b>
        <span className="text-muted"> / {fmt(a.limit)}{a.basis === "person" ? " (top worker)" : ""}</span>
      </div>
    </li>
  );
}

export function ConsumableAlarms({ d, periodLabel, period }: { d: LimitDashboard; periodLabel: string; period: string }) {
  const isOver = (a: AlarmRow) => (a.basis === "person" ? a.over.length > 0 : a.used > a.limit + 1e-9);
  const overNow = d.board.filter(isOver);
  const file = (name: string) => `consumables-${name}-${period}.xlsx`;

  const boardRows: TableRow[] = overNow.map((a) => ({
    Item: a.item, Code: a.code ?? "", Departments: a.departmentsLabel, Limit: a.limit, UOM: a.uom, Per: PERIOD_LABEL[a.period],
    Counted: a.basis === "person" ? "per person" : "shared", Window: a.windowLabel, Used: a.used, "Used %": `${Math.round(a.ratio * 100)}%`,
    "Workers over": a.over.map((w) => `${w.name} (${w.empId}) ${w.used}`).join(" · "),
  }));
  const exRows: TableRow[] = d.exceedances.map((e) => ({
    Window: e.windowLabel, Item: e.item, Code: e.code ?? "", Departments: e.departmentsLabel, Per: PERIOD_LABEL[e.period],
    Worker: e.worker ? `${e.worker.name} (${e.worker.empId})` : "", Used: e.used, Limit: e.limit, Over: Math.round((e.used - e.limit) * 1000) / 1000,
  }));
  const issueRows: TableRow[] = d.overLimitIssues.map((i) => ({
    Day: i.dayISO, Item: i.item, Qty: i.qty, Department: departmentLabel(i.department), "Went to": i.worker.name,
    Reason: i.reason ?? "", Breach: i.note ?? "", "Recorded by": i.recordedBy,
  }));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <StatTile label="Over a limit now" value={fmt(overNow.length)} sub={overNow.length ? "limits past their number this month (or their months so far)" : "✓ every limit within its number"} />
        <StatTile label="Closed over a limit" value={fmt(d.exceedances.length)} sub={`past months (or longer limits) that ended over, ${periodLabel}`} />
        <StatTile label="Recorded over a limit" value={fmt(d.overLimitIssues.length)} sub={`hand-outs with a reason, ${periodLabel}`} />
        {d.uncatalogued > 0 && <StatTile label="Not in the catalogue" value={fmt(d.uncatalogued)} sub="hand-outs no limit counts — add the item?" />}
      </div>

      <ChartCard
        title="Alarms now"
        sub={overNow.length ? "Every limit past its number in its current window — this month, or its months so far — the mark on each bar is the limit" : "No limit is past its number this month"}
        table={{ rows: boardRows, filename: file("limits-now"), sheet: "Limits now" }}
      >
        {overNow.length === 0 ? <p className="text-sm text-ok-fg">✓ Every item is within its limits.</p> : (
          <ul className="divide-y">{overNow.map((a) => <AlarmLine key={a.ruleId} a={a} />)}</ul>
        )}
      </ChartCard>

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard
          title="Past months over the limit"
          sub={d.exceedances.length ? `Each finished month (or longer limit) on the slicer that ended over its number — the running month is under Alarms now` : `No finished month went over a limit ${periodLabel}`}
          table={d.exceedances.length ? { rows: exRows, filename: file("exceeded"), sheet: "Exceeded" } : undefined}
        >
          {d.exceedances.length > 0 ? (
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-sm">
                <thead className="border-b sticky top-0 bg-surface">
                  <tr className="text-xs text-muted text-left"><th className="p-1.5">When</th><th className="p-1.5">Item</th><th className="p-1.5">For</th><th className="p-1.5 text-end">Used / limit</th></tr>
                </thead>
                <tbody className="divide-y">
                  {d.exceedances.slice(0, 100).map((e, k) => (
                    <tr key={k}>
                      <td className="p-1.5 whitespace-nowrap text-xs">{e.windowLabel}</td>
                      <td className="p-1.5"><b>{e.item}</b></td>
                      <td className="p-1.5 text-xs">{e.worker ? `${e.worker.name} (${e.worker.empId})` : e.departmentsLabel}</td>
                      <td className="p-1.5 text-end tabnum whitespace-nowrap"><b className="text-bad-fg">{fmt(e.used)}</b> / {fmt(e.limit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-ok-fg">✓ Nothing to show.</p>}
        </ChartCard>

        <ChartCard
          title="Recorded over a limit"
          sub={d.overLimitIssues.length ? "The recorder was warned and gave the reason" : `No hand-out was recorded over a limit ${periodLabel}`}
          table={d.overLimitIssues.length ? { rows: issueRows, filename: file("over-limit-hand-outs"), sheet: "Over limit" } : undefined}
        >
          {d.overLimitIssues.length > 0 ? (
            <ul className="divide-y max-h-[420px] overflow-auto">
              {d.overLimitIssues.map((i) => (
                <li key={i.id} className="py-1.5 text-sm">
                  <div><span className="text-xs text-muted tabnum">{i.dayISO}</span> · <b>{fmt(i.qty)} × {i.item}</b> → {i.worker.name} <span className="text-xs text-muted">({departmentLabel(i.department)})</span></div>
                  <div className="text-xs"><span className="text-bad-fg font-semibold">“{i.reason ?? "no reason"}”</span> <span className="text-muted">— {i.recordedBy}</span></div>
                  {i.note && <div className="text-[11px] text-muted">{i.note}</div>}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ok-fg">✓ Nothing to show.</p>}
        </ChartCard>
      </div>
    </section>
  );
}
