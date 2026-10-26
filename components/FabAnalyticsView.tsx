"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Bot, CircleAlert, Info, Layers } from "lucide-react";
import type { CockpitAction } from "@/lib/domain/kpis";
import { hrefWithLine, LINE_LABEL, type ProductLine } from "@/lib/domain/lines";
import { traceHref } from "@/lib/domain/links";
import { formatDate, formatDayShort } from "@/lib/domain/format";
import { slicerRangeLabel } from "@/lib/domain/dateSlicer";
import {
  MATERIAL_BREAKDOWNS, MATERIAL_BREAKDOWN_LABEL, MATERIAL_HISTORY_DAYS, MATERIAL_VIEWS, MATERIAL_VIEW_LABEL, MATERIAL_VIEW_SHORT, MAX_DETAIL_ROWS, RATE_SOURCE_LABEL, WEIGHT_SOURCE_LABEL,
  changePct, hasMaterialFilters, kgToT, materialDefaultRange, materialQuery, share,
  type MaterialAction, type MaterialFilters, type MaterialRequest,
} from "@/lib/domain/materialDashboard";
import type { MaterialDashboardData } from "@/lib/server/fabAnalytics";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { EmptyState } from "@/components/primitives";
import { Badge } from "@/components/Badge";
import { ChartCard, DeltaChip, StatTile, fmt, type TableRow } from "@/components/charts/kit";
import { TableEmpty, TableFrame, Th } from "@/components/DataTable";
import { FilterSelect } from "@/components/FilterControls";
import { LineSwitch } from "@/components/LineSwitch";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { useAiPanel } from "@/components/AiPanel";
import { CockpitDecisions } from "@/components/CockpitDecisions";
import { BreakdownChart, ConsumedPerDayChart, OverrunChart, PartCompareChart } from "@/components/LazyCharts";
import { aiTargetRef } from "@/lib/aiTarget";

// 📊 The MATERIAL dashboard: what the BOM needs, what the nesting took, what
// the period's ODOO closings consumed by calculation, and how much of it the
// data covers. Every figure comes worked out from lib/domain/materialDashboard
// — nothing is added up here. The page's state is its address: the line, the
// view, the period and the group filters; a click on a tile or a bar keeps
// them and narrows to what was clicked, and Back undoes it.

const t2 = (kg: number) => fmt(kgToT(kg), 2);
const n1 = (v: number) => fmt(v, 1);
const pctOf = (f: number | null, digits = 0) => (f === null ? "N/A" : `${(f * 100).toFixed(digits)}%`);
const signedT = (kg: number) => `${kg > 0 ? "+" : ""}${t2(kg)}`;

const SOURCES = "Material sheet (MaterialUsage) and the ODOO log (OdooEntry)";

/** The page's own address with some choices changed — the line kept. */
function useHref(req: MaterialRequest, line: ProductLine, todayISO: string) {
  return (over: Parameters<typeof materialQuery>[1] = {}, hash = "") => {
    const q = materialQuery(req, over, todayISO);
    return hrefWithLine(`/dashboards/material${q ? `?${q}` : ""}${hash}`, line);
  };
}

// ---------------------------------------------------------------- the bar

export function MaterialDashboardBar({ req, line, todayISO, marks, a }: { req: MaterialRequest; line: ProductLine; todayISO: string; marks: string[]; a: MaterialDashboardData | null }) {
  const router = useRouter();
  const href = useHref(req, line, todayISO);
  const panel = useAiPanel();
  const ai = panel?.canAsk ? panel : null;
  const def = materialDefaultRange(todayISO);
  const setFilter = (key: keyof MaterialFilters, value: string) => {
    const v = key === "thicknessMm" ? (value ? Number(value) : null) : value;
    router.push(href({ filters: { [key]: v } as Partial<MaterialFilters> }), { scroll: false });
  };
  const f = req.filters;
  const o = a?.options;
  const period = req.fromISO ? slicerRangeLabel(req.fromISO, req.toISO) : "everything on record";
  const excel = () => ai?.ask(
    `Make an Excel of the Material dashboard (sheet material_dashboard) for the ${LINE_LABEL[line]}: view ${req.view}, ` +
    `${req.fromISO ? `from ${req.fromISO} to ${req.toISO}` : "every day on record"}` +
    `${hasMaterialFilters(f) ? `, filtered to ${[f.material && `material ${f.material}`, f.thicknessMm !== null && `thickness ${f.thicknessMm} mm`, f.sheetSize && `size ${f.sheetSize}`, f.part && `part ${f.part}`, f.mo && `MO ${f.mo}`, f.soi && `SOI ${f.soi}`].filter(Boolean).join(", ")}` : ""}.`,
  );

  return (
    <div className="space-y-0">
      <UrlDateSlicer
        encoding="fromToAll" from={req.fromISO} to={req.fromISO ? req.toISO : null} min={addDaysISO(todayISO, -MATERIAL_HISTORY_DAYS)} max={todayISO} today={todayISO}
        marks={marks} label="Consumption period" allLabel="All time"
        presets={["thisMonth", "lastMonth", "last30", "last90"]} defaultRange={{ label: "Last 90 days", ...def }}
        start={<LineSwitch />}
        end={
          <>
            <nav className="seg" aria-label="View">
              {MATERIAL_VIEWS.map((v) => (
                <Link key={v} href={href({ view: v })} aria-current={v === req.view ? "page" : undefined} className={v === req.view ? "on" : ""} scroll={false}>
                  <span className="max-sm:hidden">{MATERIAL_VIEW_LABEL[v]}</span><span className="sm:hidden">{MATERIAL_VIEW_SHORT[v]}</span>
                </Link>
              ))}
            </nav>
            {a && <CockpitDecisions kind="attention" actions={attention(a.actions, req, line, href)} />}
            {ai && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={excel} title={`Ask the assistant for this view as an Excel file · ${period}`}>
                <Bot size={14} aria-hidden /> Excel
              </button>
            )}
          </>
        }
      />
      <div className="no-print toolbar toolbar-row" role="group" aria-label="Filters">
        <FilterSelect label="Material" value={f.material} onChange={(v) => setFilter("material", v)} options={(o?.materials ?? []).map((m) => ({ value: m, label: m }))} />
        <FilterSelect label="Thickness" value={f.thicknessMm === null ? "" : String(f.thicknessMm)} onChange={(v) => setFilter("thicknessMm", v)}
          options={(o?.thicknesses ?? []).map((t) => ({ value: String(t), label: `${t} mm` }))} />
        <FilterSelect label="Size" value={f.sheetSize} onChange={(v) => setFilter("sheetSize", v)} options={(o?.sizes ?? []).map((s) => ({ value: s, label: s }))} />
        <FilterSelect label="Part" value={f.part} onChange={(v) => setFilter("part", v)} options={o?.parts ?? []} />
        <FilterSelect label="SOI" value={f.soi} onChange={(v) => setFilter("soi", v)} options={(o?.sois ?? []).map((s) => ({ value: s, label: s }))} />
        <MoBox key={f.mo} value={f.mo} onChange={(v) => setFilter("mo", v)} />
        {hasMaterialFilters(f) && (
          <Link href={href({ filters: { material: "", thicknessMm: null, sheetSize: "", part: "", mo: "", soi: "" } })} className="btn btn-ghost btn-sm text-bad-fg" scroll={false}>
            Reset filters
          </Link>
        )}
      </div>
    </div>
  );
}

/** The dashboard's items for the bar's "Needs a look" popup: each opens where
 *  it is fixed — the period's ODOO log, the material sheet — or narrows this page. */
function attention(actions: readonly MaterialAction[], req: MaterialRequest, line: ProductLine, href: ReturnType<typeof useHref>): CockpitAction[] {
  const odoo = hrefWithLine(`/odoo?day=${req.fromISO ? `${req.fromISO}..${req.toISO}` : "all"}`, line);
  const material = hrefWithLine("/material", line);
  return actions.map((x) => ({
    tone: x.tone,
    text: x.text,
    href: x.target.kind === "odoo" ? odoo : x.target.kind === "material" ? material : href({ filters: { [x.target.key]: x.target.value } as Partial<MaterialFilters> }),
  }));
}

/** The MO filter: typed, applied on Enter or when the box is left. Keyed on
 *  the filter, so a pick made elsewhere (a bar, a reset) shows here. */
function MoBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const apply = () => { if (text.trim() !== value) onChange(text.trim()); };
  return (
    <span className={`filter-chip ${value ? "filter-chip-on" : ""}`}>
      <input
        type="search" value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
        placeholder="MO: any" aria-label="MO" className="ctl w-40 ltr"
      />
    </span>
  );
}

// ---------------------------------------------------------------- the page body

export function FabAnalyticsView({ a, todayISO }: { a: MaterialDashboardData; todayISO: string }) {
  const req = a.request;
  const router = useRouter();
  const href = useHref(req, a.line, todayISO);
  const go = (over: Parameters<typeof materialQuery>[1]) => router.push(href(over), { scroll: false });

  if (a.sheetLines === 0) {
    return (
      <div className="bg-surface border rounded-xl">
        <EmptyState
          icon={Layers}
          title={`The ${LINE_LABEL[a.line]} material sheet is empty`}
          hint="Upload it on the Material tab and the dashboard fills in. The ODOO closings alone carry no rates, so nothing can be calculated from them."
          action={<Link href={hrefWithLine("/material", a.line)} className="btn btn-secondary btn-sm">Open Material</Link>}
        />
      </div>
    );
  }

  const period = req.fromISO ? slicerRangeLabel(req.fromISO, req.toISO) : "All time";
  const filtered = hasMaterialFilters(req.filters);
  const noRows = a.coverage.lines === 0;

  return (
    <div className="space-y-4">
      <QualityStrip a={a} />

      {noRows ? (
        <div className="bg-surface border rounded-xl">
          <TableEmpty filtered title="No sheet line matches the filters" hint="Clear a filter to see the lines again." action={<Link href={href({ filters: { material: "", thicknessMm: null, sheetSize: "", part: "", mo: "", soi: "" } })} className="btn btn-secondary btn-sm">Reset filters</Link>} />
        </div>
      ) : (
        <>
          <Kpis a={a} period={period} href={href} />

          {req.view === "consumption" ? (
              <ChartCard
                title="Calculated consumption per closing day"
                about={`Tonnes booked on the factory day (Cairo) each MO of the sheet was moved to Done on Odoo, ${period}: closed qty × the line's sheets per unit × one sheet's weight. The actual nesting rate where there is one, else the BOM's (shown apart as an estimate). Not a store issue and not the sheets the machines cut. Click a day to narrow the page to it.`}
                data={a.days.map((d): TableRow => ({ Day: d.dateISO, Closings: d.closings, Units: d.units, Sheets: d.sheets, "Tonnes": kgToT(d.kg), "Estimated from BOM t": kgToT(d.bomRateKg), "Sheets of unknown weight": d.unknownWeightSheets }))}
                table
              >
                {a.days.length
                  ? <ConsumedPerDayChart days={a.days} onPick={(d) => go({ fromISO: d, toISO: d })} />
                  : <EmptyState compact icon={Layers} title="No closing of the sheet's MOs in this period" hint={filtered ? "None of the period's closings is on the lines the filters leave." : a.link.rows > 0 ? `${a.link.rows} closing(s) in the period did not link to the sheet — see the data coverage above.` : "Nothing was moved to Done on Odoo for this line in the period."} />}
              </ChartCard>
            ) : (
              <ChartCard
                title="Actual nesting vs BOM, by part"
                about="Sheets the nesting took against the sheets the BOM calls for, on the SAME lines — the nested ones — so a part is never compared on all it needs against a part of its nesting. Now: the current sheet, whatever the period. Click a part to narrow the page to it."
                data={a.parts.map((p): TableRow => ({ Part: p.part, "Part code": p.partCode, "Lines compared": p.lines, "BOM sheets": p.bomSheets, "Actual sheets": p.actualSheets, "Difference": Math.round((p.actualSheets - p.bomSheets) * 10) / 10, "BOM t": kgToT(p.bomKg), "Actual t": kgToT(p.actualKg) }))}
                table
                right={<Badge tone="info">Now</Badge>}
              >
                {a.parts.length
                  ? <PartCompareChart parts={a.parts} onPick={(p) => go({ filters: { part: p } })} />
                  : <EmptyState compact icon={Layers} title="Nothing nested yet" hint="No line of the sheet carries an actual nesting figure, so there is nothing to compare with the BOM." />}
              </ChartCard>
            )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <ChartCard
              className="lg:col-span-6"
              title={`${req.view === "consumption" ? "Consumed" : "BOM planned"} by ${MATERIAL_BREAKDOWN_LABEL[req.by].toLowerCase()}`}
              about={req.view === "consumption"
                ? `The period's calculated consumption, ${period}, by ${MATERIAL_BREAKDOWN_LABEL[req.by].toLowerCase()}. Sheets of unknown weight are counted in sheets, not in tonnes. Click a bar to filter to it.`
                : `What the BOM calls for on the current sheet (Now), by ${MATERIAL_BREAKDOWN_LABEL[req.by].toLowerCase()}, with the nested figure beside it in the table. Click a bar to filter to it.`}
              data={a.breakdown.map((b): TableRow => ({
                [MATERIAL_BREAKDOWN_LABEL[req.by]]: b.key,
                "BOM sheets": b.bom.sheets, "BOM t": kgToT(b.bom.kg),
                "Nested sheets": b.nested.sheets, "Nested t": kgToT(b.nested.kg),
                "Consumed sheets": b.consumed.sheets, "Consumed t": kgToT(b.consumed.kg),
                "Est. scrap t (known coverage)": kgToT(b.scrapKg),
                "Sheets of unknown weight (BOM)": b.bom.unknownWeightSheets,
              }))}
              table
              right={
                <nav className="seg seg-sm" aria-label="Break down by">
                  {MATERIAL_BREAKDOWNS.map((b) => (
                    <Link key={b} href={href({ by: b })} scroll={false} aria-current={b === req.by ? "true" : undefined} className={b === req.by ? "on" : ""}>{MATERIAL_BREAKDOWN_LABEL[b]}</Link>
                  ))}
                </nav>
              }
            >
              {a.breakdown.some((b) => (req.view === "consumption" ? b.consumed.sheets : b.bom.sheets) > 0)
                ? <BreakdownChart rows={a.breakdown} measure={req.view === "consumption" ? "consumed" : "bom"} onPick={(_, row) => {
                    if (req.by === "thickness" ? !(row.thicknessMm && row.thicknessMm > 0) : row.key === "—") return; // a blank group is no filter
                    go({ filters: req.by === "thickness" ? { thicknessMm: row.thicknessMm } : req.by === "material" ? { material: row.key } : { sheetSize: row.key } });
                  }} />
                : <EmptyState compact icon={Layers} title={req.view === "consumption" ? "Nothing consumed in the period" : "Nothing planned"} />}
            </ChartCard>
            <ChartCard
              className="lg:col-span-6"
              title="Most over the BOM"
              about="The MOs whose nesting took the most sheets over their BOM, on their nested lines (Now — the current sheet, whatever the period). Tonnes only where every line of the MO has a known weight. Click an MO to narrow the page to it."
              data={a.overruns.map((o): TableRow => ({ MO: o.mo, SOI: o.soi, Part: o.part, Units: o.units, "BOM sheets": o.bomSheets, "Actual sheets": o.actualSheets, "Over, sheets": o.deltaSheets, "Over, t": o.deltaKg === null ? "unknown" : kgToT(o.deltaKg) }))}
              table
              right={<Badge tone="info">Now</Badge>}
            >
              {a.overruns.length
                ? <OverrunChart rows={a.overruns} onPick={(mo) => go({ filters: { mo } })} />
                : <EmptyState compact icon={Layers} title="No MO nested over its BOM" hint={a.nesting.nested.lines === 0 ? "Nothing on the sheet is nested yet." : undefined} />}
            </ChartCard>
          </div>

          <DetailTable a={a} period={period} filtered={filtered} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- data coverage

function Cover({ label, value, detail, tone }: { label: string; value: string; detail: React.ReactNode; tone: "ok" | "warn" | "bad" | "muted" }) {
  const Icon = tone === "bad" ? CircleAlert : tone === "warn" ? AlertTriangle : Info;
  return (
    <div className="min-w-0 px-3 py-2 border-s first:border-s-0 max-sm:border-s-0 max-sm:border-t max-sm:first:border-t-0">
      <div className="text-xs font-bold text-muted flex items-center gap-1">
        {tone !== "ok" && <Icon size={12} className={tone === "bad" ? "text-bad-fg" : tone === "warn" ? "text-warn-fg" : "text-muted"} aria-hidden />}
        {label}
      </div>
      <div className={`text-lg font-semibold tabnum leading-tight ${tone === "bad" ? "text-bad-fg" : tone === "warn" ? "text-warn-fg" : ""}`}>{value}</div>
      <div className="text-xs text-muted">{detail}</div>
    </div>
  );
}

const toneOf = (f: number | null): "ok" | "warn" | "bad" | "muted" => (f === null ? "muted" : f >= 0.95 ? "ok" : f >= 0.6 ? "warn" : "bad");

function QualityStrip({ a }: { a: MaterialDashboardData }) {
  const l = a.link, c = a.consumption, cov = a.coverage, v = a.versions;
  const linkRows = share(l.linkedRows, l.rows);
  const linkQty = share(l.linkedQty, l.qty);
  const actualShare = c.sheets > 0 ? 1 - c.bomRateSheets / c.sheets : null;
  const weightKnown = share(cov.weight.sheet + cov.weight.computed, cov.lines);
  const utilKnown = share(a.nesting.utilizationKg, a.nesting.nested.kg);
  const partial = [linkRows, actualShare, weightKnown, utilKnown].some((f) => f !== null && f < 0.999) || a.line === "LV";
  const ref = aiTargetRef({
    kind: "figure", title: "Material data coverage",
    about: `How much of the dashboard the data covers, for the ${LINE_LABEL[a.line]}. Linking is by MO only (a blank MO never links); the row share is not a weight or unit share — the weight of an unlinked closing is unknown because it has no rate. Rates: actual nesting rate vs estimated from BOM. Weight: the sheet's own, else size × thickness × density, else unknown. Utilization: share of nested weight with a known utilization. One copy of each MO is read: the living sheet, else the newest month that carries it.`,
  });
  return (
    <section ref={ref} className="bg-surface border rounded-xl" aria-label="Data coverage">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <h2 className="text-sm font-bold">Data coverage</h2>
        {partial ? <Badge tone="warning" icon={<AlertTriangle size={12} />}>Partial data</Badge> : <Badge tone="success">Complete</Badge>}
        {a.line === "LV" && <span className="text-xs text-muted">The panels&apos; sheet carries no part codes, sheet weights or utilization: tonnes come from size × thickness × density, and scrap is unknown.</span>}
        <span className="ms-auto text-xs text-muted">
          Sheet updated {a.sheetUpdatedISO ? formatDate(a.sheetUpdatedISO.slice(0, 10)) : "—"} · ODOO log updated {a.odooUpdatedISO ? formatDate(a.odooUpdatedISO.slice(0, 10)) : "—"}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        <Cover label="Closings linked to the sheet" value={pctOf(linkRows)} tone={toneOf(linkRows)}
          detail={<>{fmt(l.linkedRows)} of {fmt(l.rows)} rows · {pctOf(linkQty)} of {n1(l.qty)} units{l.blankRows ? ` · ${fmt(l.blankRows)} blank MO` : ""}{l.offSheetRows ? ` · ${fmt(l.offSheetRows)} not on the sheet` : ""}. Unlinked weight unknown.</>} />
        <Cover label="Consumed at the actual rate" value={pctOf(actualShare)} tone={toneOf(actualShare)}
          detail={c.sheets > 0 ? <>{n1(c.sheets - c.bomRateSheets)} of {n1(c.sheets)} sheets · the rest estimated from BOM</> : "Nothing consumed in the period"} />
        <Cover label="Sheet weight known" value={pctOf(weightKnown)} tone={toneOf(weightKnown)}
          detail={<>{fmt(cov.weight.sheet)} from the sheet · {fmt(cov.weight.computed)} computed · {fmt(cov.weight.unknown)} unknown, of {fmt(cov.lines)} lines</>} />
        <Cover label="Utilization known" value={pctOf(utilKnown)} tone={toneOf(utilKnown)}
          detail={<>{t2(a.nesting.utilizationKg)} of {t2(a.nesting.nested.kg)} t nested · {fmt(cov.utilizationLines)} of {fmt(cov.nestedLines)} nested lines</>} />
        <Cover label="Sheet copies read" value={fmt(v.livingLines + v.archivedLines)} tone="muted"
          detail={<>{fmt(v.livingLines)} living{v.archivedLines ? ` · ${fmt(v.archivedLines)} from ${v.archivedMonths.join(", ")}` : ""}{v.skippedLines ? ` · ${fmt(v.skippedLines)} older copies left out` : ""}</>} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the six tiles

function NowBadge() {
  return <Badge tone="info" title="The current sheet — not tied to the period">Now</Badge>;
}

function Change({ now, before, upBad }: { now: number; before: number | null | undefined; upBad?: boolean }) {
  const p = changePct(now, before);
  if (p === null) return <Badge tone="neutral" title="No period before, or nothing in it to compare with">N/A</Badge>;
  return <DeltaChip value={p} unit="%" up={upBad ? "bad" : undefined} title={`Against the period before: ${t2(before ?? 0)} t`} />;
}

function Tile({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return (
    <Link href={href} title={title} scroll className="flex min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-[var(--brand)] hover:[&>div]:border-[var(--border-strong)]">
      {children}
    </Link>
  );
}

function Kpis({ a, period, href }: { a: MaterialDashboardData; period: string; href: ReturnType<typeof useHref> }) {
  const n = a.nesting, c = a.consumption, p = a.prevConsumption;
  const known = (w: { sheets: number; unknownWeightSheets: number }) => pctOf(share(w.sheets - w.unknownWeightSheets, w.sheets));
  const nestingHref = href({ view: "nesting" }, "#detail");
  const consHref = href({ view: "consumption" }, "#detail");
  const varShare = share(n.variance.kg, n.variance.bomKg);
  const scrapKnown = share(c.utilizationKg, c.kg);
  const req = a.request;
  const when = req.fromISO ? (req.fromISO === req.toISO ? formatDayShort(req.fromISO) : `${formatDayShort(req.fromISO)} → ${formatDayShort(req.toISO)}`) : period;
  const tiles: { href: string; label: string; value: string; delta: React.ReactNode; lines: string[]; about: string }[] = [
    {
      href: nestingHref, label: "BOM planned", value: `${t2(n.planned.kg)} t`, delta: <NowBadge />,
      lines: [`${n1(n.planned.sheets)} sheets · ${fmt(n.planned.lines)} lines · ${fmt(n.planned.mos)} MOs`, `Weight known on ${known(n.planned)} of sheets`],
      about: `Units × BOM sheets per unit × one sheet's weight, over the current sheet's lines (Now). Source: ${SOURCES}. Sheets of unknown weight are counted in sheets only.`,
    },
    {
      href: nestingHref, label: "Nested", value: `${t2(n.nested.kg)} t`, delta: <NowBadge />,
      lines: [`${n1(n.nested.sheets)} sheets · ${fmt(n.nested.lines)} of ${fmt(n.nested.linesTotal)} lines · ${fmt(n.nested.mos)} MOs`, `Nested on ${pctOf(share(n.nested.lines, n.nested.linesTotal))} of lines`],
      about: `The actual nesting: the job's nested sheets (or actual per unit × units) × one sheet's weight, on the lines nested so far (Now). Source: ${SOURCES}.`,
    },
    {
      href: nestingHref, label: "Nesting variance", value: `${signedT(n.variance.kg)} t`, delta: <NowBadge />,
      lines: [`${n.variance.sheets > 0 ? "+" : ""}${n1(n.variance.sheets)} sheets on ${fmt(n.variance.lines)} nested lines`, `${pctOf(varShare, 1)} of their BOM ${t2(n.variance.bomKg)} t`],
      about: "Nested − BOM on the SAME lines: only lines that have both an actual nesting and a BOM figure. Positive: the nesting took more steel than the BOM. Now — the current sheet.",
    },
    {
      href: nestingHref, label: "Weighted utilization", value: pctOf(n.utilization, 1), delta: <NowBadge />,
      lines: [n.utilization === null ? "No nested line has a utilization" : `On ${t2(n.utilizationKg)} of ${t2(n.nested.kg)} t nested`, `Known on ${pctOf(share(n.utilizationKg, n.nested.kg))} of nested weight`],
      about: "The nesting's average utilization weighted by each nested line's tonnes, over the lines whose utilization AND weight are known only. Lines without one are left out — never read as 100%.",
    },
    {
      href: consHref, label: "Calculated consumption", value: `${t2(c.kg)} t`, delta: <Change now={c.kg} before={p?.kg} />,
      lines: [when, `${n1(c.sheets)} sheets · ${fmt(c.closings)} closings · ${fmt(c.mos)} MOs · ${n1(c.units)} units`, `Linked ${pctOf(share(a.link.linkedRows, a.link.rows))} of closing rows · ${pctOf(share(c.bomRateSheets, c.sheets))} est. from BOM`],
      about: `ODOO rows moved to Done in the period (Cairo day of Done), MO matched to the sheet: closed qty × sheets per unit (actual nesting, else BOM — an estimate) × one sheet's weight. Calculated, not a measured store issue nor the sheets actually cut. Each closing's units count once, whatever its MO's number of material lines. Source: ${SOURCES}.`,
    },
    {
      href: consHref, label: "Estimated scrap", value: c.utilizationKg > 0 ? `${t2(c.scrapKg)} t` : "N/A", delta: c.utilizationKg > 0 ? <Change now={c.scrapKg} before={p && p.utilizationKg > 0 ? p.scrapKg : null} upBad /> : <Badge tone="neutral">N/A</Badge>,
      lines: [when, `On known coverage: ${t2(c.utilizationKg)} of ${t2(c.kg)} t consumed (${pctOf(scrapKnown)})`, `Net est. ${t2(c.netKg)} t · ${t2(c.kg - c.utilizationKg)} t with unknown utilization`],
      about: "Consumed tonnes × (1 − utilization), on the consumed tonnes whose line has a known utilization only. The rest is not scrap-free: its scrap is unknown. Net product is estimated on that same known coverage only.",
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {tiles.map((t) => (
        <Tile key={t.label} href={t.href} title={`${t.about}\n\nClick for the rows behind it.`}>
          <StatTile label={t.label} value={t.value} delta={t.delta} about={t.about}
            sub={<>{t.lines.map((s) => <span key={s} className="block truncate" title={s}>{s}</span>)}</>} />
        </Tile>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the detail table

function DetailTable({ a, period, filtered }: { a: MaterialDashboardData; period: string; filtered: boolean }) {
  const req = a.request;
  const T = a.totals;
  return (
    <section id="detail" className="bg-surface border rounded-xl min-w-0 scroll-mt-24" data-ai-title="Material — detail by MO and part" data-ai-about={`One row per MO × part × sheet spec. ${req.view === "consumption" ? `The lines whose MO was closed on Odoo ${period}.` : "Every line of the current sheet."} Closed qty is the MO's, on each of its lines; the totals count each MO once.`}>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="font-bold leading-tight">Detail by MO and part</h2>
        <Badge tone={req.view === "nesting" ? "info" : "neutral"}>{req.view === "nesting" ? "Now" : period}</Badge>
        <span className="text-xs text-muted">
          {fmt(T.lines)} lines · {fmt(T.mos)} MOs{a.rowsTotal > a.rows.length ? ` · showing the first ${fmt(MAX_DETAIL_ROWS)} — narrow the filters, or ask the assistant for the Excel` : ""}
        </span>
        <Link href={hrefWithLine("/material", a.line)} className="ms-auto text-sm text-brand-ink font-semibold hover:underline no-print">Open the material sheet</Link>
      </div>
      {a.rows.length === 0 ? (
        <TableEmpty filtered={filtered} title={req.view === "consumption" ? "No sheet line was consumed in the period" : "No sheet line"} hint={req.view === "consumption" ? "Switch to Nesting plan · Now to see the whole sheet, or widen the period." : undefined} />
      ) : (
        <TableFrame className="max-h-[70vh]">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th label="MO" />
                <Th label="SOI" />
                <Th label="Part" />
                <Th label="Material" />
                <Th label="Thk" unit="mm" num full="Thickness" />
                <Th label="Size" />
                <Th label="Units" num full="Units of the MO" />
                <Th label="BOM" unit="sheets" num full="BOM sheets for the job" group="source" />
                <Th label="Actual" unit="sheets" num full="Actual nesting sheets for the job" hint="Blank until nested" group="source" />
                <Th label="Δ" unit="sheets" num full="Actual − BOM" hint="On nested lines only" group="computed" />
                <Th label="Sheet" unit="kg" num full="One sheet's weight" hint="The sheet's own, else size × thickness × density" group="computed" />
                <Th label="Util." num full="Average utilization" group="source" />
                <Th label="Closed" unit="qty" num full="Closed qty in the period" hint="The MO's — shown on each of its lines" group="source" />
                <Th label="Consumed" unit="kg" num full="Calculated consumption in the period" group="computed" />
                <Th label="Scrap" unit="kg" num full="Estimated scrap" hint="Only where utilization is known" group="computed" />
                <Th label="Coverage" />
                <Th label="Rate" full="Source of the per-unit rate" />
              </tr>
            </thead>
            <tbody>
              {a.rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-2 whitespace-nowrap ltr font-semibold">
                    {r.mo ? <Link href={traceHref({ mo: r.mo, line: a.line })} className="hover:underline text-brand-ink" title="Open the order's trace">{r.mo}</Link> : <span className="text-muted" title={`Blank MO — covers BOM ${r.bom}; never matched to a closing`}>— · {r.bom}</span>}
                  </td>
                  <td className="px-2 whitespace-nowrap ltr text-muted">{r.soi || "—"}</td>
                  <td className="px-2 whitespace-nowrap" dir="auto">{r.partName || r.partCode || "—"}{r.partCode && r.partName ? <span className="text-muted ltr"> · {r.partCode}</span> : null}</td>
                  <td className="px-2 whitespace-nowrap" dir="auto">{r.material || "—"}</td>
                  <td className="px-2 text-right tabnum">{fmt(r.thicknessMm, 2)}</td>
                  <td className="px-2 whitespace-nowrap ltr">{r.sheetSize || "—"}{r.month ? <span className="ms-1"><Badge tone="neutral" title="Read from an older month's sheet — the living sheet does not carry this MO">{r.month}</Badge></span> : null}</td>
                  <td className="px-2 text-right tabnum">{n1(r.units)}</td>
                  <td className="px-2 text-right tabnum">{fmt(r.bomSheets, 2)}</td>
                  <td className="px-2 text-right tabnum">{r.actualSheets === null ? <span className="text-muted">—</span> : fmt(r.actualSheets, 2)}</td>
                  <td className={`px-2 text-right tabnum ${r.deltaSheets !== null && r.deltaSheets > 0 ? "text-bad-fg font-semibold" : ""}`}>{r.deltaSheets === null ? <span className="text-muted">—</span> : `${r.deltaSheets > 0 ? "+" : ""}${fmt(r.deltaSheets, 2)}`}</td>
                  <td className="px-2 text-right tabnum">{r.sheetKg === null ? <span className="text-warn-fg" title={WEIGHT_SOURCE_LABEL.unknown}>?</span> : fmt(r.sheetKg, 1)}</td>
                  <td className="px-2 text-right tabnum">{r.utilization === null ? <span className="text-muted">—</span> : pctOf(r.utilization, 1)}</td>
                  <td className="px-2 text-right tabnum">{r.mo ? n1(r.closedQty) : <span className="text-muted">—</span>}</td>
                  <td className="px-2 text-right tabnum font-semibold">{r.consumedKg === null ? (r.consumedSheets > 0 ? <span className="text-warn-fg" title={`${fmt(r.consumedSheets, 2)} sheets of unknown weight`}>?</span> : <span className="text-muted">—</span>) : fmt(r.consumedKg)}</td>
                  <td className="px-2 text-right tabnum">{r.scrapKg === null ? <span className="text-muted">—</span> : fmt(r.scrapKg)}</td>
                  <td className="px-2 whitespace-nowrap text-xs">
                    <span className={r.weightSource === "unknown" ? "text-warn-fg" : "text-muted"} title={WEIGHT_SOURCE_LABEL[r.weightSource]}>W: {r.weightSource === "sheet" ? "sheet" : r.weightSource === "computed" ? "calc" : "unknown"}</span>
                    <span className="text-muted"> · </span>
                    <span className={r.utilization === null ? "text-warn-fg" : "text-muted"}>U: {r.utilization === null ? "unknown" : "known"}</span>
                  </td>
                  <td className="px-2 whitespace-nowrap text-xs">
                    {r.rateSource === "bom" ? <Badge tone="warning">{RATE_SOURCE_LABEL.bom}</Badge> : <span className="text-muted">{RATE_SOURCE_LABEL.actual}</span>}
                    <span className="text-muted tabnum"> · {fmt(r.ratePerUnit, 2)}/unit</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold border-t">
                <td className="px-2" colSpan={6}>Total · {fmt(T.lines)} lines · {fmt(T.mos)} MOs</td>
                <td className="px-2 text-right tabnum" title="Each MO once">{n1(T.units)}</td>
                <td className="px-2 text-right tabnum">{n1(T.bomSheets)}</td>
                <td className="px-2 text-right tabnum">{n1(T.actualSheets)}</td>
                <td className="px-2 text-right tabnum" title="On nested lines only">{T.deltaSheets > 0 ? "+" : ""}{n1(T.deltaSheets)}</td>
                <td className="px-2" />
                <td className="px-2" />
                <td className="px-2 text-right tabnum" title="Each MO once">{n1(T.closedQty)}</td>
                <td className="px-2 text-right tabnum">{fmt(T.consumedKg)}</td>
                <td className="px-2 text-right tabnum">{T.scrapKg === null ? <span className="text-muted" title="No line has a known utilization">—</span> : fmt(T.scrapKg)}</td>
                <td className="px-2" colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </TableFrame>
      )}
    </section>
  );
}
