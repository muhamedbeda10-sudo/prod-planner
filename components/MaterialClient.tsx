"use client";

import { traceHref } from "@/lib/domain/links";
import Link from "next/link";

import type { ProductLine } from "@/lib/domain/lines";

import { useRouter } from "next/navigation";
import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import {
  MATERIAL_STATUS_FILTERS, EMPTY_MATERIAL_FILTERS,
  partNameFor, filterMaterialLines, groupMaterialBySoi,
  type MaterialLineView, type MaterialFilters, type MaterialStatusFilter, type MaterialSoiGroup,
} from "@/lib/domain/material";
import { FIELD_DP, formatNumber, formatQty } from "@/lib/domain/format";
import { odooRateOf, type OdooRates } from "@/lib/domain/odooBom";
import { FilterSelect, PhoneFold } from "@/components/FilterControls";
import { Check, ChevronDown, ChevronRight, FilterX, Search, Upload } from "lucide-react";
import { GroupBand, GroupLegend, TableEmpty, TableFrame, Th, useConfirm } from "@/components/DataTable";
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
// Job · Difference · Notes. The sheet is the tab's only source: nothing is
// typed, edited or deleted here — uploading the sheet again is how a line
// changes. Sheets-for-job, actual weight and Difference are computed. One
// column of the transformers' table is read from elsewhere and only shown:
// Odoo / unit, what Odoo's BoM (Material → BoMs) says the part takes, beside
// the sheet's BOM / unit. The panels' sheet files a SEC item per thickness,
// which no BoM line answers, so it has none.

/* The sheet's own column names are sentences ("No. of Sheets in Actual
   Nesting for one Unit"): the headers carry a short label, and the sheet's
   whole name sits in each one's tooltip (and stays the export's heading). */
/** A numeric column's header and cells: right-aligned, so figures line up. */
const NUM = "num";

/** The identifiers stay on screen while the figures scroll past: MTR, SOI and
 *  MO are pinned (from a laptop up) at fixed widths. */
const STICK_W = ["6.5rem", "6.75rem", "16rem"] as const;
const STICK_LEFT = ["0rem", "6.5rem", "13.25rem"] as const;
const stickCls = (i: number) => `stick ${i === STICK_W.length - 1 ? "stick-end" : ""}`;
// as CSS variables: the stylesheet applies them on screen only, so the printed
// sheet keeps its natural column widths
const stickStyle = (i: number) => ({ "--stick-left": STICK_LEFT[i], "--stick-w": STICK_W[i] }) as React.CSSProperties;

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

/** What Odoo's BoM says one unit of the part takes of the line's material,
 *  beside the sheet's own figure (lib/domain/odooBom.ts odooRateOf): amber
 *  where the two disagree; a figure in another unit than pieces is shown with
 *  its unit and never compared with sheets. */
function OdooRate({ line, rates }: { line: MaterialLineView; rates: OdooRates }) {
  const r = odooRateOf(rates, line);
  if (r.kind === "unknown") return <span className="text-muted" title={r.why}>—</span>;
  if (r.kind === "absent") return <span className="pill pill-warn" title={`Odoo's BoM for ${line.partCode} has no ${line.materialCode}`}>not in BoM</span>;
  if (!r.comparable) return <span className="tabnum ltr text-muted" title={`Odoo counts it in ${r.uom}, the sheet in sheets`}>{formatNumber(r.qty, FIELD_DP.factor)} {r.uom}</span>;
  return (
    <span className={`tabnum ltr ${r.differs ? "text-warn-fg font-bold" : ""}`} title={r.differs ? `The sheet says ${line.sheetsPerUnit}, Odoo's BoM ${r.qty}` : `Odoo's BoM: ${r.qty}`}>
      {formatNumber(r.qty, FIELD_DP.factor)}
    </span>
  );
}

// ---- one row of the table ----

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

function LineRow({ line, showMonth, product, odoo, rates, inGroup }: {
  line: MaterialLineView; showMonth: boolean; product: ProductLine; odoo: Record<string, string>; rates: OdooRates;
  /** A line under an opened SOI's head — framed with it; "last" closes the frame. */
  inGroup?: "child" | "last";
}) {
  const diffCls = line.difference === null ? "" : line.difference < 0 ? "text-bad-fg" : line.difference > 0 ? "text-ok-fg" : "text-muted";
  if (product === "LV") {
    // the panels' sheet: the order's head, then the thickness row, then what
    // the tracker produced and what that consumed
    const done = line.remainingUnits === 0 && line.units > 0;
    return (
      <tr className={`border-t ${done ? "bg-ok-bg/30" : ""}`}>
        <td className="p-2 font-bold whitespace-nowrap ltr text-xs"><MoCell mo={line.mo} odoo={odoo} /></td>
        <td className="p-2 text-center"><span className="pill pill-muted">{line.partName || "—"}</span></td>
        <td className="p-2 whitespace-nowrap ltr text-xs tabnum text-muted">{line.materialCode || "—"}</td>
        <td className="p-2 text-center tabnum font-bold">{line.units}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs"><BomLink bom={line.bom} line={product} /></td>
        <td className="p-2 whitespace-nowrap">{line.material}</td>
        <td className="p-2 text-center tabnum ltr">{line.thicknessMm}</td>
        <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
        <td className="p-2 text-center"><Sheets v={line.sheetsPerUnit} digits={FIELD_DP.factor} /></td>
        <td className="p-2 text-center font-bold"><Sheets v={line.forJob} /></td>
        <td className="p-2 text-center"><Sheets v={line.actualPerUnit} digits={FIELD_DP.factor} /></td>
        <td className="p-2 text-center bg-brand-light/30 whitespace-nowrap" title={line.producedQty === null && line.producedAuto !== null ? "Panels painted on the tracker" : undefined}>
          <Units v={line.producedUsed} />
          {line.producedQty === null && line.producedAuto !== null && <span className="block text-[10px] text-muted">tracker</span>}
        </td>
        <td className="p-2 text-center font-extrabold bg-brand-light/30" title={line.producedUsed === null ? "Nothing produced yet" : `${line.producedUsed} units × ${Number((line.actualPerUnit ?? line.sheetsPerUnit).toFixed(4))} sheets a unit`}>
          <Sheets v={line.forProduced ?? (line.producedUsed === null ? null : Number((line.sheetsPerUnit * line.producedUsed).toFixed(4)))} />
        </td>
        <td className={`p-2 text-center tabnum font-bold ${done ? "text-ok-fg" : ""}`}>{line.remainingUnits === null ? "—" : done ? "Done" : line.remainingUnits}</td>
        <td className="p-2 text-xs max-w-[200px]">{line.note}</td>
        {showMonth && <td className="p-2 whitespace-nowrap text-xs">{line.month || <span className="text-muted">—</span>}</td>}
      </tr>
    );
  }
  return (
    <tr className={inGroup ? `mat-child ${inGroup === "last" ? "mat-child-last" : ""}` : undefined}>
      <td className={`p-2 whitespace-nowrap ltr text-xs ${inGroup ? "ps-4" : ""} ${stickCls(0)}`} style={stickStyle(0)}><span className="block truncate" title={line.mtr || undefined}>{line.mtr || <span className="text-muted">—</span>}</span></td>
      <td className={`p-2 whitespace-nowrap ltr text-xs font-semibold ${stickCls(1)}`} style={stickStyle(1)}><span className="block truncate" title={line.soi || undefined}>{line.soi || <span className="text-muted">—</span>}</span></td>
      {/* the sheet files each part under Odoo's MO — the key an ODOO row finds it by */}
      <td className={`p-2 font-bold whitespace-nowrap ltr text-xs ${stickCls(2)}`} style={stickStyle(2)}><MoCell mo={line.mo} odoo={odoo} /></td>
      <td className="p-2 whitespace-nowrap ltr text-xs"><BomLink bom={line.bom} line={product} /></td>
      <td className={`p-2 ${NUM} tabnum ltr`}>{line.units}</td>
      <td className="p-2 whitespace-nowrap ltr text-xs font-bold">{line.partCode || <span className="text-muted">—</span>}</td>
      <td className="p-2 whitespace-nowrap text-xs">{line.partName || <span className="text-muted">—</span>}</td>
      <td className="p-2 whitespace-nowrap ltr text-xs">{line.materialCode || <span className="text-muted">—</span>}</td>
      <td className="p-2 whitespace-nowrap">{line.material}</td>
      <td className={`p-2 ${NUM} tabnum ltr`}>{line.thicknessMm}</td>
      <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
      <td className={`p-2 ${NUM} tabnum`}><Sheets v={line.weightKg} digits={3} /></td>
      <td className={`p-2 ${NUM}`}><Sheets v={line.sheetsPerUnit} digits={FIELD_DP.factor} /></td>
      <td className={`p-2 ${NUM}`}><OdooRate line={line} rates={rates} /></td>
      <td className={`p-2 ${NUM}`}><Sheets v={line.actualPerUnit} digits={FIELD_DP.factor} /></td>
      <td className={`p-2 ${NUM} emph`}><Sheets v={line.forJob} /></td>
      <td className={`p-2 ${NUM} emph`}><Sheets v={line.sheetsUsed} className="font-bold" /></td>
      <td className={`p-2 ${NUM}`}><Utilization v={line.utilization} /></td>
      <td className={`p-2 ${NUM} emph tabnum`} title={line.actualWeightKg === null ? "Needs the pieces nested for the job and the weight" : `${line.sheetsUsed} × ${line.weightKg} kg`}><Sheets v={line.actualWeightKg} digits={3} /></td>
      <td className={`p-2 ${NUM} emph ${diffCls}`}><Sheets v={line.difference} /></td>
      <td className="p-2 text-xs min-w-[8rem] max-w-[200px]">{line.note}</td>
      {showMonth && <td className="p-2 whitespace-nowrap text-xs">{line.month || <span className="text-muted">—</span>}</td>}
    </tr>
  );
}

// ---- the SOI groups and the totals row ----

/** The sticky identifier block (MTR · SOI · MO) as one cell, for the rows
 *  that span it: a group's head, the totals. */
const STICK_ALL = { "--stick-left": "0rem", "--stick-w": "29.25rem" } as React.CSSProperties;

type Sums = Pick<MaterialSoiGroup, "forJob" | "sheetsUsed" | "actualWeightKg" | "difference">;

/** The figures of a group or of the table, each under its own column. */
function SumCells({ s, showMonth }: { s: Sums; showMonth: boolean }) {
  const diffCls = s.difference === null ? "" : s.difference < 0 ? "text-bad-fg" : s.difference > 0 ? "text-ok-fg" : "text-muted";
  return (
    <>
      <td className={`p-2 ${NUM} emph`}><Sheets v={s.forJob} /></td>
      <td className={`p-2 ${NUM} emph`}><Sheets v={s.sheetsUsed} /></td>
      <td />
      <td className={`p-2 ${NUM} emph`}><Sheets v={s.actualWeightKg} digits={3} /></td>
      <td className={`p-2 ${NUM} emph ${diffCls}`}><Sheets v={s.difference} /></td>
      <td />
      {showMonth && <td />}
    </>
  );
}

/** What every line of a group agrees on — or null where they differ. */
function sharedOf<T>(values: T[]): T | null {
  return values.every((v) => v === values[0]) ? values[0] : null;
}
function SoiGroupRow({ g, open, onToggle, odoo, showMonth, product }: { g: MaterialSoiGroup; open: boolean; onToggle: () => void; odoo: Record<string, string>; showMonth: boolean; product: ProductLine }) {
  const onOdoo = g.mos.filter((mo) => odoo[mo.toUpperCase()]);
  const shownMos = g.mos.slice(0, 4);
  const n = g.lines.length;
  const label = g.soi || "No SOI";
  const s: Sums = g;
  const diffCls = s.difference === null ? "" : s.difference < 0 ? "text-bad-fg" : s.difference > 0 ? "text-ok-fg" : "text-muted";
  const sharedMo = sharedOf(g.lines.map((l) => l.mo.trim()));
  const sharedBom = sharedOf(g.lines.map((l) => l.bom));
  const sharedNote = sharedOf(g.lines.map((l) => l.note ?? ""));
  const sharedMonth = sharedOf(g.lines.map((l) => l.month));
  return (
    <tr className={`mat-group ${open ? "is-open" : ""}`}>
      <td className={`p-2 ltr text-xs ${stickCls(0)}`} style={stickStyle(0)}>
        <span className="flex items-center gap-1">
          <button type="button" onClick={onToggle} aria-expanded={open} className="icon-btn !inline-flex items-center !w-auto !h-auto px-0.5 py-0.5 gap-0.5 shrink-0 font-bold tabnum text-foreground" title={open ? `Fold this SOI's ${n} lines` : `Show this SOI's ${n} lines`} aria-label={open ? `Fold the ${n} lines of ${label}` : `Show the ${n} lines of ${label}`}>
            <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />{n}
          </button>
          <span className="block truncate">{sharedOf(g.lines.map((l) => l.mtr)) || <span className="text-muted">—</span>}</span>
        </span>
      </td>
      <td className={`p-2 ltr text-xs font-bold ${stickCls(1)}`} style={stickStyle(1)}>
        <span className="block truncate">{g.soi || <span className="text-muted font-semibold">No SOI</span>}</span>
      </td>
      <td className={`p-2 font-bold whitespace-nowrap ltr text-xs ${stickCls(2)}`} style={stickStyle(2)}>
        {sharedMo !== null ? <MoCell mo={sharedMo} odoo={odoo} /> : (
          <span className="flex items-center gap-1.5">
            {g.mos.length} MOs
            <span
              className={`pill ${onOdoo.length === g.mos.length ? "pill-ok" : onOdoo.length ? "pill-warn" : "pill-muted"}`}
              title={onOdoo.length ? `On the ODOO log: ${onOdoo.join(", ")}` : "No ODOO row carries these MOs yet"}
            >
              {onOdoo.length > 0 && <Check size={10} aria-hidden />}ODOO {onOdoo.length}/{g.mos.length}
            </span>
          </span>
        )}
      </td>
      <td className="p-2 whitespace-nowrap ltr text-xs">
        {sharedBom !== null
          ? <BomLink bom={sharedBom} line={product} />
          : <span className="text-muted" title={[...new Set(g.lines.map((l) => l.bom))].join(", ")}>{new Set(g.lines.map((l) => l.bom)).size} BOMs</span>}
      </td>
      <td className={`p-2 ${NUM}`}><Units v={sharedOf(g.lines.map((l) => l.units))} /></td>
      <td className="p-2" colSpan={10}>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs ltr">
          <span className="font-semibold text-muted tabnum">{n} line{n === 1 ? "" : "s"}</span>
          {g.mos.length > 1 && shownMos.map((mo) => (
            <span key={mo} className="inline-flex items-center gap-1 text-muted">
              {mo}{odoo[mo.toUpperCase()] && <Check size={11} className="text-ok-fg" aria-label="on the ODOO log" />}
            </span>
          ))}
          {g.mos.length > shownMos.length && <span className="text-muted" title={g.mos.slice(4).join(", ")}>+{g.mos.length - shownMos.length} more</span>}
        </span>
      </td>
      <td className={`p-2 ${NUM} emph`}><Sheets v={s.forJob} /></td>
      <td className={`p-2 ${NUM} emph`} title="The lines' pieces nested for the job, added up"><Sheets v={s.sheetsUsed} /></td>
      <td className={`p-2 ${NUM}`}><Utilization v={sharedOf(g.lines.map((l) => l.utilization))} /></td>
      <td className={`p-2 ${NUM} emph`}><Sheets v={s.actualWeightKg} digits={3} /></td>
      <td className={`p-2 ${NUM} emph ${diffCls}`}><Sheets v={s.difference} /></td>
      <td className="p-2 text-xs min-w-[8rem] max-w-[200px]">{sharedNote ?? <span className="text-muted">…</span>}</td>
      {showMonth && <td className="p-2 whitespace-nowrap text-xs">{sharedMonth ?? <span className="text-muted">…</span>}</td>}
    </tr>
  );
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
  };
}


function Pick({ label, value, options, onChange, render }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; render?: (v: string) => string;
}) {
  return <FilterSelect label={label} value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: render ? render(o) : o }))} />;
}

function FilterBar({ lines, filters, onChange, shown, lv, extra }: { lines: MaterialLineView[]; filters: MaterialFilters; onChange: (f: MaterialFilters) => void; shown: number; lv: boolean; extra?: React.ReactNode }) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
  const parts = uniq(lines.map((l) => l.partCode));
  // the part's name as the lines carry it (FB-024 · CABLE BOX), else the preset's
  const partName = new Map<string, string>();
  for (const l of lines) if (l.partCode && l.partName && !partName.has(l.partCode)) partName.set(l.partCode, l.partName);
  const nameOf = (c: string) => partName.get(c) || partNameFor(c);
  const materials = uniq(lines.map((l) => l.material));
  const thicknesses = [...new Set(lines.map((l) => l.thicknessMm))].sort((a, b) => a - b).map(String);
  const sizes = uniq(lines.map((l) => l.sheetSize));
  const set = (patch: Partial<MaterialFilters>) => onChange({ ...filters, ...patch });
  const active = JSON.stringify(filters) !== JSON.stringify(EMPTY_MATERIAL_FILTERS);
  return (
    <div className="toolbar-row no-print">
      <label className="relative max-sm:basis-full">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input
          type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })}
          placeholder="Search MTR, BOM, SOI, MO, part, code, note…" aria-label="Search"
          className="ctl ltr w-full sm:w-64 pl-8"
        />
      </label>
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
      <span className="ml-auto inline-flex items-center gap-3">
      {extra}
      <span className="text-xs text-muted tabnum whitespace-nowrap">
        {active ? <><b className="text-foreground font-semibold">{shown}</b> of {lines.length} lines</> : `${lines.length} lines`}
      </span>
      </span>
      {active && <button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={() => onChange(EMPTY_MATERIAL_FILTERS)}><FilterX size={13} aria-hidden />Reset filters</button>}
    </div>
  );
}

export function MaterialClient({ lines, month, canImport, product = "TR", odooByMo = {}, odooRates = {}, lineSwitch }: {
  lines: MaterialLineView[]; month: string;
  /** Odoo's BOM figure per part and material (transformers; odooRateKey). */
  odooRates?: OdooRates;
  /** May upload the sheet — the tab's only change; nothing is typed in it. */
  canImport: boolean;
  /** The page's Transformers | LV Panels switch, first in its toolbar. */
  lineSwitch?: React.ReactNode;
  /** MO (upper case) → its status on the ODOO log. */
  odooByMo?: Record<string, string>;
  /** Which product line's nesting this is — the panels' and the transformers' sheets differ. */
  product?: ProductLine;
}) {
  const showMonth = month === "all";
  const lv = product === "LV";
  const { filters: saved, setFilters: changeFilters } = useStoredFilters(FILTERS_KEY, readSavedFilters, EMPTY_MATERIAL_FILTERS);
  // only the panels' tab counts units produced — a "with produced" kept from
  // there means nothing on the transformers' sheet
  const filters = useMemo(() => (!lv && saved.status === "produced" ? { ...saved, status: "all" as const } : saved), [lv, saved]);
  const shown = useMemo(() => filterMaterialLines(lines, filters), [lines, filters]);
  const filtering = shown.length !== lines.length;
  // the transformers' sheet reads by SOI, its MOs under it; the switch puts
  // the plain sheet order back. A folded SOI stays folded while the page is open.
  const [bySoi, setBySoi] = useState(true);
  const soiGroups = useMemo(() => groupMaterialBySoi(shown), [shown]);
  const shownSums = useMemo(() => {
    const all = groupMaterialBySoi(shown.map((l) => ({ ...l, soi: "" })))[0];
    return all ?? { forJob: 0, sheetsUsed: null, actualWeightKg: null, difference: null };
  }, [shown]);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggleFold = (soi: string) => setFolded((f) => { const n = new Set(f); if (n.has(soi)) n.delete(soi); else n.add(soi); return n; });
  return (
    <div className="space-y-4">
      <div className="toolbar !mb-0">
        {(canImport || lineSwitch) && (
          <div className="toolbar-row no-print">
            {lineSwitch}
            {canImport && <ImportPanel product={product} />}
          </div>
        )}
        {lines.length > 0 && (
          <FilterBar
            lines={lines} filters={filters} onChange={changeFilters} shown={shown.length} lv={lv}
            extra={lv ? undefined : (
              <button type="button" className="chip-toggle" aria-pressed={bySoi} onClick={() => setBySoi((v) => !v)} title="Group the lines by SOI, each order's MOs under it">
                Group by SOI
              </button>
            )}
          />
        )}
      </div>
      <section className="bg-surface border rounded-[10px] overflow-hidden">
        {lines.length === 0 ? (
          <TableEmpty
            title={showMonth ? "No material recorded yet" : month ? `Nothing filed under ${month}` : "The table is empty"}
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
        ) : (
          <TableFrame>
            <table className="erp-table w-full border-collapse">
              <thead>
                {/* The Nesting Tracker's OWN columns, in the sheet's order and
                    under the sheet's own names, so the tab reads as the sheet
                    does — every figure from the sheet or worked out from it. */}
                {lv ? (
                  <>
                  <GroupBand spans={[
                    { span: 9, group: "source", label: <GroupLegend groups={["source", "computed"]} /> },
                    { span: 1, group: "computed" },
                    { span: 2, group: "source" },
                    { span: 2, group: "computed" },
                    { span: 1, group: "source" },
                    ...(showMonth ? [{ span: 1 }] : []),
                  ]} />
                  <tr className="text-left align-bottom">
                    <Th label="MO" group="source" />
                    <Th label="Product" group="source" center />
                    <Th label="Sec item" full="Sec Item" group="source" />
                    <Th label="Planned" unit="pcs" full="Planned qty" group="source" num />
                    <Th label="BOM" group="source" />
                    <Th label="Material" group="source" />
                    <Th label="Thk" unit="mm" full="Thickness" group="source" num />
                    <Th label="Sheet size" full="Sheet Size" group="source" center />
                    <Th label="BOM / unit" unit="sheets" full="No. of Sheets in BOM for one Unit" group="source" num />
                    <Th label="BOM qty" unit="sheets" full="Sheets Qty as per BOM" hint="Per unit × planned qty" group="computed" num />
                    <Th label="Actual / unit" unit="sheets" full="Actual per Unit" hint="Sheets one unit really takes, from the sheet — blank means the BOM's figure" group="source" num />
                    <Th label="Produced" unit="pcs" hint="The sheet's count, else the panels painted on the tracker" group="source" num />
                    <Th label="Consumed" unit="sheets" full="Actually Consumed" hint="Sheets the produced panels consumed — per unit × produced" group="computed" num />
                    <Th label="Remaining" unit="pcs" full="Remaining units" group="computed" num />
                    <Th label="Remarks" group="source" />
                    {showMonth && <Th label="Month" />}
                  </tr>
                  </>
                ) : (
                <>
                <GroupBand spans={[
                  { span: 3, label: <GroupLegend groups={["source", "computed"]} />, className: "stick stick-end", style: STICK_ALL },
                  { span: 10, group: "source" },
                  { span: 1 }, // Odoo / unit — from Odoo's BoM, not the sheet
                  { span: 1, group: "source" },
                  { span: 1, group: "computed" },
                  { span: 2, group: "source" },
                  { span: 2, group: "computed" },
                  { span: 1, group: "source" },
                  ...(showMonth ? [{ span: 1 }] : []),
                ]} />
                <tr className="text-left align-bottom">
                  <Th label="MTR #" full="MTR Request #" hint="The material request the sheets were drawn on" group="source" className={stickCls(0)} style={stickStyle(0)} />
                  <Th label="SOI" group="source" className={stickCls(1)} style={stickStyle(1)} />
                  <Th label="MO" hint="Odoo's MO for the part — the ODOO log finds the line by it" group="source" className={stickCls(2)} style={stickStyle(2)} />
                  <Th label="BOM" full="BOM Ref" group="source" />
                  <Th label="Units" unit="pcs" full="Quantity of Units" group="source" num />
                  <Th label="Part code" full="Part Code" group="source" />
                  <Th label="Part name" full="Part Name" group="source" />
                  <Th label="Mat. code" full="Material Code" group="source" />
                  <Th label="Material" group="source" />
                  <Th label="Thk" unit="mm" full="Thickness" group="source" num />
                  <Th label="Sheet size" full="Sheet Size" group="source" center />
                  <Th label="Weight" unit="kg" full="Weight(Kg)" hint="One sheet's weight" group="source" num />
                  <Th label="BOM / unit" full="BOM Qty for one Unit" group="source" num />
                  <Th label="Odoo / unit" full="The material one part takes per Odoo's BoM" hint="Not from the sheet: read off Odoo's BoM (Material → BoMs), shown beside it for comparison. Amber = differs from the sheet's BOM / unit" num />
                  <Th label="Actual / unit" full="No. of Pieces in Actual Nesting for one Unit" hint="From the sheet — where it leaves it blank, Actual for job ÷ units" group="source" num />
                  <Th label="BOM for job" full="BOM Pieces for Job" hint="BOM Qty for one Unit × units" group="computed" num className="emph" />
                  <Th label="Actual for job" full="No. of Pieces in Actual Nesting for Job" hint="From the sheet" group="source" num className="emph" />
                  <Th label="Utilization" full="Average Utilization" hint="As the sheet writes it — 0.85 or 85" group="source" num />
                  <Th label="Actual weight" unit="kg" full="Actual Weight (Kg)" hint="Pieces in Actual Nesting for Job × Weight(Kg)" group="computed" num className="emph" />
                  <Th label="Difference" hint="BOM Pieces for Job − Actual Nesting for Job. Red = ate more than the BOM allows" group="computed" num className="emph" />
                  <Th label="Notes" group="source" />
                  {showMonth && <Th label="Month" />}
                </tr>
                </>
                )}
              </thead>
              <tbody>
                {lv || !bySoi
                  ? shown.map((l) => <LineRow key={l.id} line={l} showMonth={showMonth} product={product} odoo={odooByMo} rates={odooRates} />)
                  : soiGroups.map((g) => (
                    // a SOI of one line needs no head: the line is the row
                    g.lines.length === 1 ? <LineRow key={g.lines[0].id} line={g.lines[0]} showMonth={showMonth} product={product} odoo={odooByMo} rates={odooRates} /> : (
                    <Fragment key={`soi-${g.soi}`}>
                      <SoiGroupRow g={g} open={!folded.has(g.soi)} onToggle={() => toggleFold(g.soi)} odoo={odooByMo} showMonth={showMonth} product={product} />
                      {!folded.has(g.soi) && g.lines.map((l, i) => <LineRow key={l.id} line={l} showMonth={showMonth} product={product} odoo={odooByMo} rates={odooRates} inGroup={i === g.lines.length - 1 ? "last" : "child"} />)}
                    </Fragment>
                  )))}
              </tbody>
              {!lv && (
                // what the lines on screen add up to, pinned under the sheet
                <tfoot className="mat-total">
                  <tr>
                    <td className="p-2 stick stick-end font-bold" colSpan={3} style={STICK_ALL}>
                      Total <span className="text-xs text-muted font-semibold tabnum">· {shown.length} line{shown.length === 1 ? "" : "s"}{filtering ? " shown" : ""}</span>
                    </td>
                    <td colSpan={12} />
                    <SumCells s={shownSums} showMonth={showMonth} />
                  </tr>
                </tfoot>
              )}
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
