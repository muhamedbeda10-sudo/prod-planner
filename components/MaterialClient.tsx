"use client";

import { traceHref } from "@/lib/domain/links";
import Link from "next/link";

import type { ProductLine } from "@/lib/domain/lines";

import { useRouter } from "next/navigation";
import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import {
  MATERIAL_STATUS_FILTERS, EMPTY_MATERIAL_FILTERS, NO_PLAN_MONTH,
  partNameFor, filterMaterialLines, groupMaterialBySoi, materialPlanMonthOptions, materialSummary, sheetsConsumed,
  type MaterialLineView, type MaterialFilters, type MaterialStatusFilter, type MaterialSoiGroup, type MaterialPlanMatch, type MaterialSummary,
} from "@/lib/domain/material";
import type { UserPrefs } from "@/lib/domain/userPrefs";
import { FIELD_DP, formatNumber, formatQty } from "@/lib/domain/format";
import { FilterSelect, PhoneFold } from "@/components/FilterControls";
import { Check, ChevronDown, ChevronRight, FilterX, Search, Upload } from "lucide-react";
import { GroupBand, GroupLegend, TableEmpty, TableFrame, Th, useConfirm, type ColGroup } from "@/components/DataTable";
import { ColumnMenu, FoldButton, stickAt, useColumns, type Columns } from "@/components/TrackerColumns";
import { parseSaved, savedString, useStoredFilters } from "@/components/useStoredFilters";
import { importMaterialAction } from "@/app/material/actions";

// The MATERIAL tab — the planner's material sheet as one living table: no
// month, each row known by Odoo's MO (the one the ODOO log's clerk types), so
// uploading the sheet again simply updates it. Older sheets filed under a plan
// month were cleared when the table started.
//
// The table is the sheet's row in the sheet's order — MO · BOM Ref · Quantity of
// Units · Part Code · Part Name · Codes · Material · Thickness · Sheet Size ·
// Sheets in BOM for one Unit · for Job · Actual Nesting for one Unit · for
// Job · Difference · Notes. Each person picks the columns they keep (Columns ▾,
// on their account) and folds a run of them from the band over the headers,
// as on the Plan Tracker. Plan month is the monthly plan the line's order is
// in on the Plan Tracker, and a filter: a month's plan, what its orders were
// nested on and what that adds up to. The sheet is the tab's only source: nothing is
// typed, edited or deleted here — uploading the sheet again is how a line
// changes. Sheets-for-job, actual weight and Difference are computed.

/* The sheet's own column names are sentences ("No. of Sheets in Actual
   Nesting for one Unit"): the headers carry a short label, and the sheet's
   whole name sits in each one's tooltip (and stays the export's heading). */
/** A numeric column's header and cells: right-aligned, so figures line up. */
const NUM = "num";

/** Sheet counts read as fractions of a sheet — 1.287, not 1.3 — at a fixed
 *  number of decimals per column, so a column's figures line up on the point.
 *  A rate per unit is finer still: the sheet writes 0.2207. */
function Sheets({ v, className = "", digits = FIELD_DP.sheets }: { v: number | null; className?: string; digits?: number }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className={`tabnum ltr ${className}`} title={String(v)}>{formatNumber(v, digits)}</span>;
}

/** A count of units: whole as a rule, any fraction kept as typed. */
function Units({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className="tabnum ltr">{formatQty(v)}</span>;
}

function Utilization({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className="tabnum ltr">{v <= 1 ? `${Number((v * 100).toFixed(1))}%` : Number(v.toFixed(2))}</span>;
}

// ---- the columns: each one on or off (Columns ▾), a run of them folded from the band ----

/** The MO cell: the sheet's MO and whether the ODOO log carries it yet. */
function MoCell({ mo, odoo }: { mo: string; odoo: Record<string, string> }) {
  if (!mo) return <span className="text-muted">—</span>;
  const status = odoo[mo.trim().toUpperCase()];
  // one line: the MO, then where it stands on the ODOO log as a compact badge
  return (
    // the badge gives way to the MO (cut to an ellipsis), and both stay inside the cell
    <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
      <span className="shrink-0" title={mo}>{mo}</span>
      {status
        ? <span className="pill pill-ok min-w-0" title={`On the ODOO log — ${status}`}><Check size={10} className="shrink-0" aria-hidden /><span className="truncate">{status}</span></span>
        : <span className="pill pill-muted min-w-0" title="No ODOO row carries this MO yet"><span className="truncate">no ODOO</span></span>}
    </span>
  );
}

/** Plan month, on either line's sheet: not from the sheet — read off the Plan Tracker. */
const planCol = <K extends string>(): ColDef<K> => ({
  key: "plan" as K, name: "Plan month",
  th: { label: "Plan month", hint: "The monthly plan the line's order is in on the Plan Tracker — found by its MO, else its SOI; a line with neither, by its BOM. +n: it sits in more plans too (an order carried over, or a SOI / BOM with orders in several)" },
  td: "p-2 text-xs",
  cell: (l) => <PlanCell months={l.planMonths} match={l.planMatch} />,
});

const MATCH_WORD: Record<MaterialPlanMatch, string> = { mo: "MO", soi: "SOI", bom: "BOM" };

/** The monthly plans the line's order was in: the newest, and +n for the
 *  other plans its key also sits in (an order carried over, or a SOI / BOM
 *  whose orders sat in several); the months and the key that tied them in the tooltip. */
function PlanCell({ months, match }: { months: string[]; match: MaterialPlanMatch | null }) {
  if (months.length === 0) return <span className="text-muted" title="No order on the Plan Tracker carries this line's MO or SOI (or, for a line with neither, its BOM)">—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${months.join(" · ")}${match ? ` — matched on its ${MATCH_WORD[match]}` : ""}`}>
      {months[0]}
      {months.length > 1 && <span className="pill pill-muted tabnum" aria-hidden>+{months.length - 1}</span>}
      {/* the tooltip's months, for a screen reader */}
      {months.length > 1 && <span className="sr-only">, also {months.slice(1).join(", ")}</span>}
    </span>
  );
}

/** What every line of a group agrees on — or null where they differ. */
function sharedOf<T>(values: T[]): T | null {
  return values.every((v) => v === values[0]) ? values[0] : null;
}

type Sums = Pick<MaterialSoiGroup, "forJob" | "sheetsUsed" | "actualWeightKg" | "difference">;

const diffTone = (v: number | null) => (v === null ? "" : v < 0 ? "text-bad-fg" : v > 0 ? "text-ok-fg" : "text-muted");

interface ColCtx { odoo: Record<string, string>; product: ProductLine }

/** One column of the table: its header, its cell on a line, and — on the
 *  transformers' sheet — its cell on a SOI's head row and on the totals row.
 *  A column with no head (or sum) cell joins its neighbours' blank span there. */
interface ColDef<K extends string> {
  key: K;
  /** The column's name in Columns ▾. */
  name: string;
  th: { label: string; full?: string; unit?: string; hint?: string; group?: ColGroup; num?: boolean; center?: boolean; className?: string };
  td: string | ((l: MaterialLineView) => string);
  cell: (l: MaterialLineView, x: ColCtx) => React.ReactNode;
  head?: (g: MaterialSoiGroup, x: ColCtx) => React.ReactNode;
  sum?: (s: Sums) => React.ReactNode;
}

/** A run of neighbouring columns under one name in the band; its arrow folds
 *  it to the `lead` columns and opens it again. */
interface ColRun<K extends string> { label: string; cols: K[]; lead: K[] }

type TrCol =
  | "mtr" | "soi" | "mo" | "bom" | "units" | "plan" | "partCode" | "partName" | "matCode" | "material" | "thk" | "size" | "weight"
  | "bomUnit" | "actualUnit" | "bomJob" | "actualJob" | "util" | "actualWeight" | "diff" | "notes";

/** The identifiers stay on screen while the figures scroll past: MTR, SOI and
 *  MO are pinned (from a laptop up) at fixed widths, each shown one after the other. */
const STICK_W: Partial<Record<TrCol, number>> = { mtr: 6.5, soi: 6.75, mo: 16 };

// The transformers' sheet: the Nesting Tracker's OWN columns, in the sheet's
// order and under the sheet's own names, so the tab reads as the sheet does —
// every figure from the sheet or worked out from it; Plan month is read from
// the Plan Tracker and only shown.
const TR_COLS: ColDef<TrCol>[] = [
  { key: "mtr", name: "MTR #", th: { label: "MTR #", full: "MTR Request #", hint: "The material request the sheets were drawn on", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs",
    cell: (l) => <span className="block truncate" title={l.mtr || undefined}>{l.mtr || <span className="text-muted">—</span>}</span>,
    head: (g) => <span className="block truncate">{sharedOf(g.lines.map((l) => l.mtr)) || <span className="text-muted">—</span>}</span> },
  { key: "soi", name: "SOI", th: { label: "SOI", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs font-semibold",
    cell: (l) => <span className="block truncate" title={l.soi || undefined}>{l.soi || <span className="text-muted">—</span>}</span>,
    head: (g) => <span className="block truncate font-bold" title={g.soi || undefined}>{g.soi || <span className="text-muted font-semibold">No SOI</span>}</span> },
  // the sheet files each part under Odoo's MO — the key an ODOO row finds it by
  { key: "mo", name: "MO", th: { label: "MO", hint: "Odoo's MO for the part — the ODOO log finds the line by it", group: "source" }, td: "p-2 font-bold whitespace-nowrap ltr text-xs",
    cell: (l, x) => <MoCell mo={l.mo} odoo={x.odoo} />,
    head: (g, x) => {
      const sharedMo = sharedOf(g.lines.map((l) => l.mo.trim()));
      if (sharedMo !== null) return <MoCell mo={sharedMo} odoo={x.odoo} />;
      const onOdoo = g.mos.filter((mo) => x.odoo[mo.toUpperCase()]);
      return (
        <span className="flex items-center gap-1.5">
          {g.mos.length} MOs
          <span
            className={`pill ${onOdoo.length === g.mos.length ? "pill-ok" : onOdoo.length ? "pill-warn" : "pill-muted"}`}
            title={onOdoo.length ? `On the ODOO log: ${onOdoo.join(", ")}` : "No ODOO row carries these MOs yet"}
          >
            {onOdoo.length > 0 && <Check size={10} aria-hidden />}ODOO {onOdoo.length}/{g.mos.length}
          </span>
        </span>
      );
    } },
  { key: "bom", name: "BOM", th: { label: "BOM", full: "BOM Ref", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs",
    cell: (l, x) => <BomLink bom={l.bom} line={x.product} />,
    head: (g, x) => {
      const shared = sharedOf(g.lines.map((l) => l.bom));
      const boms = [...new Set(g.lines.map((l) => l.bom))];
      return shared !== null ? <BomLink bom={shared} line={x.product} /> : <span className="text-muted" title={boms.join(", ")}>{boms.length} BOMs</span>;
    } },
  { key: "units", name: "Units", th: { label: "Units", unit: "pcs", full: "Quantity of Units", group: "source", num: true }, td: `p-2 ${NUM} tabnum ltr`,
    cell: (l) => l.units, head: (g) => <Units v={sharedOf(g.lines.map((l) => l.units))} /> },
  { ...planCol<TrCol>(),
    head: (g) => {
      const shared = sharedOf(g.lines.map((l) => l.planMonths.join("|")));
      return shared === null ? <span className="text-muted" title="The lines sit in different plans">…</span> : <PlanCell months={g.lines[0].planMonths} match={g.lines[0].planMatch} />;
    } },
  { key: "partCode", name: "Part code", th: { label: "Part code", full: "Part Code", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs font-bold",
    cell: (l) => l.partCode || <span className="text-muted">—</span> },
  { key: "partName", name: "Part name", th: { label: "Part name", full: "Part Name", group: "source" }, td: "p-2 whitespace-nowrap text-xs",
    cell: (l) => l.partName || <span className="text-muted">—</span> },
  { key: "matCode", name: "Material code", th: { label: "Mat. code", full: "Material Code", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs",
    cell: (l) => l.materialCode || <span className="text-muted">—</span> },
  { key: "material", name: "Material", th: { label: "Material", group: "source" }, td: "p-2 whitespace-nowrap", cell: (l) => l.material },
  { key: "thk", name: "Thickness", th: { label: "Thk", unit: "mm", full: "Thickness", group: "source", num: true }, td: `p-2 ${NUM} tabnum ltr`, cell: (l) => l.thicknessMm },
  { key: "size", name: "Sheet size", th: { label: "Sheet size", full: "Sheet Size", group: "source", center: true }, td: "p-2 text-center whitespace-nowrap ltr tabnum", cell: (l) => l.sheetSize },
  { key: "weight", name: "Weight", th: { label: "Weight", unit: "kg", full: "Weight(Kg)", hint: "One sheet's weight", group: "source", num: true }, td: `p-2 ${NUM} tabnum`,
    cell: (l) => <Sheets v={l.weightKg} digits={3} /> },
  { key: "bomUnit", name: "BOM / unit", th: { label: "BOM / unit", full: "BOM Qty for one Unit", group: "source", num: true }, td: `p-2 ${NUM}`,
    cell: (l) => <Sheets v={l.sheetsPerUnit} digits={FIELD_DP.factor} /> },
  { key: "actualUnit", name: "Actual / unit", th: { label: "Actual / unit", full: "No. of Pieces in Actual Nesting for one Unit", hint: "From the sheet — where it leaves it blank, Actual for job ÷ units", group: "source", num: true }, td: `p-2 ${NUM}`,
    cell: (l) => <Sheets v={l.actualPerUnit} digits={FIELD_DP.factor} /> },
  { key: "bomJob", name: "BOM for job", th: { label: "BOM for job", full: "BOM Pieces for Job", hint: "BOM Qty for one Unit × units", group: "computed", num: true, className: "emph" }, td: `p-2 ${NUM} emph`,
    cell: (l) => <Sheets v={l.forJob} />, head: (g) => <Sheets v={g.forJob} />, sum: (s) => <Sheets v={s.forJob} /> },
  { key: "actualJob", name: "Actual for job", th: { label: "Actual for job", full: "No. of Pieces in Actual Nesting for Job", hint: "From the sheet", group: "source", num: true, className: "emph" }, td: `p-2 ${NUM} emph`,
    cell: (l) => <Sheets v={l.sheetsUsed} className="font-bold" />,
    head: (g) => <span title="The lines' pieces nested for the job, added up"><Sheets v={g.sheetsUsed} /></span>, sum: (s) => <Sheets v={s.sheetsUsed} /> },
  { key: "util", name: "Utilization", th: { label: "Utilization", full: "Average Utilization", hint: "As the sheet writes it — 0.85 or 85", group: "source", num: true }, td: `p-2 ${NUM}`,
    cell: (l) => <Utilization v={l.utilization} />, head: (g) => <Utilization v={sharedOf(g.lines.map((l) => l.utilization))} /> },
  { key: "actualWeight", name: "Actual weight", th: { label: "Actual weight", unit: "kg", full: "Actual Weight (Kg)", hint: "Pieces in Actual Nesting for Job × Weight(Kg)", group: "computed", num: true, className: "emph" }, td: `p-2 ${NUM} emph tabnum`,
    cell: (l) => <span title={l.actualWeightKg === null ? "Needs the pieces nested for the job and the weight" : `${l.sheetsUsed} × ${l.weightKg} kg`}><Sheets v={l.actualWeightKg} digits={3} /></span>,
    head: (g) => <Sheets v={g.actualWeightKg} digits={3} />, sum: (s) => <Sheets v={s.actualWeightKg} digits={3} /> },
  { key: "diff", name: "Difference", th: { label: "Difference", hint: "BOM Pieces for Job − Actual Nesting for Job. Red = ate more than the BOM allows", group: "computed", num: true, className: "emph" },
    td: (l) => `p-2 ${NUM} emph ${diffTone(l.difference)}`,
    cell: (l) => <Sheets v={l.difference} />,
    head: (g) => <span className={diffTone(g.difference)}><Sheets v={g.difference} /></span>,
    sum: (s) => <span className={diffTone(s.difference)}><Sheets v={s.difference} /></span> },
  { key: "notes", name: "Notes", th: { label: "Notes", group: "source" }, td: "p-2 text-xs min-w-[8rem] max-w-[200px]",
    cell: (l) => l.note, head: (g) => sharedOf(g.lines.map((l) => l.note ?? "")) ?? <span className="text-muted">…</span> },
];

const TR_RUNS: ColRun<TrCol>[] = [
  { label: "Order", cols: ["mtr", "soi", "mo"], lead: ["mo"] },
  { label: "Job", cols: ["bom", "units", "plan"], lead: ["bom"] },
  { label: "Part", cols: ["partCode", "partName"], lead: ["partCode"] },
  { label: "Sheet", cols: ["matCode", "material", "thk", "size", "weight"], lead: ["material", "thk"] },
  { label: "Per unit", cols: ["bomUnit", "actualUnit"], lead: ["actualUnit"] },
  { label: "For the job", cols: ["bomJob", "actualJob", "util", "actualWeight", "diff"], lead: ["bomJob", "actualJob", "diff"] },
  { label: "", cols: ["notes"], lead: ["notes"] },
];

type LvCol =
  | "mo" | "product" | "secItem" | "planned" | "bom" | "plan" | "material" | "thk" | "size"
  | "bomUnit" | "bomQty" | "actualUnit" | "produced" | "consumed" | "remaining" | "remarks";

const lvDone = (l: MaterialLineView) => l.remainingUnits === 0 && l.units > 0;

// The panels' sheet: the order's head, then the thickness row, then what the
// tracker produced and what that consumed.
const LV_COLS: ColDef<LvCol>[] = [
  { key: "mo", name: "MO", th: { label: "MO", group: "source" }, td: "p-2 font-bold whitespace-nowrap ltr text-xs", cell: (l, x) => <MoCell mo={l.mo} odoo={x.odoo} /> },
  { key: "product", name: "Product", th: { label: "Product", group: "source", center: true }, td: "p-2 text-center", cell: (l) => <span className="pill pill-muted">{l.partName || "—"}</span> },
  { key: "secItem", name: "Sec item", th: { label: "Sec item", full: "Sec Item", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs tabnum text-muted", cell: (l) => l.materialCode || "—" },
  { key: "planned", name: "Planned", th: { label: "Planned", unit: "pcs", full: "Planned qty", group: "source", num: true }, td: "p-2 text-center tabnum font-bold", cell: (l) => l.units },
  { key: "bom", name: "BOM", th: { label: "BOM", group: "source" }, td: "p-2 whitespace-nowrap ltr text-xs", cell: (l, x) => <BomLink bom={l.bom} line={x.product} /> },
  planCol<LvCol>(),
  { key: "material", name: "Material", th: { label: "Material", group: "source" }, td: "p-2 whitespace-nowrap", cell: (l) => l.material },
  { key: "thk", name: "Thickness", th: { label: "Thk", unit: "mm", full: "Thickness", group: "source", num: true }, td: "p-2 text-center tabnum ltr", cell: (l) => l.thicknessMm },
  { key: "size", name: "Sheet size", th: { label: "Sheet size", full: "Sheet Size", group: "source", center: true }, td: "p-2 text-center whitespace-nowrap ltr tabnum", cell: (l) => l.sheetSize },
  { key: "bomUnit", name: "BOM / unit", th: { label: "BOM / unit", unit: "sheets", full: "No. of Sheets in BOM for one Unit", group: "source", num: true }, td: "p-2 text-center",
    cell: (l) => <Sheets v={l.sheetsPerUnit} digits={FIELD_DP.factor} /> },
  { key: "bomQty", name: "BOM qty", th: { label: "BOM qty", unit: "sheets", full: "Sheets Qty as per BOM", hint: "Per unit × planned qty", group: "computed", num: true }, td: "p-2 text-center font-bold", cell: (l) => <Sheets v={l.forJob} /> },
  { key: "actualUnit", name: "Actual / unit", th: { label: "Actual / unit", unit: "sheets", full: "Actual per Unit", hint: "Sheets one unit really takes, from the sheet — blank means the BOM's figure", group: "source", num: true }, td: "p-2 text-center",
    cell: (l) => <Sheets v={l.actualPerUnit} digits={FIELD_DP.factor} /> },
  { key: "produced", name: "Produced", th: { label: "Produced", unit: "pcs", hint: "The sheet's count, else the panels painted on the tracker", group: "source", num: true }, td: "p-2 text-center bg-brand-light/30 whitespace-nowrap",
    cell: (l) => (
      <span title={l.producedQty === null && l.producedAuto !== null ? "Panels painted on the tracker" : undefined}>
        <Units v={l.producedUsed} />
        {l.producedQty === null && l.producedAuto !== null && <span className="block text-[10px] text-muted">tracker</span>}
      </span>
    ) },
  { key: "consumed", name: "Consumed", th: { label: "Consumed", unit: "sheets", full: "Actually Consumed", hint: "Sheets the produced panels consumed — per unit × produced", group: "computed", num: true }, td: "p-2 text-center font-extrabold bg-brand-light/30",
    cell: (l) => (
      <span title={l.producedUsed === null ? "Nothing produced yet" : `${l.producedUsed} units × ${Number((l.actualPerUnit ?? l.sheetsPerUnit).toFixed(4))} sheets a unit`}>
        <Sheets v={sheetsConsumed(l)} />
      </span>
    ) },
  { key: "remaining", name: "Remaining", th: { label: "Remaining", unit: "pcs", full: "Remaining units", group: "computed", num: true }, td: (l) => `p-2 text-center tabnum font-bold ${lvDone(l) ? "text-ok-fg" : ""}`,
    cell: (l) => (l.remainingUnits === null ? "—" : lvDone(l) ? "Done" : l.remainingUnits) },
  { key: "remarks", name: "Remarks", th: { label: "Remarks", group: "source" }, td: "p-2 text-xs max-w-[200px]", cell: (l) => l.note },
];

const LV_RUNS: ColRun<LvCol>[] = [
  { label: "Order", cols: ["mo", "product", "secItem", "planned", "bom", "plan"], lead: ["mo", "product", "planned"] },
  { label: "Sheet", cols: ["material", "thk", "size"], lead: ["thk"] },
  { label: "Sheets", cols: ["bomUnit", "bomQty", "actualUnit"], lead: ["bomQty"] },
  { label: "Produced", cols: ["produced", "consumed", "remaining"], lead: ["consumed", "remaining"] },
  { label: "", cols: ["remarks"], lead: ["remarks"] },
];

/** The column that always shows — what the line is. */
const ALWAYS = "mo";
// every column shows until the person picks otherwise
const TR_DEFAULT = TR_COLS.map((c) => c.key).filter((k) => k !== ALWAYS);
const LV_DEFAULT = LV_COLS.map((c) => c.key).filter((k) => k !== ALWAYS);

/** The columns shown, in the sheet's order, each pinned identifier with its
 *  place: its left edge after the pinned ones shown before it. */
function layoutOf<K extends string>(defs: ColDef<K>[], isOn: (k: K) => boolean, stickW: Partial<Record<K, number>>) {
  const shown = defs.filter((c) => c.key === ALWAYS || isOn(c.key));
  const pinned = shown.filter((c) => stickW[c.key] !== undefined);
  let left = 0;
  const stick = new Map<string, { className: string; style: React.CSSProperties }>();
  pinned.forEach((c, i) => {
    const w = stickW[c.key]!;
    // as CSS variables: the stylesheet applies them on screen only, so the
    // printed sheet keeps its natural column widths
    stick.set(c.key, { className: `stick ${i === pinned.length - 1 ? "stick-end" : ""}`, style: stickAt(left, w) });
    left += w;
  });
  /** The pinned block as one cell, for the rows that span it: the band, the totals. */
  const block = { span: pinned.length, style: stickAt(0, left) };
  return { shown, stick, block };
}
type Layout<K extends string> = ReturnType<typeof layoutOf<K>>;

const tdCls = <K extends string>(c: ColDef<K>, l: MaterialLineView) => (typeof c.td === "function" ? c.td(l) : c.td);

function LineRow<K extends string>({ line, layout, x, inGroup, className }: {
  line: MaterialLineView; layout: Layout<K>; x: ColCtx;
  /** A line under an opened SOI's head — framed with it; "last" closes the frame. */
  inGroup?: "child" | "last";
  className?: string;
}) {
  const cls = inGroup ? `mat-child ${inGroup === "last" ? "mat-child-last" : ""}` : className;
  return (
    <tr className={cls}>
      {layout.shown.map((c, i) => {
        const st = layout.stick.get(c.key);
        return <td key={c.key} className={`${tdCls(c, line)} ${inGroup && i === 0 ? "ps-4" : ""} ${st?.className ?? ""}`} style={st?.style}>{c.cell(line, x)}</td>;
      })}
    </tr>
  );
}

// ---- the SOI groups and the totals row ----

/** A row's cells along the shown columns: the columns `cellOf` has nothing
 *  for (null) run together into one spanning cell, the first such run holding `firstBlank`. */
function spanCells<K extends string>(cols: ColDef<K>[], cellOf: (c: ColDef<K>, i: number) => React.ReactNode | null, firstBlank: React.ReactNode = null): React.ReactNode[] {
  const cells: React.ReactNode[] = [];
  let blank = 0;
  let filled = false;
  const flush = (at: string) => {
    if (blank === 0) return;
    cells.push(<td key={`blank-${at}`} className="p-2" colSpan={blank}>{filled ? null : firstBlank}</td>);
    filled = true;
    blank = 0;
  };
  cols.forEach((c, i) => {
    const cell = cellOf(c, i);
    if (cell === null) { blank++; return; }
    flush(c.key);
    cells.push(cell);
  });
  flush("end");
  return cells;
}

function SoiGroupRow({ g, open, onToggle, layout, x, soiShown }: {
  g: MaterialSoiGroup; open: boolean; onToggle: () => void; layout: Layout<TrCol>; x: ColCtx;
  /** Whether the SOI column is on — off, the SOI is named in the row's summary instead. */
  soiShown: boolean;
}) {
  const n = g.lines.length;
  const label = g.soi || "No SOI";
  const shownMos = g.mos.slice(0, 4);
  const toggle = (
    <button type="button" onClick={onToggle} aria-expanded={open} className="icon-btn !inline-flex items-center !w-auto !h-auto px-0.5 py-0.5 gap-0.5 shrink-0 font-bold tabnum text-foreground" title={open ? `Fold this SOI's ${n} lines` : `Show this SOI's ${n} lines`} aria-label={open ? `Fold the ${n} lines of ${label}` : `Show the ${n} lines of ${label}`}>
      <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />{n}
    </button>
  );
  const summary = (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs ltr">
      <span className="font-semibold text-muted tabnum">{n} line{n === 1 ? "" : "s"}</span>
      {g.mos.length > 1 && shownMos.map((mo) => (
        <span key={mo} className="inline-flex items-center gap-1 text-muted">
          {mo}{x.odoo[mo.toUpperCase()] && <Check size={11} className="text-ok-fg" aria-label="on the ODOO log" />}
        </span>
      ))}
      {g.mos.length > shownMos.length && <span className="text-muted" title={g.mos.slice(4).join(", ")}>+{g.mos.length - shownMos.length} more</span>}
    </span>
  );
  // the columns with nothing to say for the group run together into one
  // cell; the first such run carries the group's summary
  const cells = spanCells(layout.shown, (c, i) => {
    if (!c.head) return null;
    const st = layout.stick.get(c.key);
    const body = c.head(g, x);
    return (
      <td key={c.key} className={`${typeof c.td === "string" ? c.td : `p-2 ${NUM} emph`} ${st?.className ?? ""}`} style={st?.style}>
        {i === 0 ? (
          <span className="flex items-center gap-1 min-w-0">
            {toggle}
            {/* the SOI column off: the group still says which SOI it is */}
            {!soiShown && <b className="truncate shrink-0 max-w-[50%]" title={label}>{label}</b>}
            <span className="min-w-0 flex-1">{body}</span>
          </span>
        ) : body}
      </td>
    );
  }, summary);
  return <tr className={`mat-group ${open ? "is-open" : ""}`}>{cells}</tr>;
}

/** What the lines on screen add up to, pinned under the sheet: the pinned
 *  block names it, each figure sits under its own column. */
function TotalRow({ s, filtering, layout }: { s: MaterialSummary; filtering: boolean; layout: Layout<TrCol> }) {
  const count = s.lines;
  const cells = spanCells(layout.shown.slice(layout.block.span), (c) => (c.sum ? <td key={c.key} className={`p-2 ${NUM} emph`}>{c.sum(s)}</td> : null));
  return (
    <tr>
      <td className="p-2 stick stick-end font-bold" colSpan={layout.block.span} style={layout.block.style}>
        Total <span className="text-xs text-muted font-semibold tabnum">· {count} line{count === 1 ? "" : "s"}{filtering ? " shown" : ""}</span>
      </td>
      {cells}
    </tr>
  );
}

/** The band over the headers: each run of columns under its name, with the
 *  arrow that folds it to its lead columns — the Plan Tracker's way. */
function RunBand<K extends string>({ runs, layout, cols }: { runs: ColRun<K>[]; layout: Layout<K>; cols: Columns<K> }) {
  const shown = new Set<string>(layout.shown.map((c) => c.key));
  const spans = runs.flatMap((r) => {
    const span = r.cols.filter((k) => shown.has(k)).length;
    if (span === 0) return [];
    const rest = r.cols.filter((k) => !r.lead.includes(k));
    const open = cols.anyOn(rest);
    const pinned = r.cols.every((k) => !shown.has(k) || layout.stick.has(k)) && r.cols.some((k) => layout.stick.has(k));
    return [{
      span,
      className: pinned ? "stick stick-end" : undefined,
      style: pinned ? layout.block.style : undefined,
      label: rest.length === 0 ? r.label : (
        <FoldButton open={open} onClick={() => cols.toggle(rest)} label={r.label} title={open ? `Fold ${r.label}: hide ${rest.length} of its columns` : `Show ${r.label}'s columns`} />
      ),
    }];
  });
  return <GroupBand spans={spans} runs />;
}

// ---- upload the sheet: it updates the table, row by MO ----

function ImportPanel({ product }: { product: ProductLine }) {
  const lv = product === "LV";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [showIssues, setShowIssues] = useState(false);
  const [menu, setMenu] = useState(false);
  // picking the file IS the upload — no preview; `prune` says whether lines
  // no longer in the file leave the table (off unless asked, and confirmed)
  const picker = useRef<HTMLInputElement>(null);
  const prune = useRef(false);
  const [confirm, confirmDialog] = useConfirm();
  function pick(withPrune: boolean) {
    prune.current = withPrune;
    setMenu(false);
    picker.current?.click();
  }
  // mirroring the file deletes for good — every line it does not carry
  async function pickMirror() {
    setMenu(false);
    const ok = await confirm({
      title: "Upload and remove the lines no longer in the file?",
      body: <>Every line on the table that the file does not carry leaves it for good — lines typed in by hand before too. Choose the file next.</>,
      confirmLabel: "Choose the file",
      danger: true,
    });
    if (ok) pick(true);
  }
  function upload(file: File) {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("preview", "false");
    if (prune.current) fd.set("prune", "on");
    setRes(null); setIssues([]); setShowIssues(false);
    startTransition(async () => {
      const r = await importMaterialAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) { setRes({ ok: false, text: r.error ?? "Import failed." }); return; }
      const stale = r.recomputed ? ` · ${r.recomputed} row(s) where the sheet's “Actual Nesting for Job” disagrees with its own per-unit rate × units — kept as written, worth a look` : "";
      const gone = r.missing ? (r.removed ? ` · ${r.removed} row(s) no longer in the file removed` : ` · ${r.missing} row(s) not in this file kept`) : "";
      setRes({ ok: true, text: `Table updated: ${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged${r.sheet ? ` (sheet “${r.sheet}”)` : ""}${gone}${stale}.` });
      router.refresh();
    });
  }
  const label = lv ? "Upload Consumption Details" : "Upload Material Sheet";
  const reads = lv
    ? "Reads the panels' Consumption Details sheet as it is — one row per thickness, matched on the MO. Uploading again updates the rows, never doubles them."
    : "Reads the sheet by its headers, each row matched on its MO (with the BOM, part, material, thickness and size). Uploading again adds the new rows and updates the changed ones — never doubles them.";
  return (
    <span className="relative inline-flex flex-wrap items-center gap-2">
      <input
        ref={picker} type="file" accept=".xlsx,.xlsm,.xls" className="hidden" aria-label={label}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }}
      />
      <span className="inline-flex">
        <button type="button" className="btn btn-sm btn-primary rounded-e-none" disabled={pending} onClick={() => pick(false)} title={`${reads} Rows no longer in the file stay.`}>
          <Upload size={14} aria-hidden />{pending ? "Uploading…" : label}
        </button>
        <button type="button" className="btn btn-sm btn-primary rounded-s-none border-s border-white/25 !px-1.5" disabled={pending} aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((v) => !v)} title="More upload options">
          <ChevronDown size={13} aria-hidden />
        </button>
      </span>
      {menu && (
        <span className="absolute top-full start-0 z-30 mt-1 w-72 rounded-[10px] border bg-surface shadow-xl p-1 text-sm">
          <button type="button" className="w-full text-start rounded-md px-2 py-1.5 hover:bg-surface-2" onClick={() => void pickMirror()}>
            Upload and remove the rows no longer in the file
            <span className="block text-xs text-muted">The table becomes exactly the file — asks first.</span>
          </button>
        </span>
      )}
      {res && <span className={`text-xs font-semibold ${res.ok ? "text-ok-fg" : "text-bad-fg"}`}>{res.text}</span>}
      {issues.length > 0 && (
        <button type="button" className="text-xs font-semibold text-warn-fg hover:underline" onClick={() => setShowIssues((v) => !v)}>
          {issues.length} note{issues.length === 1 ? "" : "s"} from the file
        </button>
      )}
      {showIssues && issues.length > 0 && (
        <ul className="absolute top-full start-0 z-30 mt-1 w-[28rem] max-w-[90vw] max-h-56 overflow-y-auto rounded-[10px] border bg-surface shadow-xl p-2 ps-6 text-xs text-warn-fg list-disc space-y-0.5">
          {issues.map((x, n) => <li key={n}>{x}</li>)}
        </ul>
      )}
      {confirmDialog}
    </span>
  );
}


// ---- the page body ----

// ---- filters: one row above the table; the totals follow what is shown ----

const FILTERS_KEY = "material:filters";

/** Only the known fields, as strings, with a status the page knows — whatever
 *  an old or hand-edited saved value holds. */
function readSavedFilters(raw: string): MaterialFilters {
  const o = parseSaved(raw);
  const status = savedString(o, "status");
  return {
    q: savedString(o, "q"), partCode: savedString(o, "partCode"), material: savedString(o, "material"),
    thicknessMm: savedString(o, "thicknessMm"), sheetSize: savedString(o, "sheetSize"),
    status: status in MATERIAL_STATUS_FILTERS ? (status as MaterialStatusFilter) : "all",
    planMonth: savedString(o, "planMonth"),
  };
}


function Pick({ label, value, options, onChange, render }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; render?: (v: string) => string;
}) {
  return <FilterSelect label={label} value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: render ? render(o) : o }))} />;
}

function FilterBar({ lines, filters, onChange, shown, lv, start, extra }: {
  lines: MaterialLineView[]; filters: MaterialFilters; onChange: (f: MaterialFilters) => void; shown: number; lv: boolean;
  /** First in the bar: the page's Transformers | LV Panels switch. */
  start?: React.ReactNode;
  /** At the bar's end: the views and the upload. */
  extra?: React.ReactNode;
}) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
  const parts = uniq(lines.map((l) => l.partCode));
  // the part's name as the lines carry it (FB-024 · CABLE BOX), else the preset's
  const partName = new Map<string, string>();
  for (const l of lines) if (l.partCode && l.partName && !partName.has(l.partCode)) partName.set(l.partCode, l.partName);
  const nameOf = (c: string) => partName.get(c) || partNameFor(c);
  const materials = uniq(lines.map((l) => l.material));
  const thicknesses = [...new Set(lines.map((l) => l.thicknessMm))].sort((a, b) => a - b).map(String);
  const sizes = uniq(lines.map((l) => l.sheetSize));
  // the monthly plans the lines' orders were in, newest first; a saved month
  // no line carries any more keeps its option, so the filter can be read and cleared
  const lineMonths = useMemo(() => materialPlanMonthOptions(lines), [lines]);
  const anyUnplanned = useMemo(() => lines.some((l) => l.planMonths.length === 0), [lines]);
  const planMonths = filters.planMonth && filters.planMonth !== NO_PLAN_MONTH && !lineMonths.includes(filters.planMonth) ? [filters.planMonth, ...lineMonths] : lineMonths;
  const hasNoPlan = filters.planMonth === NO_PLAN_MONTH || anyUnplanned;
  const set = (patch: Partial<MaterialFilters>) => onChange({ ...filters, ...patch });
  const active = JSON.stringify(filters) !== JSON.stringify(EMPTY_MATERIAL_FILTERS);
  return (
    <div className="toolbar-row no-print">
      {start}
      <label className="relative max-sm:basis-full">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input
          type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })}
          placeholder="Search MTR, BOM, SOI, MO, part, code, note…" aria-label="Search"
          className="ctl ltr w-full sm:w-64 pl-8"
        />
      </label>
      <FilterSelect
        label="Plan month" title="The monthly plan the lines' orders are in on the Plan Tracker" value={filters.planMonth} onChange={(v) => set({ planMonth: v })}
        options={[...planMonths.map((m) => ({ value: m, label: m })), ...(hasNoPlan ? [{ value: NO_PLAN_MONTH, label: "Not in a plan" }] : [])]}
      />
      <PhoneFold active={active}>
      <Pick label="Part" value={filters.partCode} options={parts} onChange={(v) => set({ partCode: v })} render={(c) => `${c}${nameOf(c) ? ` · ${nameOf(c)}` : ""}`} />
      <Pick label="Material" value={filters.material} options={materials} onChange={(v) => set({ material: v })} />
      <Pick label="Thickness" value={filters.thicknessMm} options={thicknesses} onChange={(v) => set({ thicknessMm: v })} render={(t) => `${t} mm`} />
      <Pick label="Sheet size" value={filters.sheetSize} options={sizes} onChange={(v) => set({ sheetSize: v })} />
      <FilterSelect
        label="Line status" title="Where the line stands" value={filters.status} emptyValue="all" allLabel={MATERIAL_STATUS_FILTERS.all}
        onChange={(v) => set({ status: v as MaterialStatusFilter })}
        options={(Object.keys(MATERIAL_STATUS_FILTERS) as MaterialStatusFilter[]).filter((k) => k !== "all" && (lv || k !== "produced")).map((k) => ({ value: k, label: MATERIAL_STATUS_FILTERS[k] }))}
      />
      </PhoneFold>
      <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-2 min-w-0">
      {extra}
      <span className="text-xs text-muted tabnum whitespace-nowrap">
        {active ? <><b className="text-foreground font-semibold">{shown}</b> of {lines.length} lines</> : `${lines.length} lines`}
      </span>
      </span>
      {active && <button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={() => onChange(EMPTY_MATERIAL_FILTERS)}><FilterX size={13} aria-hidden />Reset filters</button>}
    </div>
  );
}

/** What the lines shown add up to — a month's plan when one is picked. */
function SummaryStrip({ s, lv, planMonth }: { s: MaterialSummary; lv: boolean; planMonth: string }) {
  const scope = planMonth === NO_PLAN_MONTH ? "Not in a plan" : planMonth || "Every plan";
  // one line a figure — the figure, then what it means — so the strip stays
  // low and the table under it keeps the room to run to the window's foot
  const cell = (label: string, value: React.ReactNode, sub: React.ReactNode, tone = "") => (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-line">
        <span className={`kpi-value ltr ${tone}`}>{value}</span>
        <span className="kpi-sub">{sub}</span>
      </div>
    </div>
  );
  return (
    <div className="kpi-strip kpi-strip-line" role="group" aria-label={`What the lines shown add up to — ${scope}`}>
      {cell("Orders", formatNumber(s.orders), `${scope} · ${s.lines} line${s.lines === 1 ? "" : "s"}`)}
      {lv ? (
        <>
          {cell("Planned", formatQty(s.units), "units on the lines")}
          {cell("BOM qty", formatNumber(s.forJob, FIELD_DP.sheets), "sheets as per the BOM")}
          {cell("Consumed", formatNumber(s.forProduced, FIELD_DP.sheets), "sheets the produced units took")}
          {cell("Remaining", s.remainingUnits === null ? "—" : formatQty(s.remainingUnits), "units still to make")}
        </>
      ) : (
        <>
          {cell("BOM for job", formatNumber(s.forJob, FIELD_DP.sheets), "as the BOM allows")}
          {cell("Actual for job", formatNumber(s.sheetsUsed, FIELD_DP.sheets), "nested on the sheet")}
          {cell("Actual weight", s.actualWeightKg === null ? "—" : <>{formatNumber(s.actualWeightKg, 0)}<span className="text-sm text-muted ms-1">kg</span></>, "nested × one sheet's weight")}
          {cell("Difference", formatNumber(s.difference, FIELD_DP.sheets), s.overLines ? <span className="text-bad-fg font-semibold">{s.overLines} line{s.overLines === 1 ? "" : "s"} over the BOM</span> : "no line over the BOM", diffTone(s.difference))}
        </>
      )}
    </div>
  );
}

/** Columns ▾ — every column on or off, kept on the account; what the headers' colours mean below. */
function MaterialColumns<K extends string>({ cols, defs }: { cols: Columns<K>; defs: ColDef<K>[] }) {
  return (
    <ColumnMenu cols={cols} list={defs.filter((c) => c.key !== ALWAYS).map((c) => ({ key: c.key, label: c.name }))} fixed="MO" fixedTitle="MO always shows — it is what the line is">
      <div className="text-xs text-muted space-y-1">
        <GroupLegend groups={["source", "computed"]} />
        <p>The arrows on the band over the headers fold a run of columns and open it again.</p>
      </div>
    </ColumnMenu>
  );
}

export function MaterialClient({ lines, canImport, product = "TR", odooByMo = {}, lineSwitch, prefs = {} }: {
  lines: MaterialLineView[];
  /** May upload the sheet — the tab's only change; nothing is typed in it. */
  canImport: boolean;
  /** The page's Transformers | LV Panels switch, first in its toolbar. */
  lineSwitch?: React.ReactNode;
  /** MO (upper case) → its status on the ODOO log. */
  odooByMo?: Record<string, string>;
  /** Which product line's nesting this is — the panels' and the transformers' sheets differ. */
  product?: ProductLine;
  /** This person's saved columns, the transformers' and the panels'. */
  prefs?: UserPrefs;
}) {
  const lv = product === "LV";
  const { filters: saved, setFilters: changeFilters } = useStoredFilters(FILTERS_KEY, readSavedFilters, EMPTY_MATERIAL_FILTERS);
  // only the panels' tab counts units produced — a "with produced" kept from
  // there means nothing on the transformers' sheet
  const filters = useMemo(() => (!lv && saved.status === "produced" ? { ...saved, status: "all" as const } : saved), [lv, saved]);
  const shown = useMemo(() => filterMaterialLines(lines, filters), [lines, filters]);
  const filtering = shown.length !== lines.length;
  const summary = useMemo(() => materialSummary(shown), [shown]);
  // each person's columns, one set per line's sheet, kept on their account
  const trCols = useColumns<TrCol>("material:cols", prefs["material:cols"], TR_DEFAULT);
  const lvCols = useColumns<LvCol>("material:colsLv", prefs["material:colsLv"], LV_DEFAULT);
  // rebuilt only when the columns picked change, not on every keystroke in the search
  const trOn = TR_COLS.map((c) => trCols.isOn(c.key)).join();
  const lvOn = LV_COLS.map((c) => lvCols.isOn(c.key)).join();
  const trLayout = useMemo(() => layoutOf(TR_COLS, trCols.isOn, STICK_W), [trOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const lvLayout = useMemo(() => layoutOf(LV_COLS, lvCols.isOn, {}), [lvOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const x = useMemo<ColCtx>(() => ({ odoo: odooByMo, product }), [odooByMo, product]);
  // the transformers' sheet reads by SOI, its MOs under it; the switch puts
  // the plain sheet order back. A folded SOI stays folded while the page is open.
  const [bySoi, setBySoi] = useState(true);
  const soiGroups = useMemo(() => groupMaterialBySoi(shown), [shown]);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggleFold = (soi: string) => setFolded((f) => { const n = new Set(f); if (n.has(soi)) n.delete(soi); else n.add(soi); return n; });
  return (
    <div className="space-y-4">
      <div className="toolbar !mb-0">
        {/* one bar: the line switch first, the filters, then the views and the upload at its end */}
        {lines.length > 0 ? (
          <FilterBar
            lines={lines} filters={filters} onChange={changeFilters} shown={shown.length} lv={lv}
            start={lineSwitch}
            extra={(
              <>
                {!lv && (
                  <button type="button" className="chip-toggle whitespace-nowrap" aria-pressed={bySoi} onClick={() => setBySoi((v) => !v)} title="Group the lines by SOI, each order's MOs under it">
                    Group by SOI
                  </button>
                )}
                {lv ? <MaterialColumns cols={lvCols} defs={LV_COLS} /> : <MaterialColumns cols={trCols} defs={TR_COLS} />}
                {canImport && <ImportPanel product={product} />}
              </>
            )}
          />
        ) : (canImport || lineSwitch) && (
          <div className="toolbar-row no-print">
            {lineSwitch}
            {canImport && <ImportPanel product={product} />}
          </div>
        )}
      </div>
      {shown.length > 0 && <SummaryStrip s={summary} lv={lv} planMonth={filters.planMonth} />}
      <section className="bg-surface border rounded-[10px] overflow-hidden">
        {lines.length === 0 ? (
          <TableEmpty
            title="The table is empty"
            hint={lv ? "Upload the Consumption Details sheet — the table fills from it." : "Upload the material sheet — the table fills from it."}
            action={canImport ? <ImportPanel product={product} /> : undefined}
          />
        ) : shown.length === 0 ? (
          <TableEmpty
            title="No line matches these filters"
            hint={`${lines.length} lines are hidden by the filters above.`}
            action={<button type="button" className="btn btn-sm btn-secondary" onClick={() => changeFilters(EMPTY_MATERIAL_FILTERS)}><FilterX size={13} aria-hidden />Reset filters</button>}
            filtered
          />
        ) : lv ? (
          <TableFrame>
            <table className="erp-table w-full border-collapse">
              <thead>
                <RunBand runs={LV_RUNS} layout={lvLayout} cols={lvCols} />
                <tr className="text-left align-bottom">
                  {lvLayout.shown.map((c) => <Th key={c.key} {...c.th} />)}
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => <LineRow key={l.id} line={l} layout={lvLayout} x={x} className={`border-t ${lvDone(l) ? "bg-ok-bg/30" : ""}`} />)}
              </tbody>
            </table>
          </TableFrame>
        ) : (
          <TableFrame>
            <table className="erp-table w-full border-collapse">
              <thead>
                <RunBand runs={TR_RUNS} layout={trLayout} cols={trCols} />
                <tr className="text-left align-bottom">
                  {trLayout.shown.map((c) => {
                    const st = trLayout.stick.get(c.key);
                    return <Th key={c.key} {...c.th} className={`${c.th.className ?? ""} ${st?.className ?? ""}`} style={st?.style} />;
                  })}
                </tr>
              </thead>
              <tbody>
                {!bySoi
                  ? shown.map((l) => <LineRow key={l.id} line={l} layout={trLayout} x={x} />)
                  : soiGroups.map((g) => (
                    // a SOI of one line needs no head: the line is the row
                    g.lines.length === 1 ? <LineRow key={g.lines[0].id} line={g.lines[0]} layout={trLayout} x={x} /> : (
                    <Fragment key={`soi-${g.soi}`}>
                      <SoiGroupRow g={g} open={!folded.has(g.soi)} onToggle={() => toggleFold(g.soi)} layout={trLayout} x={x} soiShown={trCols.isOn("soi")} />
                      {!folded.has(g.soi) && g.lines.map((l, i) => <LineRow key={l.id} line={l} layout={trLayout} x={x} inGroup={i === g.lines.length - 1 ? "last" : "child"} />)}
                    </Fragment>
                  )))}
              </tbody>
              <tfoot className="mat-total">
                <TotalRow s={summary} filtering={filtering} layout={trLayout} />
              </tfoot>
            </table>
          </TableFrame>
        )}
      </section>
    </div>
  );
}

/** A line's BOM, opening its order's page (the trace: pipeline, orders, log). */
function BomLink({ bom, line }: { bom: string; line: ProductLine }) {
  if (!bom) return <span className="text-muted">—</span>;
  return <Link href={traceHref({ bom, line })} className="text-brand-ink hover:underline" title="Open the order's details">{bom}</Link>;
}
