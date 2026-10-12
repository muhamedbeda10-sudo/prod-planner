"use client";

import Link from "next/link";

import type { ProductLine } from "@/lib/domain/lines";
import type { LvOrderRef, MaterialPageData } from "@/lib/server/material";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useMemo, useRef, useState, useTransition } from "react";
import {
  MATERIAL_PRESETS, PART_PRESETS, SHEET_SIZE_PRESETS, MATERIAL_STATUS_FILTERS, EMPTY_MATERIAL_FILTERS,
  partNameFor, filterMaterialLines, summarizeMaterial, groupMaterialBySoi,
  type MaterialLineView, type MaterialTotal, type MaterialFilters, type MaterialStatusFilter, type MaterialSoiGroup,
} from "@/lib/domain/material";
import { Modal } from "@/components/Modal";
import { FIELD_DP, formatNumber, formatQty } from "@/lib/domain/format";
import { FilterSelect, PhoneFold } from "@/components/FilterControls";
import { Check, ChevronDown, ChevronRight, FilterX, Plus, Search, Upload } from "lucide-react";
import { CellEditor, GroupBand, GroupLegend, TableEmpty, TableFrame, Th, useConfirm, useRowMenu } from "@/components/DataTable";
import { parseSaved, savedString, useStoredFilters } from "@/components/useStoredFilters";
import {
  createMaterialLine, createLvOrderLines, updateMaterialLine, setActualPerUnit, setSheetsUsed, setProducedQty, setUtilization, deleteMaterialLine, importMaterialAction,
  updateMaterialGroup, deleteMaterialLines,
} from "@/app/material/actions";

// The MATERIAL tab — the planner's material sheet as one living table: no
// month, each row known by Odoo's MO (the one the ODOO tab's clerk types), so
// uploading the sheet again simply updates it. Older sheets filed under a plan
// month were cleared when the table started.
//
// The table is the sheet's row in the sheet's order — MO · BOM Ref · Quantity of
// Units · Part Code · Part Name · Codes · Material · Thickness · Sheet Size ·
// Sheets in BOM for one Unit · for Job · Actual Nesting for one Unit · for
// Job · Difference · Notes — plus two columns of the tab's own: units
// PRODUCED (typed) and the sheets those units really consumed (at the actual
// rate). Sheets-for-job, actual-per-unit and Difference are computed, never
// typed, so they can never disagree.

const cellInput = "font-semibold";

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

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(
    (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) => {
      startTransition(async () => {
        const res = await fn(fd);
        setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
        if (res.ok) { after?.(); router.refresh(); }
      });
    },
    [router]
  );
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

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

// ---- the line form: one strip, the sheet's columns in the sheet's order ----

const F = "px-2 py-1.5 text-sm font-semibold";

function Field({ hint, label, className = "", children }: { hint: string; label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`inline-flex flex-col gap-0.5 ${className}`} title={hint}>
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function LineFields({ line, knownBoms, knownCodes, disabled, product = "TR" }: { line?: MaterialLineView; knownBoms: string[]; knownCodes: string[]; disabled?: boolean; product?: ProductLine }) {
  // the part presets are the transformer's parts — a panel's are its own,
  // and until a panel nesting sheet names them the boxes offer nothing
  const lv = product === "LV";
  const presets = lv ? [] : PART_PRESETS;
  return (
    <>
      {/* a new line joins the table; an archived sheet's line keeps its month */}
      <input type="hidden" name="month" value={line?.month ?? ""} />
      <Field hint="MTR Request # — the material request the sheets were drawn on" label="MTR Request #" className="w-32">
        <input name="mtr" aria-label="MTR Request #" defaultValue={line?.mtr ?? ""} disabled={disabled} className={`${F} ltr w-full`} />
      </Field>
      <Field hint="SOI — as the sheet writes it" label="SOI" className="w-28">
        <input name="soi" aria-label="SOI" defaultValue={line?.soi ?? ""} disabled={disabled} placeholder="S01194-12" className={`${F} ltr w-full`} />
      </Field>
      <Field hint="Odoo's MO for this part — the ODOO tab finds the line by it" label="MO" className="w-40">
        <input name="mo" aria-label="MO" defaultValue={line?.mo ?? ""} disabled={disabled} placeholder="SF01/MO/20941" className={`${F} ltr w-full`} />
      </Field>
      <Field hint="BOM reference" label="BOM Ref" className="w-36">
        <input name="bom" list="material-boms" aria-label="BOM" defaultValue={line?.bom ?? ""} required disabled={disabled} placeholder="BOM" className={`${F} ltr w-full`} />
        <datalist id="material-boms">{knownBoms.map((b) => <option key={b} value={b} />)}</datalist>
      </Field>
      <Field hint="Quantity of Units — the job size on the sheet" label="Units" className="w-20">
        <input name="units" type="number" step="1" min="0" aria-label="Quantity of units" defaultValue={line?.units ?? ""} required disabled={disabled} placeholder="units" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Part Code — the part these sheets go into (FB-022 tank, FB-051 top cover …)" label="Part code" className="w-24">
        <input
          name="partCode" list="part-codes" aria-label="Part code" defaultValue={line?.partCode ?? ""} disabled={disabled} placeholder={lv ? "part code" : "FB-022"} className={`${F} ltr w-full`}
          onChange={(e) => {
            // a known code fills the name; a typed name is never overwritten
            const name = partNameFor(e.target.value);
            const el = e.target.form?.elements.namedItem("partName");
            if (name && el instanceof HTMLInputElement && (!el.value || partNameFor(el.dataset.from ?? "") === el.value)) { el.value = name; el.dataset.from = e.target.value; }
          }}
        />
        <datalist id="part-codes">{presets.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
      </Field>
      <Field hint="Part Name" label="Part name" className="w-28">
        <input name="partName" aria-label="Part name" defaultValue={line?.partName ?? ""} disabled={disabled} placeholder={lv ? "part name" : "TANK"} className={`${F} w-full`} />
      </Field>
      <Field hint="Codes — the material's code on the sheet (T-SSS-5MM)" label="Codes" className="w-28">
        <input name="materialCode" list="material-codes" aria-label="Material code" defaultValue={line?.materialCode ?? ""} disabled={disabled} placeholder={lv ? "material code" : "T-SSS-5MM"} className={`${F} ltr w-full`} />
        <datalist id="material-codes">{knownCodes.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field hint="Material type" label="Material" className="w-32">
        <input name="material" list="material-types" aria-label="Material" defaultValue={line?.material ?? ""} required disabled={disabled} placeholder="Steel" className={`${F} w-full`} />
        <datalist id="material-types">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <Field hint="Thickness in mm" label="Thickness" className="w-20">
        <input name="thicknessMm" type="number" step="0.1" min="0.1" aria-label="Thickness" defaultValue={line?.thicknessMm ?? ""} required disabled={disabled} placeholder="mm" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Sheet size" label="Sheet size" className="w-32">
        <input name="sheetSize" list="sheet-sizes" aria-label="Sheet size" defaultValue={line?.sheetSize ?? ""} required disabled={disabled} placeholder="1220*2440" className={`${F} ltr w-full`} />
        <datalist id="sheet-sizes">{SHEET_SIZE_PRESETS.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="Weight(Kg) — one sheet's" label="Weight (kg)" className="w-24">
        <input name="weightKg" type="number" step="0.01" min="0" aria-label="Weight (kg)" defaultValue={line?.weightKg ?? ""} disabled={disabled} placeholder="kg" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="No. of Sheets in BOM for ONE unit" label="BOM / unit" className="w-24">
        <input name="sheetsPerUnit" type="number" step="0.0001" min="0" aria-label="Sheets per unit" defaultValue={line?.sheetsPerUnit ?? ""} required disabled={disabled} placeholder="per unit" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="No. of Sheets in Actual Nesting for ONE unit — the sheet's own figure; type it for the lines it leaves blank" label="Actual / unit" className="w-24">
        <input name="actualPerUnit" type="number" step="0.0001" min="0" aria-label="Sheets actually nested for one unit" defaultValue={line?.actualPerUnit ?? ""} disabled={disabled} placeholder="per unit" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="No. of Sheets in Actual Nesting for the job — leave empty until nested" label="Actual / job" className="w-24">
        <input name="sheetsUsed" type="number" step="0.01" min="0" aria-label="Sheets actually nested" defaultValue={line?.sheetsUsed ?? ""} disabled={disabled} placeholder="actual" className={`${F} ltr tabnum w-full font-extrabold`} />
      </Field>
      <Field hint="Average utilization of the nesting" label="Utilization" className="w-24">
        <input name="utilization" type="number" step="0.0001" min="0" aria-label="Average utilization" defaultValue={line?.utilization ?? ""} disabled={disabled} placeholder="0.85" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Units produced so far — the tab works out the sheets they really consumed" label="Produced" className="w-24">
        <input name="producedQty" type="number" step="1" min="0" aria-label="Units produced" defaultValue={line?.producedQty ?? ""} disabled={disabled} placeholder="produced" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Notes" label="Notes" className="w-40">
        <input name="note" aria-label="Notes" defaultValue={line?.note ?? ""} disabled={disabled} placeholder="notes" className={`${F} w-full`} />
      </Field>
    </>
  );
}

/** Average utilization as the sheet writes it: a fraction reads as a percent. */
function Utilization({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className="tabnum ltr">{v <= 1 ? `${Number((v * 100).toFixed(1))}%` : Number(v.toFixed(2))}</span>;
}

// ---- one editable number cell (actual nested · units produced) ----

function CellInput({ id, field, value, action, title, bold, step = "0.01", className = "", placeholder = "—" }: {
  id: number; field: "actualPerUnit" | "sheetsUsed" | "producedQty" | "utilization"; value: number | null;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>; title: string; bold?: boolean;
  step?: string; className?: string; placeholder?: string;
}) {
  const a = useAction();
  function save(v: string) {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set(field, v);
    a.run(action, fd, "Saved.");
  }
  return (
    <span className="flex flex-col items-end">
      <CellEditor
        col={field} value={value === null ? "" : String(value)} onCommit={save} step={step} min="0" disabled={a.pending}
        placeholder={placeholder} title={title} className={`${cellInput} ${bold ? "font-extrabold" : ""} ${className}`.trim()}
      />
      {a.msg?.ok === false && <span className="text-[10px] text-bad-fg">{a.msg.text}</span>}
    </span>
  );
}

// ---- one row of the table ----

/** The MO cell: the sheet's MO and whether the ODOO tab carries it yet. */
function MoCell({ mo, odoo }: { mo: string; odoo: Record<string, string> }) {
  if (!mo) return <span className="text-muted">—</span>;
  const status = odoo[mo.trim().toUpperCase()];
  // one line: the MO, then where it stands on the ODOO tab as a compact badge
  return (
    // the badge gives way to the MO (cut to an ellipsis), and both stay inside the cell
    <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
      <span className="shrink-0" title={mo}>{mo}</span>
      {status
        ? <span className="pill pill-ok min-w-0" title={`On the ODOO tab — ${status}`}><Check size={10} className="shrink-0" aria-hidden /><span className="truncate">{status}</span></span>
        : <span className="pill pill-muted min-w-0" title="No ODOO row carries this MO yet"><span className="truncate">no ODOO</span></span>}
    </span>
  );
}

function LineRow({ line, knownBoms, knownCodes, canEdit, showMonth, product, odoo, inGroup }: {
  line: MaterialLineView; knownBoms: string[]; knownCodes: string[]; canEdit: boolean; showMonth: boolean; product: ProductLine; odoo: Record<string, string>;
  /** A line under an opened SOI's head — framed with it; "last" closes the frame. */
  inGroup?: "child" | "last";
}) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
  const [confirmDelete, confirmDialog] = useConfirm();
  const diffCls = line.difference === null ? "" : line.difference < 0 ? "text-bad-fg" : line.difference > 0 ? "text-ok-fg" : "text-muted";
  const lv = product === "LV";
  const cols = (lv ? 16 : 23) + (showMonth ? 1 : 0);
  const editor = (
    <>
      {del.msg?.ok === false && (
        <tr className="border-t-0"><td colSpan={cols} className="px-2 pb-3"><Msg msg={del.msg} /></td></tr>
      )}
      {editing && (
        <Modal title="Edit a material line" sub={`${line.mo || line.bom} · ${line.material} ${line.thicknessMm} mm ${line.sheetSize}`} onClose={() => setEditing(false)} busy={edit.pending} width="max-w-4xl">
          <form onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget); fd.set("id", String(line.id));
            edit.run(updateMaterialLine, fd, "Saved.", () => setEditing(false));
          }}>
            <div className="flex flex-wrap items-end gap-2">
              <LineFields line={line} knownBoms={knownBoms} knownCodes={knownCodes} disabled={edit.pending} product={product} />
            </div>
            <Msg msg={edit.msg} />
            <div className="flex justify-end gap-2 pt-3 mt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={edit.pending}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>{edit.pending ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
  const name = `${line.partCode ? `${line.partCode} ` : ""}${line.material} ${line.thicknessMm} mm ${line.sheetSize}`;
  const row = useRowMenu(() => [
    { heading: `${line.mo || line.bom} · ${line.material} ${line.thicknessMm} mm` },
    { key: "edit", label: "Edit line…", icon: "✏️", onSelect: () => setEditing(true) },
    { sep: true },
    {
      key: "delete", label: "Delete line…", icon: "🗑", danger: true, disabled: del.pending,
      onSelect: async () => {
        const ok = await confirmDelete({
          title: "Delete this material line?",
          body: <>This line leaves the table for good. Its sheets drop out of the totals below.</>,
          items: [`${line.mo || line.bom} · ${name}`],
          confirmLabel: "Delete line",
          danger: true,
        });
        if (!ok) return;
        const fd = new FormData(); fd.set("id", String(line.id));
        del.run(deleteMaterialLine, fd, "Deleted.");
      },
    },
  ], `Actions for ${line.mo || line.bom} ${line.material} ${line.thicknessMm} mm`);
  const actions = (
    <td className="px-1 text-center whitespace-nowrap no-print">
      {canEdit ? <>{row.button}{row.menu}{confirmDialog}</> : <span className="text-muted text-xs">—</span>}
    </td>
  );
  const rowMenuProps = canEdit ? { onContextMenu: row.onContextMenu } : {};
  if (lv) {
    // the panels' sheet: the order's head, then the thickness row, then what
    // the tracker produced and what that consumed
    const done = line.remainingUnits === 0 && line.units > 0;
    return (
      <>
        <tr className={`border-t ${done ? "bg-ok-bg/30" : ""}`} {...rowMenuProps}>
          <td className="p-2 font-bold whitespace-nowrap ltr text-xs"><MoCell mo={line.mo} odoo={odoo} /></td>
          <td className="p-2 text-center"><span className="pill pill-muted">{line.partName || "—"}</span></td>
          <td className="p-2 whitespace-nowrap ltr text-xs tabnum text-muted">{line.materialCode || "—"}</td>
          <td className="p-2 text-center tabnum font-bold">{line.units}</td>
          <td className="p-2 whitespace-nowrap ltr text-xs"><BomLink bom={line.bom} /></td>
          <td className="p-2 whitespace-nowrap">{line.material}</td>
          <td className="p-2 text-center tabnum ltr">{line.thicknessMm}</td>
          <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
          <td className="p-2 text-center"><Sheets v={line.sheetsPerUnit} digits={FIELD_DP.factor} /></td>
          <td className="p-2 text-center font-bold"><Sheets v={line.forJob} /></td>
          <td className="p-2 text-center">
            {canEdit ? (
              <CellInput id={line.id} field="actualPerUnit" value={line.actualPerUnit} action={setActualPerUnit} step="0.0001" className={`w-24 ${line.actualPerUnitManual ? "font-semibold" : "text-muted font-normal"}`} title="Sheets ONE unit really takes — blank means the BOM's figure" />
            ) : <Sheets v={line.actualPerUnit} digits={FIELD_DP.factor} />}
          </td>
          <td className="p-2 text-center bg-brand-light/30 whitespace-nowrap">
            {canEdit ? (
              <CellInput id={line.id} field="producedQty" value={line.producedQty} action={setProducedQty} placeholder={line.producedAuto === null ? "—" : String(line.producedAuto)} title={line.producedAuto === null ? "Units produced — type it" : `${line.producedAuto} painted on the tracker — type over it only to override`} />
            ) : <Units v={line.producedUsed} />}
            {line.producedQty === null && line.producedAuto !== null && <span className="block text-[10px] text-muted">tracker</span>}
          </td>
          <td className="p-2 text-center font-extrabold bg-brand-light/30" title={line.producedUsed === null ? "Nothing produced yet" : `${line.producedUsed} units × ${Number((line.actualPerUnit ?? line.sheetsPerUnit).toFixed(4))} sheets a unit`}>
            <Sheets v={line.forProduced ?? (line.producedUsed === null ? null : Number((line.sheetsPerUnit * line.producedUsed).toFixed(4)))} />
          </td>
          <td className={`p-2 text-center tabnum font-bold ${done ? "text-ok-fg" : ""}`}>{line.remainingUnits === null ? "—" : done ? "Done" : line.remainingUnits}</td>
          <td className="p-2 text-xs max-w-[200px]">{line.note}</td>
          {showMonth && <td className="p-2 whitespace-nowrap text-xs">{line.month || <span className="text-muted">—</span>}</td>}
          {actions}
        </tr>
        {editor}
      </>
    );
  }
  return (
    <>
      <tr {...rowMenuProps} className={inGroup ? `mat-child ${inGroup === "last" ? "mat-child-last" : ""}` : undefined}>
        <td className={`p-2 whitespace-nowrap ltr text-xs ${inGroup ? "ps-4" : ""} ${stickCls(0)}`} style={stickStyle(0)}><span className="block truncate" title={line.mtr || undefined}>{line.mtr || <span className="text-muted">—</span>}</span></td>
        <td className={`p-2 whitespace-nowrap ltr text-xs font-semibold ${stickCls(1)}`} style={stickStyle(1)}><span className="block truncate" title={line.soi || undefined}>{line.soi || <span className="text-muted">—</span>}</span></td>
        {/* the sheet files each part under Odoo's MO — the key an ODOO row finds it by */}
        <td className={`p-2 font-bold whitespace-nowrap ltr text-xs ${stickCls(2)}`} style={stickStyle(2)}><MoCell mo={line.mo} odoo={odoo} /></td>
        <td className="p-2 whitespace-nowrap ltr text-xs"><BomLink bom={line.bom} /></td>
        <td className={`p-2 ${NUM} tabnum ltr`}>{line.units}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs font-bold">{line.partCode || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap text-xs">{line.partName || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs">{line.materialCode || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap">{line.material}</td>
        <td className={`p-2 ${NUM} tabnum ltr`}>{line.thicknessMm}</td>
        <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
        <td className={`p-2 ${NUM} tabnum`}><Sheets v={line.weightKg} digits={3} /></td>
        <td className={`p-2 ${NUM}`}><Sheets v={line.sheetsPerUnit} digits={FIELD_DP.factor} /></td>
        {/* Actual / unit — the sheet's own figure where it carries one, and
            typed here for the lines it leaves blank (most of them). What is
            typed outranks the sheet: a re-import fills the blanks and leaves
            these standing. It is the rate everything below multiplies. */}
        <td className={`p-2 ${NUM}`}>
          {canEdit ? (
            <CellInput
              id={line.id} field="actualPerUnit" value={line.actualPerUnit} action={setActualPerUnit} step="0.0001"
              className={`w-24 ${line.actualPerUnitManual ? "font-semibold" : "text-muted font-normal"}`}
              title={line.actualPerUnitManual
                ? "Sheets for ONE unit — typed here, so a re-import will not change it. Clear the box to hand it back to the sheet."
                : "Sheets for ONE unit, as the nesting sheet writes it. Type over it and it becomes yours — the import stops touching it."}
            />
          ) : (
            <span className={line.actualPerUnitManual ? "font-semibold" : "text-muted"} title={line.actualPerUnitManual ? "Typed in this tab" : "From the nesting sheet"}>
              <Sheets v={line.actualPerUnit} digits={FIELD_DP.factor} />
            </span>
          )}
        </td>
        <td className={`p-2 ${NUM} emph`}><Sheets v={line.forJob} /></td>
        <td className={`p-2 ${NUM} emph`}>
          {canEdit ? <CellInput id={line.id} field="sheetsUsed" value={line.sheetsUsed} action={setSheetsUsed} title="No. of Pieces in Actual Nesting for the job" bold /> : <Sheets v={line.sheetsUsed} className="font-bold" />}
        </td>
        <td className={`p-2 ${NUM}`}>
          {canEdit ? <CellInput id={line.id} field="utilization" value={line.utilization} action={setUtilization} step="0.0001" title="Average utilization of the nesting — as the sheet writes it (0.85 or 85)" /> : <Utilization v={line.utilization} />}
        </td>
        <td className={`p-2 ${NUM} emph tabnum`} title={line.actualWeightKg === null ? "Needs the pieces nested for the job and the weight" : `${line.sheetsUsed} × ${line.weightKg} kg`}><Sheets v={line.actualWeightKg} digits={3} /></td>
        <td className={`p-2 ${NUM} emph ${diffCls}`}><Sheets v={line.difference} /></td>
        <td className="p-2 text-xs min-w-[8rem] max-w-[200px]">{line.note}</td>
        <td className={`p-2 ${NUM}`}>
          {canEdit ? <CellInput id={line.id} field="producedQty" value={line.producedQty} action={setProducedQty} title="The quantity to cost — the tab multiplies the actual rate by it" /> : <Units v={line.producedQty} />}
        </td>
        <td className={`p-2 ${NUM} font-semibold`} title={line.actualPerUnit === null ? "No rate yet — type one under Actual Nesting for one Unit, or nest the job" : `${Number(line.actualPerUnit.toFixed(4))} sheets a unit × the quantity beside it`}>
          <Sheets v={line.forProduced} />
        </td>
        {showMonth && <td className="p-2 whitespace-nowrap text-xs">{line.month || <span className="text-muted">—</span>}</td>}
        {actions}
      </tr>
      {editor}
    </>
  );
}

// ---- the SOI groups and the totals row ----

/** The sticky identifier block (MTR · SOI · MO) as one cell, for the rows
 *  that span it: a group's head, the totals. */
const STICK_ALL = { "--stick-left": "0rem", "--stick-w": "29.25rem" } as React.CSSProperties;

type Sums = Pick<MaterialSoiGroup, "forJob" | "sheetsUsed" | "actualWeightKg" | "difference" | "forProduced">;

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
      <td />
      <td className={`p-2 ${NUM}`}><Sheets v={s.forProduced} /></td>
      {showMonth && <td />}
      <td className="no-print" />
    </>
  );
}

/** What every line of a group agrees on — or null where they differ. */
function sharedOf<T>(values: T[]): T | null {
  return values.every((v) => v === values[0]) ? values[0] : null;
}
const asText = (v: string | number | null) => (v === null ? "" : String(v));

/** One cell of a group's head row, typed like a line's cell — what is typed
 *  lands on EVERY line of the group. Where the lines differ the box is empty
 *  and says so; leaving it empty changes nothing. */
function GroupInput({ ids, field, values, title, type = "number", step = "0.01", className = "" }: {
  ids: number[]; field: "mtr" | "soi" | "mo" | "bom" | "units" | "utilization" | "producedQty";
  values: (string | number | null)[]; title: string; type?: "number" | "text"; step?: string; className?: string;
}) {
  const a = useAction();
  const shared = sharedOf(values.map(asText));
  const distinct = new Set(values.map(asText)).size;
  function save(v: string) {
    const fd = new FormData();
    fd.set("ids", ids.join(","));
    fd.set(field, v);
    a.run(updateMaterialGroup, fd, "Saved.");
  }
  return (
    <span className="flex flex-col items-end">
      <CellEditor
        col={`group-${field}`} type={type} value={shared ?? ""} onCommit={save} step={type === "number" ? step : undefined} min={type === "number" ? "0" : undefined}
        disabled={a.pending} placeholder={shared === null ? "mixed" : "—"}
        title={`${title} — typing it here sets it on all ${ids.length} lines${shared === null ? ` (they hold ${distinct} different values now)` : ""}`}
        ariaLabel={`${title} for all ${ids.length} lines`}
        className={`${cellInput} ${type === "text" ? "ltr text-xs" : ""} ${className}`.trim()}
      />
      {a.msg?.ok === false && <span className="text-[10px] text-bad-fg whitespace-normal">{a.msg.text}</span>}
    </span>
  );
}

/** The fields a group's "Edit all lines" form offers: the order's, which every
 *  line carries alike. The per-material figures stay on each line. */
const GROUP_FORM: { name: "mtr" | "soi" | "mo" | "bom" | "units" | "utilization" | "producedQty" | "note"; label: string; num?: boolean; step?: string; className: string }[] = [
  { name: "mtr", label: "MTR Request #", className: "w-32" },
  { name: "soi", label: "SOI", className: "w-28" },
  { name: "mo", label: "MO", className: "w-40" },
  { name: "bom", label: "BOM Ref", className: "w-36" },
  { name: "units", label: "Units", num: true, step: "1", className: "w-20" },
  { name: "utilization", label: "Utilization", num: true, step: "0.0001", className: "w-24" },
  { name: "producedQty", label: "Quantity", num: true, step: "1", className: "w-24" },
  { name: "note", label: "Notes", className: "w-48" },
];

function SoiGroupRow({ g, open, onToggle, odoo, showMonth, canEdit }: { g: MaterialSoiGroup; open: boolean; onToggle: () => void; odoo: Record<string, string>; showMonth: boolean; canEdit: boolean }) {
  const onOdoo = g.mos.filter((mo) => odoo[mo.toUpperCase()]);
  const shownMos = g.mos.slice(0, 4);
  const ids = g.lines.map((l) => l.id);
  const n = ids.length;
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
  const [confirmDelete, confirmDialog] = useConfirm();
  const initial = Object.fromEntries(GROUP_FORM.map((f) => [f.name, sharedOf(g.lines.map((l) => asText(l[f.name])))])) as Record<string, string | null>;
  const label = g.soi || "No SOI";
  const row = useRowMenu(() => [
    { heading: `${label} · ${n} lines` },
    { key: "edit", label: `Edit all ${n} lines…`, icon: "✏️", onSelect: () => setEditing(true) },
    { key: "fold", label: open ? "Fold the lines" : "Show the lines", icon: open ? "▴" : "▾", onSelect: onToggle },
    ...(g.lines[0]?.bom ? [{ key: "trace", label: "Open the order's details", icon: "🔍", href: `/trace?bom=${encodeURIComponent(g.lines[0].bom)}` }] : []),
    { sep: true },
    {
      key: "delete", label: `Delete all ${n} lines…`, icon: "🗑", danger: true, disabled: del.pending,
      onSelect: async () => {
        const ok = await confirmDelete({
          title: `Delete the ${n} lines of ${label}?`,
          body: <>Every line of this SOI leaves the table for good. Their sheets drop out of the totals below.</>,
          items: g.lines.map((l) => `${l.mo || l.bom} · ${l.partCode ? `${l.partCode} ` : ""}${l.material} ${l.thicknessMm} mm ${l.sheetSize}`),
          confirmLabel: `Delete ${n} lines`,
          danger: true,
        });
        if (!ok) return;
        const fd = new FormData(); fd.set("ids", ids.join(","));
        del.run(deleteMaterialLines, fd, "Deleted.");
      },
    },
  ], `Actions for ${label}`);
  const s: Sums = g;
  const diffCls = s.difference === null ? "" : s.difference < 0 ? "text-bad-fg" : s.difference > 0 ? "text-ok-fg" : "text-muted";
  const sharedMo = sharedOf(g.lines.map((l) => l.mo.trim()));
  const sharedBom = sharedOf(g.lines.map((l) => l.bom));
  const sharedNote = sharedOf(g.lines.map((l) => l.note ?? ""));
  const sharedMonth = sharedOf(g.lines.map((l) => l.month));
  return (
    <>
      <tr className={`mat-group ${open ? "is-open" : ""}`} {...(canEdit ? { onContextMenu: row.onContextMenu } : {})}>
        <td className={`p-2 ltr text-xs ${stickCls(0)}`} style={stickStyle(0)}>
          <span className="flex items-center gap-1">
            <button type="button" onClick={onToggle} aria-expanded={open} className="icon-btn !inline-flex items-center !w-auto !h-auto px-0.5 py-0.5 gap-0.5 shrink-0 font-bold tabnum text-foreground" title={open ? `Fold this SOI's ${n} lines` : `Show this SOI's ${n} lines`} aria-label={open ? `Fold the ${n} lines of ${label}` : `Show the ${n} lines of ${label}`}>
              <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />{n}
            </button>
            {canEdit ? <GroupInput ids={ids} field="mtr" type="text" values={g.lines.map((l) => l.mtr)} title="MTR Request #" className="w-full" />
              : <span className="block truncate">{sharedOf(g.lines.map((l) => l.mtr)) || <span className="text-muted">—</span>}</span>}
          </span>
        </td>
        <td className={`p-2 ltr text-xs font-bold ${stickCls(1)}`} style={stickStyle(1)}>
          {canEdit ? <GroupInput ids={ids} field="soi" type="text" values={g.lines.map((l) => l.soi)} title="SOI" className="w-full font-bold" />
            : <span className="block truncate">{g.soi || <span className="text-muted font-semibold">No SOI</span>}</span>}
        </td>
        <td className={`p-2 font-bold whitespace-nowrap ltr text-xs ${stickCls(2)}`} style={stickStyle(2)}>
          {sharedMo !== null ? (
            canEdit ? (
              <span className="flex items-center gap-1.5 min-w-0">
                <GroupInput ids={ids} field="mo" type="text" values={g.lines.map((l) => l.mo.trim())} title="MO" className="w-28" />
                {sharedMo && (odoo[sharedMo.toUpperCase()]
                  ? <span className="pill pill-ok shrink-0" title={`On the ODOO tab — ${odoo[sharedMo.toUpperCase()]}`}><Check size={10} aria-hidden /></span>
                  : <span className="pill pill-muted shrink-0" title="No ODOO row carries this MO yet">no ODOO</span>)}
              </span>
            ) : <MoCell mo={sharedMo} odoo={odoo} />
          ) : (
            <span className="flex items-center gap-1.5">
              {g.mos.length} MOs
              <span
                className={`pill ${onOdoo.length === g.mos.length ? "pill-ok" : onOdoo.length ? "pill-warn" : "pill-muted"}`}
                title={onOdoo.length ? `On the ODOO tab: ${onOdoo.join(", ")}` : "No ODOO row carries these MOs yet"}
              >
                {onOdoo.length > 0 && <Check size={10} aria-hidden />}ODOO {onOdoo.length}/{g.mos.length}
              </span>
            </span>
          )}
        </td>
        <td className="p-2 whitespace-nowrap ltr text-xs">
          {sharedBom !== null
            ? (canEdit ? <GroupInput ids={ids} field="bom" type="text" values={g.lines.map((l) => l.bom)} title="BOM Ref" className="w-32" /> : <BomLink bom={sharedBom} />)
            : <span className="text-muted" title={[...new Set(g.lines.map((l) => l.bom))].join(", ")}>{new Set(g.lines.map((l) => l.bom)).size} BOMs</span>}
        </td>
        <td className={`p-2 ${NUM}`}>
          {canEdit ? <GroupInput ids={ids} field="units" step="1" values={g.lines.map((l) => l.units)} title="Quantity of units" className="w-16" />
            : <Units v={sharedOf(g.lines.map((l) => l.units))} />}
        </td>
        <td className="p-2" colSpan={9}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs ltr">
            <span className="font-semibold text-muted tabnum">{n} line{n === 1 ? "" : "s"}</span>
            {g.mos.length > 1 && shownMos.map((mo) => (
              <span key={mo} className="inline-flex items-center gap-1 text-muted">
                {mo}{odoo[mo.toUpperCase()] && <Check size={11} className="text-ok-fg" aria-label="on the ODOO tab" />}
              </span>
            ))}
            {g.mos.length > shownMos.length && <span className="text-muted" title={g.mos.slice(4).join(", ")}>+{g.mos.length - shownMos.length} more</span>}
            {edit.msg?.ok === false && <span className="text-bad-fg">{edit.msg.text}</span>}
            {del.msg?.ok === false && <span className="text-bad-fg">{del.msg.text}</span>}
          </span>
        </td>
        <td className={`p-2 ${NUM} emph`}><Sheets v={s.forJob} /></td>
        <td className={`p-2 ${NUM} emph`} title="The lines' pieces nested for the job, added up — type each line's below"><Sheets v={s.sheetsUsed} /></td>
        <td className={`p-2 ${NUM}`}>
          {canEdit ? <GroupInput ids={ids} field="utilization" step="0.0001" values={g.lines.map((l) => l.utilization)} title="Average utilization" className="w-20" />
            : <Utilization v={sharedOf(g.lines.map((l) => l.utilization))} />}
        </td>
        <td className={`p-2 ${NUM} emph`}><Sheets v={s.actualWeightKg} digits={3} /></td>
        <td className={`p-2 ${NUM} emph ${diffCls}`}><Sheets v={s.difference} /></td>
        <td className="p-2 text-xs min-w-[8rem] max-w-[200px]">{sharedNote ?? <span className="text-muted">…</span>}</td>
        <td className={`p-2 ${NUM}`}>
          {canEdit ? <GroupInput ids={ids} field="producedQty" step="1" values={g.lines.map((l) => l.producedQty)} title="The quantity to cost" className="w-16" />
            : <Units v={sharedOf(g.lines.map((l) => l.producedQty))} />}
        </td>
        <td className={`p-2 ${NUM} font-semibold`}><Sheets v={s.forProduced} /></td>
        {showMonth && <td className="p-2 whitespace-nowrap text-xs">{sharedMonth ?? <span className="text-muted">…</span>}</td>}
        <td className="px-1 text-center whitespace-nowrap no-print">
          {canEdit ? <>{row.button}{row.menu}{confirmDialog}</> : <span className="text-muted text-xs">—</span>}
        </td>
      </tr>
      {editing && (
        <Modal title={`Edit all ${n} lines of ${label}`} sub="What you change here lands on every line of the SOI; a box left as it is changes nothing" onClose={() => setEditing(false)} busy={edit.pending} width="max-w-3xl">
          <form onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const fd = new FormData(); fd.set("ids", ids.join(","));
            for (const f of GROUP_FORM) {
              const v = String(form.get(f.name) ?? "").trim();
              const was = initial[f.name];
              // a field the lines differ on changes only when something is typed
              if (was === null ? v !== "" : v !== was.trim()) fd.set(f.name, v);
            }
            edit.run(updateMaterialGroup, fd, "Saved.", () => setEditing(false));
          }}>
            <div className="flex flex-wrap items-end gap-2">
              {GROUP_FORM.map((f) => (
                <Field key={f.name} label={f.label} hint={initial[f.name] === null ? `${f.label} — the lines differ; type one to set it on all of them` : `${f.label} — the same on every line`} className={f.className}>
                  <input
                    name={f.name} type={f.num ? "number" : "text"} step={f.step} min={f.num ? "0" : undefined} aria-label={f.label}
                    defaultValue={initial[f.name] ?? ""} placeholder={initial[f.name] === null ? "differs — keep" : ""} disabled={edit.pending}
                    className={`${F} ${f.num ? "ltr tabnum" : f.name === "note" ? "" : "ltr"} w-full`}
                  />
                </Field>
              ))}
            </div>
            <Msg msg={edit.msg} />
            <div className="flex justify-end gap-2 pt-3 mt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={edit.pending}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>{edit.pending ? "Saving…" : `Save ${n} lines`}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// ---- add ----

// A BOM is never one line: the sheet runs five to seven thicknesses under the
// same BOM, units and sheet size. A successful add clears only what changes
// from line to line and returns the cursor to the material.
const PER_LINE = ["partCode", "partName", "material", "thicknessMm", "sheetsPerUnit", "actualPerUnit", "sheetsUsed", "producedQty", "note"] as const;

function AddLine({ knownBoms, knownCodes, product }: { knownBoms: string[]; knownCodes: string[]; product: ProductLine }) {
  const add = useAction();
  const [open, setOpen] = useState(false);
  function clearForNext(form: HTMLFormElement) {
    for (const n of PER_LINE) { const el = form.elements.namedItem(n); if (el instanceof HTMLInputElement) el.value = ""; }
    const first = form.elements.namedItem("partCode"); if (first instanceof HTMLInputElement) first.focus();
  }
  return (
    <>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}><Plus size={14} aria-hidden />Add Material Line</button>
      {open && (
        <Modal title="➕ Add a material line" sub="Joins the table. After Add, the MO and BOM stay for the next line." onClose={() => setOpen(false)} busy={add.pending} width="max-w-4xl">
          <form onSubmit={(e) => {
            e.preventDefault(); const form = e.currentTarget;
            add.run(createMaterialLine, new FormData(form), "Added — next line.", () => clearForNext(form));
          }}>
            <div className="flex flex-wrap items-end gap-2">
              <LineFields knownBoms={knownBoms} knownCodes={knownCodes} disabled={add.pending} product={product} />
            </div>
            <Msg msg={add.msg} />
            <div className="flex justify-end gap-2 pt-3 mt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={add.pending}>Close</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>{add.pending ? "Adding…" : "Add"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// ---- LV: an order's material in one go ----

type LvRowDraft = { material: string; thicknessMm: string; sheetSize: string; sheetsPerUnit: string };
const LV_DEFAULT_ROWS: LvRowDraft[] = ["1.5", "2", "3"].map((t) => ({ material: "Galvanized steel", thicknessMm: t, sheetSize: "1220*2440", sheetsPerUnit: "" }));

function AddLvOrder({ orders, templates }: { orders: LvOrderRef[]; templates: MaterialPageData["lvTemplates"] }) {
  const add = useAction();
  const [open, setOpen] = useState(false);
  const [mo, setMo] = useState("");
  const [rows, setRows] = useState<LvRowDraft[]>(LV_DEFAULT_ROWS);
  const order = orders.find((o) => o.mo === mo) ?? null;
  const pick = (v: string) => {
    setMo(v);
    const o = orders.find((x) => x.mo === v);
    const t = o ? templates[o.bom] : undefined;
    // the BOM's rows from another order, when there are any; else three blank thicknesses
    setRows(t && t.length ? t.map((r) => ({ material: r.material, thicknessMm: String(r.thicknessMm), sheetSize: r.sheetSize, sheetsPerUnit: String(r.sheetsPerUnit) })) : LV_DEFAULT_ROWS);
  };
  const setRow = (i: number, patch: Partial<LvRowDraft>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const button = <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>➕ Add an order&apos;s material</button>;
  if (!open) return button;
  const fromTemplate = order && templates[order.bom]?.length;
  return (
    <>
    {button}
    <Modal title="➕ Add an order's material" sub="One row per thickness — the BOM and the planned qty come from the order." onClose={() => setOpen(false)} busy={add.pending} width="max-w-4xl">
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      fd.set("rows", JSON.stringify(rows));
      add.run(createLvOrderLines, fd, "Added — the order's rows are on the tab.", () => { setMo(""); setRows(LV_DEFAULT_ROWS); });
    }}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-[22rem]">
          <span className="text-xs font-bold text-muted">Panel order</span>
          <select name="mo" value={mo} onChange={(e) => pick(e.target.value)} required className={`${F} ltr block w-full`}>
            <option value="">Pick the MO…</option>
            {orders.map((o) => <option key={o.mo} value={o.mo}>{o.mo} · {o.product ?? "?"} · {o.secItem ?? "—"} · {o.planQty} pcs · {o.bom}</option>)}
          </select>
        </label>
        {order && (
          <span className="text-xs text-muted pb-2">
            BOM <b className="ltr text-foreground">{order.bom}</b> · planned <b className="text-foreground tabnum">{order.planQty}</b> · painted so far <b className="text-foreground tabnum">{order.painted}</b>
            {fromTemplate ? <> · rows from this BOM&apos;s earlier order — check the figures</> : <> · no earlier order on this BOM — type the sheets per unit</>}
          </span>
        )}
      </div>
      <table className="text-sm border-collapse">
        <thead><tr className="text-left text-xs text-muted"><th className="p-1">Material</th><th className="p-1">Thickness (mm)</th><th className="p-1">Sheet size</th><th className="p-1">Sheets per unit (BOM)</th><th className="p-1">Sheets for the order</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const per = Number(r.sheetsPerUnit); const job = order && Number.isFinite(per) && r.sheetsPerUnit !== "" ? Number((per * order.planQty).toFixed(4)) : null;
            return (
              <tr key={i}>
                <td className="p-1"><input value={r.material} onChange={(e) => setRow(i, { material: e.target.value })} list="material-types" aria-label="Material" className={`${F} w-48`} /></td>
                <td className="p-1"><input value={r.thicknessMm} onChange={(e) => setRow(i, { thicknessMm: e.target.value })} type="number" step="0.1" min="0.1" aria-label="Thickness" className={`${F} ltr tabnum w-24`} /></td>
                <td className="p-1"><input value={r.sheetSize} onChange={(e) => setRow(i, { sheetSize: e.target.value })} list="sheet-sizes" aria-label="Sheet size" className={`${F} ltr w-32`} /></td>
                <td className="p-1"><input value={r.sheetsPerUnit} onChange={(e) => setRow(i, { sheetsPerUnit: e.target.value })} type="number" step="0.0001" min="0" aria-label="Sheets per unit" placeholder="per unit" className={`${F} ltr tabnum w-28 font-extrabold`} /></td>
                <td className="p-1 tabnum text-muted">{job === null ? "—" : job}</td>
                <td className="p-1"><button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} title="Remove this row">✕</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="material-types">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
      <datalist id="sheet-sizes">{SHEET_SIZE_PRESETS.map((sz) => <option key={sz} value={sz} />)}</datalist>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { material: "Galvanized steel", thicknessMm: "", sheetSize: "1220*2440", sheetsPerUnit: "" }])}>+ thickness</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending || !order}>Add the order</button>
        <Msg msg={add.msg} />
      </div>
      <p className="text-xs text-muted">Produced units and the sheets they consumed follow the tracker on their own: every panel painted on this MO counts, at the sheets-per-unit above.</p>
    </form>
    </Modal>
    </>
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
  // picking the file IS the upload — no dialog, no preview; `prune` says
  // whether rows no longer in the file leave the table (off unless asked)
  const picker = useRef<HTMLInputElement>(null);
  const prune = useRef(false);
  function pick(withPrune: boolean) {
    prune.current = withPrune;
    setMenu(false);
    picker.current?.click();
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
    : "Reads the sheet by its headers, each row matched on its MO (with the BOM, part, material, thickness and size). Uploading again adds the new rows and updates the changed ones — never doubles them — and leaves your “Quantity” as typed.";
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
          <button type="button" className="w-full text-start rounded-md px-2 py-1.5 hover:bg-surface-2" onClick={() => pick(true)}>
            Upload and remove the rows no longer in the file
            <span className="block text-xs text-muted">Lines typed in the tab stay.</span>
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
    </span>
  );
}


// ---- totals ----

function TotalsTable({ totals, lv = false }: { totals: MaterialTotal[]; lv?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="erp-table w-full border-collapse">
        <thead>
          <tr className="text-left">
            <th className="p-2">Material</th><th className="p-2 text-center">Thk (mm)</th><th className="p-2 text-center">Sheet size</th>
            <th className="p-2 text-center" title="Sheets the BOMs call for">Sheets for job</th>
            <th className="p-2 text-center" title={lv ? "Sheets actually consumed" : "Sheets actually nested"}>{lv ? "Actual consumed" : "Actual nested"}</th>
            <th className="p-2 text-center" title="Sheets the entered quantities really take, at each line's actual rate">Actual for quantity</th>
            <th className="p-2 text-center">{lv ? "Nothing consumed yet" : "Not nested yet"}</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={`${t.material}|${t.thicknessMm}|${t.sheetSize}`} className="border-t">
              <td className="p-2 font-semibold">{t.material}</td>
              <td className="p-2 text-center tabnum ltr">{t.thicknessMm}</td>
              <td className="p-2 text-center tabnum ltr">{t.sheetSize}</td>
              <td className="p-2 text-center"><Sheets v={t.forJob} /></td>
              <td className="p-2 text-center font-bold"><Sheets v={t.used} /></td>
              <td className="p-2 text-center font-extrabold"><Sheets v={t.forProduced} /></td>
              <td className="p-2 text-center text-xs text-muted">{t.linesNotNested > 0 ? `${t.linesNotNested} line(s)` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function FilterBar({ lines, filters, onChange, shown, extra }: { lines: MaterialLineView[]; filters: MaterialFilters; onChange: (f: MaterialFilters) => void; shown: number; extra?: React.ReactNode }) {
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
        options={(Object.keys(MATERIAL_STATUS_FILTERS) as MaterialStatusFilter[]).filter((k) => k !== "all").map((k) => ({ value: k, label: MATERIAL_STATUS_FILTERS[k] }))}
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

export function MaterialClient({ lines, totals, month, knownBoms, canEdit, product = "TR", lvOrders = [], lvTemplates = {}, odooByMo = {}, exportButton }: {
  lines: MaterialLineView[]; totals: MaterialTotal[]; month: string; knownBoms: string[]; canEdit: boolean;
  /** The page's Export Excel, set in the action toolbar beside upload and add. */
  exportButton?: React.ReactNode;
  /** MO (upper case) → its status on the ODOO tab. */
  odooByMo?: Record<string, string>;
  /** Which product line's nesting this is — the transformer part presets are only offered on theirs. */
  product?: ProductLine;
  /** LV only: the panel orders the add form offers, and each BOM's rows so far. */
  lvOrders?: LvOrderRef[];
  lvTemplates?: MaterialPageData["lvTemplates"];
}) {
  const showMonth = month === "all";
  const lv = product === "LV";
  const knownCodes = [...new Set(lines.map((l) => l.materialCode).filter(Boolean))].sort();
  const { filters, setFilters: changeFilters } = useStoredFilters(FILTERS_KEY, readSavedFilters, EMPTY_MATERIAL_FILTERS);
  const shown = useMemo(() => filterMaterialLines(lines, filters), [lines, filters]);
  const filtering = shown.length !== lines.length;
  // the totals follow the filter, so "Stainless steel 5 mm, tanks only" adds up on its own
  const shownTotals = filtering ? summarizeMaterial(shown) : totals;
  // the transformers' sheet reads by SOI, its MOs under it; the switch puts
  // the plain sheet order back. A folded SOI stays folded while the page is open.
  const [bySoi, setBySoi] = useState(true);
  const soiGroups = useMemo(() => groupMaterialBySoi(shown), [shown]);
  const shownSums = useMemo(() => {
    const all = groupMaterialBySoi(shown.map((l) => ({ ...l, soi: "" })))[0];
    return all ?? { forJob: 0, sheetsUsed: null, actualWeightKg: null, difference: null, forProduced: null };
  }, [shown]);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggleFold = (soi: string) => setFolded((f) => { const n = new Set(f); if (n.has(soi)) n.delete(soi); else n.add(soi); return n; });
  return (
    <div className="space-y-4">
      <div className="toolbar !mb-0">
        {(canEdit || exportButton) && (
          <div className="toolbar-row no-print">
            {canEdit && (
              <>
                <ImportPanel product={product} />
                {lv ? <AddLvOrder orders={lvOrders} templates={lvTemplates} /> : <AddLine knownBoms={knownBoms} knownCodes={knownCodes} product={product} />}
              </>
            )}
            {exportButton}
          </div>
        )}
        {lines.length > 0 && (
          <FilterBar
            lines={lines} filters={filters} onChange={changeFilters} shown={shown.length}
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
            hint={lv ? "Upload the Consumption Details sheet, or add an order." : "Upload the material sheet, or add a line."}
            action={canEdit ? <><ImportPanel product={product} />{lv ? <AddLvOrder orders={lvOrders} templates={lvTemplates} /> : <AddLine knownBoms={knownBoms} knownCodes={knownCodes} product={product} />}</> : undefined}
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
                    does. Then the two this tab adds — the quantity he types and
                    what it really costs — and last the app's own identity
                    columns, which the sheet has never carried. */}
                {lv ? (
                  <>
                  <GroupBand spans={[
                    { span: 9, group: "source", label: <GroupLegend /> },
                    { span: 1, group: "computed" },
                    { span: 2, group: "input" },
                    { span: 2, group: "computed" },
                    { span: 1 + (showMonth ? 1 : 0) + 1 },
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
                    <Th label="Actual / unit" unit="sheets" full="Actual per Unit" hint="Sheets one unit really takes — blank means the BOM's figure" group="input" num />
                    <Th label="Produced" unit="pcs" hint="Panels painted on the tracker; type here only to override" group="input" num />
                    <Th label="Consumed" unit="sheets" full="Actually Consumed" hint="Sheets the produced panels consumed — per unit × produced" group="computed" num />
                    <Th label="Remaining" unit="pcs" full="Remaining units" group="computed" num />
                    <Th label="Remarks" group="source" />
                    {showMonth && <Th label="Month" />}
                    <th className="p-2 no-print"><span className="sr-only">Actions</span></th>
                  </tr>
                  </>
                ) : (
                <>
                <GroupBand spans={[
                  { span: 3, label: <GroupLegend />, className: "stick stick-end", style: { "--stick-left": "0rem", "--stick-w": "29.25rem" } as React.CSSProperties },
                  { span: 10, group: "source" },
                  { span: 1, group: "input" },
                  { span: 1, group: "computed" },
                  { span: 2, group: "input" },
                  { span: 2, group: "computed" },
                  { span: 1, group: "source" },
                  { span: 1, group: "input" },
                  { span: 1, group: "computed" },
                  { span: (showMonth ? 1 : 0) + 1 },
                ]} />
                <tr className="text-left align-bottom">
                  <Th label="MTR #" full="MTR Request #" hint="The material request the sheets were drawn on" group="source" className={stickCls(0)} style={stickStyle(0)} />
                  <Th label="SOI" group="source" className={stickCls(1)} style={stickStyle(1)} />
                  <Th label="MO" hint="Odoo's MO for the part — the ODOO tab finds the line by it" group="source" className={stickCls(2)} style={stickStyle(2)} />
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
                  <Th label="Actual / unit" full="No. of Pieces in Actual Nesting for one Unit" hint="From the sheet, or typed here for the lines it leaves blank" group="input" num />
                  <Th label="BOM for job" full="BOM Pieces for Job" hint="BOM Qty for one Unit × units" group="computed" num className="emph" />
                  <Th label="Actual for job" full="No. of Pieces in Actual Nesting for Job" hint="Type here" group="input" num className="emph" />
                  <Th label="Utilization" full="Average Utilization" hint="As the sheet writes it — 0.85 or 85" group="input" num />
                  <Th label="Actual weight" unit="kg" full="Actual Weight (Kg)" hint="Pieces in Actual Nesting for Job × Weight(Kg)" group="computed" num className="emph" />
                  <Th label="Difference" hint="BOM Pieces for Job − Actual Nesting for Job. Red = ate more than the BOM allows" group="computed" num className="emph" />
                  <Th label="Notes" group="source" />
                  <Th label="Quantity" hint="Type the quantity you want costed — it does not have to be the whole job" group="input" num />
                  <Th label="Actual for qty" full="Actual for Quantity" hint="Actual Nesting for one Unit × the quantity beside it" group="computed" num />
                  {showMonth && <Th label="Month" />}
                  <th className="p-2 no-print"><span className="sr-only">Actions</span></th>
                </tr>
                </>
                )}
              </thead>
              <tbody>
                {lv || !bySoi
                  ? shown.map((l) => <LineRow key={l.id} line={l} knownBoms={knownBoms} knownCodes={knownCodes} canEdit={canEdit} showMonth={showMonth} product={product} odoo={odooByMo} />)
                  : soiGroups.map((g) => (
                    // a SOI of one line needs no head: the line is the row
                    g.lines.length === 1 ? <LineRow key={g.lines[0].id} line={g.lines[0]} knownBoms={knownBoms} knownCodes={knownCodes} canEdit={canEdit} showMonth={showMonth} product={product} odoo={odooByMo} /> : (
                    <Fragment key={`soi-${g.soi}`}>
                      <SoiGroupRow g={g} open={!folded.has(g.soi)} onToggle={() => toggleFold(g.soi)} odoo={odooByMo} showMonth={showMonth} canEdit={canEdit} />
                      {!folded.has(g.soi) && g.lines.map((l, i) => <LineRow key={l.id} line={l} knownBoms={knownBoms} knownCodes={knownCodes} canEdit={canEdit} showMonth={showMonth} product={product} odoo={odooByMo} inGroup={i === g.lines.length - 1 ? "last" : "child"} />)}
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
                    <td colSpan={11} />
                    <SumCells s={shownSums} showMonth={showMonth} />
                  </tr>
                </tfoot>
              )}
            </table>
          </TableFrame>
        )}
      </section>
      {shownTotals.length > 0 && (
        <section>
          <h2 className="font-bold mb-2">
            Totals {showMonth ? "across everything" : month ? `for ${month}` : ""} — per material, thickness and size
            {filtering && <span className="text-sm font-normal text-muted"> · filtered lines only</span>}
          </h2>
          <div className="bg-surface border rounded-xl overflow-hidden"><TotalsTable totals={shownTotals} lv={lv} /></div>
        </section>
      )}
    </div>
  );
}

/** A line's BOM, opening its order's page (the trace: pipeline, orders, log). */
function BomLink({ bom }: { bom: string }) {
  if (!bom) return <span className="text-muted">—</span>;
  return <Link href={`/trace?bom=${encodeURIComponent(bom)}`} className="text-accent hover:underline" title="Open the order's details">{bom}</Link>;
}
