"use client";

import Link from "next/link";
import type { FabAnalyticsData } from "@/lib/server/fabAnalytics";
import { SheetsPerDayChart, ThicknessChart } from "@/components/LazyCharts";

// 📊 Material consumed, read in SHEETS and tonnes.
//
// An order's material is booked on the day its MO is closed on Odoo (moved
// to Done on the ODOO tab): the closed quantity × the sheets one unit takes
// on the Material tab's lines of that same MO. Closings of MOs the material
// sheet does not carry (the older orders) stay off the page.

const n1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const n2 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Tile({ head, value, unit, sub, tone }: { head: string; value: string; unit?: string; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "ok" ? "var(--ok-fg)" : tone === "warn" ? "var(--warn-fg)" : tone === "bad" ? "var(--bad-fg)" : undefined;
  return (
    <div className="bg-surface border rounded-xl p-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{head}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-extrabold tabnum leading-none" style={color ? { color } : undefined}>{value}</span>
        {unit && <span className="text-xs font-bold text-muted">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface border rounded-xl p-3 min-w-0">
      <h2 className="text-sm font-extrabold">{title}</h2>
      {sub && <p className="text-[11px] text-muted mt-0.5 mb-2">{sub}</p>}
      {children}
    </section>
  );
}

export function FabAnalyticsView({ a }: { a: FabAnalyticsData }) {
  const windowWords = a.windowDays === 0 ? "everything on record" : `the last ${a.windowDays} days`;

  if (a.pieces === 0) {
    return (
      <p className="bg-surface border rounded-xl p-4 text-sm text-muted">
        No MO of the material sheet was closed on Odoo in {windowWords}. The material is booked here the day one of its MOs is moved to Done on the{" "}
        <Link href="/odoo" className="text-accent font-semibold hover:underline">ODOO tab</Link>.
      </p>
    );
  }

  // the spread across a single item is the whole argument for sheets over
  // pieces, so the range plot is scaled to the widest item on the page
  const widest = Math.max(1, ...a.items.map((i) => i.max));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile head="Sheets consumed" value={n1(a.sheets)} sub={`${n1(a.sheetsPerDay)} a day over ${a.workedDays} closing day(s)`} />
        <Tile head="Steel consumed" value={n1(a.tons)} unit="t" sub={`${n2(a.tonsPerDay)} t a day`} />
        <Tile head="Units closed on Odoo" value={n1(a.pieces)} sub={`${a.closings.length} closing(s) · ${a.items.length} component(s)`} />
        <Tile head="MOs closed" value={String(new Set(a.closings.map((c) => c.mo.toUpperCase())).size)} sub="of the material sheet's MOs" />
      </div>

      <Section
        title="Sheets consumed a day"
        sub={`Booked on the day each MO was closed on Odoo, through the Material tab's lines of the same MO. The dashed line is the pace over these days — ${n1(a.sheetsPerDay)} sheets.`}
      >
        <SheetsPerDayChart days={a.days} avg={a.sheetsPerDay} />
      </Section>

      {/* each card keeps its own height — stretched to match, the shorter one
          became a large empty box */}
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section
          title="Where the sheets go"
          sub="Sheets consumed per thickness, over the MOs closed in the window."
        >
          <ThicknessChart rows={a.thicknesses} />
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-muted">
                  <th className="p-1">Thickness</th>
                  <th className="p-1 text-end">Sheets</th>
                  <th className="p-1 text-end">Share</th>
                  <th className="p-1 text-end">Tonnes</th>
                </tr>
              </thead>
              <tbody>
                {a.thicknesses.map((t) => (
                  <tr key={t.thicknessMm}>
                    <td className="p-1 font-bold tabnum">{t.thicknessMm} mm</td>
                    <td className="p-1 text-end tabnum">{n1(t.sheets)}</td>
                    <td className="p-1 text-end tabnum">{(t.share * 100).toFixed(1)}%</td>
                    <td className="p-1 text-end tabnum text-muted">{n1(t.kg / 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="What one piece really costs"
          sub="Sheets per unit, per component. The bar is the range across the MOs closed; the mark on it is the average. Where the range is wide, two orders of the same component are not the same job."
        >
          <div className="space-y-2">
            {a.items.map((i) => {
              const left = (i.min / widest) * 100;
              const width = Math.max(1.5, ((i.max - i.min) / widest) * 100);
              const at = (i.avg / widest) * 100;
              return (
                <div key={i.item} className="flex items-center gap-2 text-xs">
                  <span className="w-8 shrink-0 font-extrabold">{i.item}</span>
                  <span
                    className="relative flex-1 h-6 rounded-md bg-surface-2"
                    title={`${i.item}: ${n2(i.min)} to ${n2(i.max)} sheets a unit, ${n2(i.avg)} on average · ${n1(i.pieces)} units over ${i.boms} MO(s)`}
                  >
                    <span
                      className="absolute top-1.5 bottom-1.5 rounded-[3px]"
                      style={{ left: `${left}%`, width: `${width}%`, background: "var(--viz-2)", opacity: 0.35 }}
                    />
                    {/* the average, ringed in the surface so it stays visible on the band */}
                    <span
                      className="absolute top-1/2 w-2.5 h-2.5 rounded-full"
                      style={{
                        left: `${at}%`,
                        transform: "translate(-50%, -50%)",
                        background: "var(--viz-2)",
                        boxShadow: "0 0 0 2px var(--surface)",
                      }}
                    />
                  </span>
                  <span className="w-32 shrink-0 text-end tabnum text-muted">
                    <b className="text-foreground">{n2(i.avg)}</b> · {n2(i.min)}–{n2(i.max)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted mt-2">
            Multiply a component&apos;s average by an order&apos;s quantity to size a new job in sheets before anyone nests it.
          </p>
        </Section>
      </div>

      <Section title="MOs closed" sub="Each closing and what it consumed — the sheets and tonnes are booked on its day.">
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-left text-muted">
                <th className="p-1">Closed</th>
                <th className="p-1">MO</th>
                <th className="p-1">Part</th>
                <th className="p-1 text-end">Units</th>
                <th className="p-1 text-end">Sheets</th>
                <th className="p-1 text-end">Tonnes</th>
              </tr>
            </thead>
            <tbody>
              {a.closings.map((c, i) => (
                <tr key={`${c.mo}-${c.dateISO}-${i}`} className="border-t">
                  <td className="p-1 tabnum whitespace-nowrap">{c.dateISO}</td>
                  <td className="p-1 ltr font-bold whitespace-nowrap">{c.mo}</td>
                  <td className="p-1">{c.item ?? "—"}</td>
                  <td className="p-1 text-end tabnum">{n1(c.qty)}</td>
                  <td className="p-1 text-end tabnum">{n2(c.sheets)}</td>
                  <td className="p-1 text-end tabnum text-muted">{n2(c.kg / 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <p className="text-[11px] text-muted">
        Only the MOs on the{" "}
        <Link href="/material" className="text-accent font-semibold hover:underline">material sheet</Link> are counted ({a.nestingBoms} MO(s), {a.nestingRows} line(s)).
        A unit takes the actual nesting&apos;s sheets where the sheet has them, else the BOM&apos;s; tonnes use the sheet&apos;s Weight(Kg).
      </p>
    </div>
  );
}
