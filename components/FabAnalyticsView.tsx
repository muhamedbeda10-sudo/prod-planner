"use client";

import Link from "next/link";
import type { FabAnalyticsData } from "@/lib/server/fabAnalytics";
import { SheetsPerDayChart, ThicknessChart } from "@/components/LazyCharts";

// 📊 Fabrication read in SHEETS.
//
// The plant counts pieces, and a piece is not a unit of work — a tank cut from
// four sheets and one cut from half a sheet are both "1". Everything on this
// page converts the daily log through the Material tab's bill of sheets, so
// the floor's day reads in the thing a laser actually spends it on. The
// coverage figure is deliberately loud: every reading here is only as good as
// the share of pieces the nesting sheet describes.

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
  const cov = Math.round(a.coverage * 100);
  const covTone = cov >= 80 ? "ok" : cov >= 50 ? "warn" : "bad";
  const windowWords = a.windowDays === 0 ? "everything on record" : `the last ${a.windowDays} days`;

  if (a.pieces === 0) {
    return (
      <p className="bg-surface border rounded-xl p-4 text-sm text-muted">
        No fabrication output recorded in {windowWords}. Widen the window, or record a day on the{" "}
        <Link href="/worklist/cut" className="text-accent font-semibold hover:underline">fabrication worklist</Link>.
      </p>
    );
  }

  // the spread across a single item is the whole argument for sheets over
  // pieces, so the range plot is scaled to the widest item on the page
  const widest = Math.max(1, ...a.items.map((i) => i.max));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile head="Sheets cut" value={n1(a.sheets)} sub={`${n1(a.sheetsPerDay)} a day over ${a.workedDays} working day(s)`} />
        <Tile head="Steel cut" value={n1(a.tons)} unit="t" sub={`${n2(a.tonsPerDay)} t a day`} />
        <Tile head="Pieces cut" value={n1(a.pieces)} sub={`${a.items.length} component(s) of the range`} />
        <Tile
          head="Nesting coverage"
          value={`${cov}%`}
          tone={covTone}
          sub={a.uncoveredPieces > 0 ? `${n1(a.uncoveredPieces)} pieces have no bill of sheets` : "every piece is nested"}
        />
      </div>

      <Section
        title="Sheets a day"
        sub={`Every fabrication record of the window, converted through its BOM's bill of sheets. The dashed line is the plant's own pace over these days — ${n1(a.sheetsPerDay)} sheets.`}
      >
        <SheetsPerDayChart days={a.days} avg={a.sheetsPerDay} />
      </Section>

      {/* each card keeps its own height — stretched to match, the shorter one
          became a large empty box */}
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section
          title="Where the sheets go"
          sub="Sheets cut per thickness. This is what decides which machine a job can go to — the thin end and the thick end are not the same plant."
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
          sub="Sheets per piece, per component. The bar is the range across the BOMs actually produced; the mark on it is the average. Where the range is wide, two orders of the same component are not the same job."
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
                    title={`${i.item}: ${n2(i.min)} to ${n2(i.max)} sheets a piece, ${n2(i.avg)} on average · ${n1(i.pieces)} pieces over ${i.boms} BOM(s)`}
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

      <Section title="How much of this is real" sub="Everything above rests on the Material tab. This is how much of the floor it describes.">
        <div className="grid sm:grid-cols-3 gap-3 text-xs">
          <p>
            <b className="tabnum text-sm">{cov}%</b> of the pieces cut in {windowWords} have a bill of sheets.
            {a.uncoveredPieces > 0 && <> The other <b className="tabnum">{n1(a.uncoveredPieces)}</b> are counted as pieces and contribute no sheets, so the rates read low rather than flattering.</>}
          </p>
          <p>
            The tab holds <b className="tabnum">{a.nestingRows}</b> nesting line(s) over <b className="tabnum">{a.nestingBoms}</b> BOM(s).
            Nest a BOM on the{" "}
            <Link href="/material" className="text-accent font-semibold hover:underline">Material tab</Link> and it joins this page at once.
          </p>
          <p className="text-muted">
            A BOM planned in several months takes its NEWEST nesting, never the sum of them. Tonnes come from the sheet
            size, the thickness and the material&apos;s own density.
          </p>
        </div>
        {a.uncoveredBoms.length > 0 && (
          <div className="mt-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">Produced with no nesting, heaviest first</div>
            <div className="flex flex-wrap gap-1">
              {a.uncoveredBoms.slice(0, 24).map((b) => (
                <Link
                  key={b.bom}
                  href={`/material?bom=${encodeURIComponent(b.bom)}`}
                  className="pill pill-warn ltr hover:underline"
                  title={`${n1(b.pieces)} pieces cut with no bill of sheets — nest it on the Material tab`}
                >
                  {b.bom} <span className="tabnum opacity-75">×{n1(b.pieces)}</span>
                </Link>
              ))}
              {a.uncoveredBoms.length > 24 && (
                <span className="pill pill-muted">+{a.uncoveredBoms.length - 24} more</span>
              )}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
