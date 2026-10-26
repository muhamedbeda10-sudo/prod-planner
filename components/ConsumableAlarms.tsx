import { ChartCard, StatTile, type TableRow } from "@/components/charts/kit";
import { TableFrame, Th } from "@/components/DataTable";
import { departmentLabel } from "@/lib/domain/consumables";
import { PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import { monthShort } from "@/lib/domain/consumableMonthly";
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

// Every limit reaches here as a department's own or a shared one — an "each
// department" or per-worker limit was made into each department's number
// (the label says so: "Welding TX (2 per worker × 12 workers)").
const isOver = (a: Pick<AlarmRow, "used" | "limit">) => a.used > a.limit + 1e-9;

function AlarmLine({ a }: { a: AlarmRow }) {
  const over = isOver(a);
  return (
    <li className="py-2 grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center">
      <div className="min-w-0">
        <div className="font-semibold truncate" title={a.item}>
          {over ? "⚠ " : ""}{a.item} <span className="text-xs text-muted ltr font-normal">{a.code ?? ""}</span>
        </div>
        <div className="text-xs text-muted">
          {a.departmentsLabel} · {fmt(a.limit)} {a.uom} {PERIOD_LABEL[a.period]} · {a.windowLabel}
        </div>
      </div>
      <BulletBar used={a.used} limit={a.limit} />
      <div className="text-sm tabnum text-end whitespace-nowrap">
        <b className={over ? "text-bad-fg" : ""}>{fmt(a.used)}</b>
        <span className="text-muted"> / {fmt(a.limit)}</span>
        {over && <div className="text-xs text-bad-fg font-semibold">+{fmt(Math.round((a.used - a.limit) * 1000) / 1000)} over</div>}
      </div>
    </li>
  );
}

export function ConsumableAlarms({ d, periodLabel }: { d: LimitDashboard; periodLabel: string }) {
  const overNow = d.board.filter(isOver);
  // the past card looks back over the last finished months, whatever the slicer
  const pastLabel = `${monthShort(d.exceedanceSpan.from.slice(0, 7))} – ${monthShort(d.exceedanceSpan.to.slice(0, 7))}`;

  const boardRows: TableRow[] = overNow.map((a) => ({
    Item: a.item, Code: a.code ?? "", Departments: a.departmentsLabel, Limit: a.limit, UOM: a.uom, Per: PERIOD_LABEL[a.period],
    Window: a.windowLabel, Used: a.used, Over: Math.round((a.used - a.limit) * 1000) / 1000, "Used %": `${Math.round(a.ratio * 100)}%`,
  }));
  const exRows: TableRow[] = d.exceedances.map((e) => ({
    Window: e.windowLabel, Item: e.item, Code: e.code ?? "", Departments: e.departmentsLabel, Per: PERIOD_LABEL[e.period],
    Used: e.used, Limit: e.limit, Over: Math.round((e.used - e.limit) * 1000) / 1000,
  }));
  const issueRows: TableRow[] = d.overLimitIssues.map((i) => ({
    Day: i.dayISO, Item: i.item, Qty: i.qty, Department: departmentLabel(i.department), "Went to": i.worker.name,
    Reason: i.reason ?? "", Breach: i.note ?? "", "Recorded by": i.recordedBy,
  }));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <StatTile label="Over a limit now" value={fmt(overNow.length)} sub={overNow.length ? undefined : "✓ all within limits"} about="Limits past their number in their current window: this month, or a limit of several months over its months so far." />
        <StatTile label="Closed over a limit" value={fmt(d.exceedances.length)} sub={pastLabel} about={`Months (or longer limits) that ended over their number, ${pastLabel}.`} />
        <StatTile label="Recorded over a limit" value={fmt(d.overLimitIssues.length)} sub={periodLabel} about={`Hand-outs recorded over a limit, each with the reason the recorder gave, ${periodLabel}.`} />
        {d.uncatalogued > 0 && <StatTile label="Not in the catalogue" value={fmt(d.uncatalogued)} about="Hand-outs of items not in the catalogue, which no limit counts — add the item to the catalogue to count them." />}
      </div>

      <ChartCard
        title="Alarms now"
        about={overNow.length ? "Every limit past its number in its current window — this month, or its months so far — the mark on each bar is the limit" : "No limit is past its number this month"}
        data={boardRows}
      >
        {overNow.length === 0 ? <p className="text-sm text-ok-fg">✓ Every item is within its limits.</p> : (
          <ul className="divide-y">{overNow.map((a) => <AlarmLine key={a.ruleId} a={a} />)}</ul>
        )}
      </ChartCard>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ChartCard
          title="Past months over the limit"
          about={d.exceedances.length
            ? `The last finished months (${pastLabel}) whatever the slicer — each month (or longer limit) that ended over its number, per-worker limits with that month's workers. The running month is under Alarms now.`
            : `No month went over a limit ${pastLabel}`}
          data={d.exceedances.length ? exRows : undefined}
        >
          {d.exceedances.length > 0 ? (
            <TableFrame className="max-h-[420px]">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left">
                    <Th label="When" />
                    <Th label="Item" />
                    <Th label="For" full="The department(s) the limit covers" />
                    <Th label="Used" num className="text-right" />
                    <Th label="Limit" num className="text-right" />
                    <Th label="Over" num className="text-right" />
                  </tr>
                </thead>
                <tbody>
                  {d.exceedances.slice(0, 100).map((e, k) => (
                    <tr key={k}>
                      <td className="p-2 whitespace-nowrap text-xs">{e.windowLabel}</td>
                      <td className="p-2"><b>{e.item}</b>{e.code && <div className="text-[11px] text-muted ltr">{e.code}</div>}</td>
                      <td className="p-2 text-xs">{e.departmentsLabel}</td>
                      <td className="p-2 text-right tabnum"><b className="text-bad-fg">{fmt(e.used)}</b></td>
                      <td className="p-2 text-right tabnum">{fmt(e.limit)}</td>
                      <td className="p-2 text-right tabnum text-bad-fg">+{fmt(Math.round((e.used - e.limit) * 1000) / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          ) : <p className="text-sm text-ok-fg">✓ Nothing to show.</p>}
        </ChartCard>

        <ChartCard
          title="Recorded over a limit"
          about={d.overLimitIssues.length ? "The recorder was warned and gave the reason" : `No hand-out was recorded over a limit ${periodLabel}`}
          data={d.overLimitIssues.length ? issueRows : undefined}
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
