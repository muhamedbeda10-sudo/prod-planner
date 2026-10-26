"use client";

import { hrefWithLine } from "@/lib/domain/lines";
import { Layers } from "lucide-react";
import { EmptyState } from "@/components/primitives";

import Link from "next/link";
import type { MaterialDashboardData } from "@/lib/server/fabAnalytics";
import type { Breakdown, MoRow } from "@/lib/domain/materialDashboard";
import { SheetsPerDayChart, ThicknessChart } from "@/components/LazyCharts";
import { ChartAbout } from "@/components/ChartAbout";

// 📊 The MATERIAL dashboard.
//
// Top: what the window CONSUMED — booked the day each MO of the material
// sheet was closed on Odoo — and the scrap in it. Then the sheet as a whole:
// planned by the BOM, nested, the nesting against the BOM, utilization,
// scrap and what the open MOs will still take. Then where the steel goes:
// per day, thickness, material, sheet size and part, and the MOs worth a look.

const n1 = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
const n2 = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const t = (kg: number) => n2(kg / 1000);
const pct = (f: number | null) => (f === null ? "—" : `${(f * 100).toFixed(1)}%`);

type Tone = "ok" | "warn" | "bad";

function Tile({ head, value, unit, sub, tone }: { head: string; value: string; unit?: string; sub?: React.ReactNode; tone?: Tone }) {
  const color = tone === "ok" ? "var(--ok-fg)" : tone === "warn" ? "var(--warn-fg)" : tone === "bad" ? "var(--bad-fg)" : undefined;
  return (
    <div className="bg-surface border rounded-xl p-3 min-w-0">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{head}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-extrabold tabnum leading-none" style={color ? { color } : undefined}>{value}</span>
        {unit && <span className="text-xs font-bold text-muted">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-muted mt-1 truncate" title={typeof sub === "string" ? sub : undefined}>{sub}</div>}
    </div>
  );
}

/** A card: its title on screen, what it shows (`about`) for "Ask AI". */
function Section({ title, about, children }: { title: string; about?: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface border rounded-xl p-3 min-w-0" data-ai-title={title} data-ai-about={about}>
      <h2 className="text-sm font-extrabold mb-2"><ChartAbout title={title} about={about} /></h2>
      {children}
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="text-xs font-extrabold uppercase tracking-wider text-muted">{title}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>
    </div>
  );
}

/** Tonnes per key as bars, the scrap in them in red at the end. */
function Bars({ rows }: { rows: Breakdown[] }) {
  if (rows.length === 0) return <p className="text-xs text-muted">Nothing yet.</p>;
  const max = Math.max(...rows.map((r) => r.kg), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="text-xs">
          <div className="flex items-baseline gap-2">
            <span className="font-bold truncate ltr">{r.key}</span>
            <span className="ms-auto tabnum"><b>{t(r.kg)}</b> t · {n1(r.sheets)} sheets</span>
            <span className="tabnum text-muted w-10 text-end">{(r.share * 100).toFixed(0)}%</span>
          </div>
          <div className="relative h-2 rounded bg-surface-2 mt-0.5 overflow-hidden" title={r.scrapKg > 0 ? `${t(r.scrapKg)} t of it scrap` : undefined}>
            <span className="absolute inset-y-0 start-0 rounded" style={{ width: `${(r.kg / max) * 100}%`, background: "var(--viz-2)" }} />
            {r.scrapKg > 0 && (
              <span className="absolute inset-y-0" style={{ insetInlineStart: `${((r.kg - r.scrapKg) / max) * 100}%`, width: `${(r.scrapKg / max) * 100}%`, background: "var(--bad-fg)", opacity: 0.75 }} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function MoTable({ rows, value, head }: { rows: MoRow[]; value: (m: MoRow) => number | null; head: string }) {
  if (rows.length === 0) return <EmptyState compact icon={Layers} title="Nothing to show yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-muted">
            <th className="p-1">MO</th>
            <th className="p-1">SOI</th>
            <th className="p-1">Part</th>
            <th className="p-1 text-end">Units</th>
            <th className="p-1 text-end">Nested t</th>
            <th className="p-1 text-end">Utilization</th>
            <th className="p-1 text-end">{head}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.mo} className="border-t">
              <td className="p-1 ltr font-bold whitespace-nowrap">{m.mo}</td>
              <td className="p-1 ltr whitespace-nowrap text-muted">{m.soi || "—"}</td>
              <td className="p-1 whitespace-nowrap">{m.part || "—"}</td>
              <td className="p-1 text-end tabnum">{n1(m.units)}</td>
              <td className="p-1 text-end tabnum">{m.nestedKg === null ? "—" : t(m.nestedKg)}</td>
              <td className="p-1 text-end tabnum">{pct(m.utilization)}</td>
              <td className="p-1 text-end tabnum font-bold text-bad-fg">{t(value(m) ?? 0)} t</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FabAnalyticsView({ a }: { a: MaterialDashboardData }) {
  const windowWords = a.windowDays === 0 ? "everything on record" : `the last ${a.windowDays} days`;

  if (a.nested.linesTotal === 0) {
    return (
      <div className="bg-surface border rounded-xl">
        <EmptyState
          icon={Layers}
          title="The material sheet is empty"
          hint="Upload it on the Material tab and the dashboard fills in."
          action={<Link href={hrefWithLine("/material", "TR")} className="btn btn-secondary btn-sm">Open Material</Link>}
        />
      </div>
    );
  }

  const c = a.consumed;
  const scrapTone: Tone | undefined = a.scrap.kg === 0 ? undefined : a.scrap.share > 0.25 ? "bad" : a.scrap.share > 0.15 ? "warn" : "ok";
  const utilTone: Tone | undefined = a.utilization === null ? undefined : a.utilization >= 0.85 ? "ok" : a.utilization >= 0.75 ? "warn" : "bad";
  const overTone: Tone | undefined = a.overBom.kg > 0 ? "bad" : a.overBom.kg < 0 ? "ok" : undefined;
  const consumedShare = a.planned.kg > 0 ? Math.min(1, Math.max(0, 1 - a.remaining.kg / a.planned.kg)) : null;

  return (
    <div className="space-y-5">
      <Group title={`Consumed — MOs of the sheet closed on Odoo, ${windowWords}`}>
        <Tile head="Steel consumed" value={t(c.kg)} unit="t" sub={`${n1(c.sheets)} sheets · ${n2(a.consumedPerDay.kg / 1000)} t a day`} />
        <Tile
          head="Scrap in it"
          value={t(c.scrapKg)}
          unit="t"
          tone={c.scrapKg > 0 ? "warn" : undefined}
          sub={c.kg > 0 ? `${pct(c.scrapKg / c.kg)} of consumed` : undefined}
        />
        <Tile head="In the product" value={t(c.netKg)} unit="t" sub="consumed less scrap" />
        <Tile head="Units closed" value={n1(c.units)} sub={`${c.mos} MO(s) · ${c.closings} closing(s)`} />
      </Group>

      <Group title="The material sheet">
        <Tile head="Planned by the BOM" value={t(a.planned.kg)} unit="t" sub={`${n1(a.planned.sheets)} sheets`} />
        <Tile head="Nested" value={t(a.nested.kg)} unit="t" sub={`${n1(a.nested.sheets)} sheets · ${a.nested.lines} of ${a.nested.linesTotal} lines`} />
        <Tile
          head="Nesting vs BOM"
          value={`${a.overBom.kg > 0 ? "+" : ""}${t(a.overBom.kg)}`}
          unit="t"
          tone={overTone}
          sub={a.overBom.kg > 0 ? `${n1(a.overBom.sheets)} sheets over the BOM` : a.overBom.kg < 0 ? `${n1(-a.overBom.sheets)} sheets saved on the BOM` : "no nesting to compare yet"}
        />
        <Tile head="Average utilization" value={pct(a.utilization)} tone={utilTone} sub={a.utilization === null ? "not on the sheet yet" : undefined} />
        <Tile
          head="Scrap on the sheet"
          value={t(a.scrap.kg)}
          unit="t"
          tone={scrapTone}
          sub={a.scrap.knownShare > 0 ? `${pct(a.scrap.share)} of nested` : undefined}
        />
        <Tile head="Still to consume" value={t(a.remaining.kg)} unit="t" sub={`${n1(a.remaining.sheets)} sheets · ${n1(a.remaining.units)} units open`} />
        <Tile head="MOs on the sheet" value={String(a.mos.total)} sub={`${a.mos.nested} nested · ${a.mos.closed} closed on Odoo · ${a.mos.open} open`} />
        <Tile head="Consumed so far" value={pct(consumedShare)} sub="of the planned weight" />
      </Group>

      <Section title="Consumed a day" about={`Sheets booked on the day each MO was closed on Odoo · ${n1(a.consumedPerDay.sheets)} sheets a day over ${a.consumedPerDay.days} day(s) (dashed).`}>
        {a.days.length ? <SheetsPerDayChart days={a.days} avg={a.consumedPerDay.sheets} /> : <p className="text-xs text-muted">No MO of the sheet was closed on Odoo in {windowWords} yet.</p>}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <Section title="By thickness" about="Sheets consumed in the window.">
          {a.thicknesses.length ? <ThicknessChart rows={a.thicknesses} /> : <p className="text-xs text-muted">Nothing consumed in the window yet.</p>}
        </Section>
        <Section title="By material" about="The sheet's weight — nested where nested, else the BOM's; red = scrap.">
          <Bars rows={a.materials} />
        </Section>
        <Section title="By sheet size" about="The same weight, per size.">
          <Bars rows={a.sizes} />
        </Section>
      </div>

      <Section title="By part" about="Plan, nesting, consumption and scrap per part">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-muted">
                <th className="p-1">Part</th>
                <th className="p-1 text-end">MOs</th>
                <th className="p-1 text-end">Units planned</th>
                <th className="p-1 text-end">Units closed</th>
                <th className="p-1 text-end">BOM / unit</th>
                <th className="p-1 text-end">Nested / unit</th>
                <th className="p-1 text-end">Planned t</th>
                <th className="p-1 text-end">Nested t</th>
                <th className="p-1 text-end">Consumed t</th>
                <th className="p-1 text-end">Scrap t</th>
                <th className="p-1 text-end">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {a.parts.map((p) => {
                const over = p.actualPerUnit !== null && p.actualPerUnit > p.bomPerUnit + 1e-9;
                return (
                  <tr key={`${p.partCode}|${p.partName}`} className="border-t">
                    <td className="p-1 whitespace-nowrap"><b>{p.partName || p.partCode || "—"}</b>{p.partCode && <span className="text-muted ltr"> · {p.partCode}</span>}</td>
                    <td className="p-1 text-end tabnum">{p.mos}</td>
                    <td className="p-1 text-end tabnum">{n1(p.unitsPlanned)}</td>
                    <td className="p-1 text-end tabnum">{n1(p.unitsClosed)}</td>
                    <td className="p-1 text-end tabnum">{n2(p.bomPerUnit)}</td>
                    <td className={`p-1 text-end tabnum ${over ? "text-bad-fg font-bold" : ""}`}>{p.actualPerUnit === null ? "—" : n2(p.actualPerUnit)}</td>
                    <td className="p-1 text-end tabnum">{t(p.plannedKg)}</td>
                    <td className="p-1 text-end tabnum">{t(p.nestedKg)}</td>
                    <td className="p-1 text-end tabnum font-bold">{t(p.consumedKg)}</td>
                    <td className="p-1 text-end tabnum text-bad-fg">{p.scrapKg ? t(p.scrapKg) : "—"}</td>
                    <td className="p-1 text-end tabnum">{pct(p.utilization)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Section title="Most scrap" about="The MOs leaving the most steel unused">
          <MoTable rows={a.topScrap} value={(m) => m.scrapKg} head="Scrap" />
        </Section>
        <Section title="Most over the BOM" about="The MOs whose nesting took more steel than the BOM allows.">
          <MoTable rows={a.topOver} value={(m) => m.overKg} head="Over" />
        </Section>
      </div>
    </div>
  );
}
