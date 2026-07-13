import { prisma } from "@/lib/db";
import { PageHeader, Num } from "@/components/ui";
import { toISODate } from "@/lib/domain/dates";
import { ITEMS } from "@/lib/domain/constants";
import { groupKey } from "@/lib/domain/bom";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; bom?: string; mo?: string }>;
}) {
  const sp = await searchParams;
  const planNo = Number(sp.plan) || 0; // where the user came from (back link + highlight)
  const mo = (sp.mo ?? "").trim(); // MO mode: everything scoped to one manufacturing order
  const bom = (sp.bom ?? "").trim();

  if (!bom && !mo) return <p className="text-muted">No BOM or MO specified.</p>;

  const scope = mo ? { mo } : { bom };

  // Full history for this code/MO — across EVERY plan/week. Remarks come from
  // the MONTHLY registry (MasterOrder), not the weekly plan lines.
  const [orders, handover, moves, allBoms, masters, plans] = await Promise.all([
    prisma.planOrder.findMany({ where: scope, orderBy: [{ planNo: "asc" }, { mo: "asc" }, { item: "asc" }] }),
    prisma.handoverEntry.findMany({ where: scope, orderBy: [{ date: "asc" }, { id: "asc" }] }),
    mo
      ? Promise.resolve([])
      : prisma.reallocationMove.findMany({ where: { OR: [{ fromBom: bom }, { toBom: bom }] }, orderBy: { id: "asc" } }),
    mo ? Promise.resolve([]) : prisma.planOrder.findMany({ select: { bom: true }, distinct: ["bom"] }),
    prisma.masterOrder.findMany({ where: scope }),
    prisma.plan.findMany(),
  ]);

  // The plan lands once a month and the team calls it by its month ("July plan").
  // Label every plan by its start month; keep the number only to disambiguate
  // two plans landing in the same month. Plan 0 = the opening setup balances.
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const planMonth = new Map(plans.map((p) => [p.planNo, `${MONTHS[p.startDate.getUTCMonth()]} ${p.startDate.getUTCFullYear()}`]));
  const monthCount = new Map<string, number>();
  for (const m2 of planMonth.values()) monthCount.set(m2, (monthCount.get(m2) ?? 0) + 1);
  const planLabel = (n: number) => {
    if (n === 0) return "Setup balances";
    const m2 = planMonth.get(n);
    if (!m2) return `Plan ${n}`;
    return (monthCount.get(m2) ?? 0) > 1 ? `${m2} · P${n}` : m2;
  };

  const remarksByMo = new Map(masters.map((m) => [m.mo, (m.remarks ?? "").trim()]));
  const masterBom = masters[0]?.bom ?? orders[0]?.bom ?? "";

  // family siblings (same base + M number) known anywhere in plan orders — BOM mode only
  const fam = bom ? groupKey(bom.toUpperCase()) : "";
  const siblings = [...new Set(allBoms.map((b) => b.bom))]
    .filter((b) => b !== bom && groupKey(b.toUpperCase()) === fam)
    .sort();

  // all-time totals + per-week breakdown
  const total: Record<string, Record<string, number>> = { Cut: {}, Welding: {}, Painting: {} };
  const perWeek = new Map<number, Record<string, Record<string, number>>>();
  for (const h of handover) {
    total[h.dept][h.item] = (total[h.dept][h.item] ?? 0) + h.qty;
    if (!perWeek.has(h.planNo)) perWeek.set(h.planNo, { Cut: {}, Welding: {}, Painting: {} });
    const w = perWeek.get(h.planNo)!;
    w[h.dept][h.item] = (w[h.dept][h.item] ?? 0) + h.qty;
  }
  const weeks = [...perWeek.keys()].sort((a, b) => a - b);
  const orderPlans = [...new Set(orders.map((o) => o.planNo))].sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Trace — ${mo || bom}`}
        sub={`Full history across every plan · ${handover.length} handover records · plans: ${orderPlans.map(planLabel).join(" · ") || "—"}`}
      >
        <Link href={planNo ? `/tracker?plan=${planNo}` : "/tracker"} className="text-accent text-sm font-semibold">
          → Back to tracker
        </Link>
      </PageHeader>

      {mo && masterBom && (
        <p className="text-sm bg-brand-light text-brand rounded-lg px-3 py-2 inline-block">
          BOM: <Link href={`/trace?plan=${planNo}&bom=${encodeURIComponent(masterBom)}`} className="font-bold underline">{masterBom}</Link>
          {remarksByMo.get(mo) ? <> · Remarks: <b>{remarksByMo.get(mo)}</b></> : null}
        </p>
      )}

      {siblings.length > 0 && (
        <p className="text-sm bg-brand-light text-brand rounded-lg px-3 py-2 inline-block">
          Same family (base + M number):{" "}
          {siblings.map((s, i) => (
            <span key={s}>
              {i > 0 && " · "}
              <Link href={`/trace?plan=${planNo}&bom=${encodeURIComponent(s)}`} className="font-bold underline">{s}</Link>
            </span>
          ))}
        </p>
      )}

      {/* all-time totals */}
      <section>
        <h2>All-time handover totals</h2>
        <div className="flex flex-wrap gap-3">
          {ITEMS.map((it) => (
            <div key={it} className="bg-surface border rounded-lg px-4 py-2">
              <div className="font-bold">{it}</div>
              <div className="text-xs text-muted">
                Cut: <b className="text-foreground">{total.Cut[it] ?? 0}</b> · Welded: <b className="text-foreground">{total.Welding[it] ?? 0}</b> · Painted: <b className="text-foreground">{total.Painting[it] ?? 0}</b>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* per-week breakdown */}
      {weeks.length > 0 && (
        <section>
          <h2>Output per plan</h2>
          <div className="bg-surface border rounded-xl overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-center">
                  <th className="p-2 text-left">Plan</th>
                  {ITEMS.map((it) => <th key={it} colSpan={3} className="p-2 border-l border-white/20">{it}</th>)}
                </tr>
                <tr className="bg-brand-dark text-white text-[10px]">
                  <th className="p-1"></th>
                  {ITEMS.map((it) => (
                    <FragmentCW key={it} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => {
                  const d = perWeek.get(w)!;
                  return (
                    <tr key={w} className={`text-center ${w === planNo ? "bg-brand-light" : ""}`}>
                      <td className="p-2 text-left font-bold whitespace-nowrap">
                        {planLabel(w)} {w === planNo && planNo > 0 && <span className="pill pill-ok ml-1">current</span>}
                      </td>
                      {ITEMS.map((it) => (
                        <FragmentCells key={it} cut={d.Cut[it] ?? 0} weld={d.Welding[it] ?? 0} paint={d.Painting[it] ?? 0} />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* plan orders across every plan */}
      <section>
        <h2>Plan orders — every plan this code was planned in</h2>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2 text-center">Plan</th>
                <th className="p-2">MO</th><th className="p-2">Description</th>
                <th className="p-2 text-center">Item</th><th className="p-2 text-center">Required</th>
                <th className="p-2 text-center">Planner balance</th><th className="p-2 text-center">Target</th>
                <th className="p-2 text-left">Remark (monthly)</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-muted">This code does not appear in any imported plan.</td></tr>
              )}
              {orders.map((o) => (
                <tr key={o.id} className={o.planNo === planNo ? "bg-brand-light/50" : ""}>
                  <td className="p-2 text-center font-bold text-xs whitespace-nowrap">{planLabel(o.planNo)}</td>
                  <td className="p-2 text-xs">{o.mo}</td>
                  <td className="p-2 text-xs text-muted">{o.description}</td>
                  <td className="p-2 text-center font-bold">{o.item}</td>
                  <td className="p-2 text-center"><Num v={o.requiredQty} /></td>
                  <td className="p-2 text-center">{o.plannerBalance ?? "—"}</td>
                  <td className="p-2 text-center"><Num v={o.targetQty} /></td>
                  <td className="p-2 text-xs">{remarksByMo.get(o.mo) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* full handover history */}
      <section>
        <h2>Handover records — all plans ({handover.length})</h2>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2">Date</th>
                <th className="p-2 text-center">Plan</th>
                <th className="p-2">Dept</th>
                <th className="p-2 text-center">Item</th><th className="p-2 text-center">Qty</th>
                <th className="p-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {handover.length === 0 && (
                <tr><td colSpan={6} className="p-4 text-center text-muted">No handover records for this code yet.</td></tr>
              )}
              {handover.map((h, i) => (
                <tr key={h.id} className={i % 2 ? "bg-zebra" : ""}>
                  <td className="p-2">{toISODate(h.date)}</td>
                  <td className="p-2 text-center font-bold text-xs whitespace-nowrap">{planLabel(h.planNo)}</td>
                  <td className="p-2">{h.dept}</td>
                  <td className="p-2 text-center font-bold">{h.item}</td>
                  <td className="p-2 text-center font-bold tabnum">{h.qty}</td>
                  <td className="p-2 text-xs text-muted">
                    {h.source}
                    {h.bomRaw && h.bomRaw !== h.bom && <span className="pill pill-ok ml-1" title={`corrected from ${h.bomRaw}`}>fixed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {moves.length > 0 && (
        <section>
          <h2>Reallocation moves</h2>
          <ul className="text-sm list-disc ml-6">
            {moves.map((m) => (
              <li key={m.id}>{planLabel(m.planNo)}: {m.dept} {m.item}: {m.fromBom} → {m.toBom} = {m.qty} ({m.status})</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FragmentCW() {
  return (
    <>
      <th className="p-1 font-medium border-l border-white/20">Cut</th>
      <th className="p-1 font-medium">Weld</th>
      <th className="p-1 font-medium">Paint</th>
    </>
  );
}

function FragmentCells({ cut, weld, paint }: { cut: number; weld: number; paint: number }) {
  return (
    <>
      <td className="p-2 tabnum border-l" style={{ background: "var(--cut-tint)" }}>{cut}</td>
      <td className="p-2 tabnum" style={{ background: "var(--weld-tint)" }}>{weld}</td>
      <td className="p-2 tabnum" style={{ background: "var(--paint-tint)" }}>{paint}</td>
    </>
  );
}
