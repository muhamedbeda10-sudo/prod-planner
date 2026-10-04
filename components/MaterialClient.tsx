"use client";

import type { ProductLine } from "@/lib/domain/lines";
import type { LvOrderRef, MaterialPageData } from "@/lib/server/material";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  MATERIAL_PRESETS, PART_PRESETS, SHEET_SIZE_PRESETS, MATERIAL_STATUS_FILTERS, EMPTY_MATERIAL_FILTERS,
  partNameFor, filterMaterialLines, summarizeMaterial,
  type MaterialLineView, type MaterialTotal, type MaterialFilters, type MaterialStatusFilter,
} from "@/lib/domain/material";
import { Modal } from "@/components/Modal";
import { parseSaved, savedString, useStoredFilters } from "@/components/useStoredFilters";
import {
  createMaterialLine, createLvOrderLines, updateMaterialLine, setActualPerUnit, setSheetsUsed, setProducedQty, setUtilization, deleteMaterialLine, importMaterialAction,
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

const cellInput = "px-2 py-1 text-sm font-bold tabnum ltr text-center";

/** The sheet's own column names are sentences ("No. of Sheets in Actual
 *  Nesting for one Unit"), so a header cell wraps to a few words wide instead
 *  of pushing the table off the screen. */
const TH = "p-2 align-bottom max-w-[7.5rem] whitespace-normal leading-tight";

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

/** Sheet counts read as fractions of a sheet — 1.287, not 1.3. A rate per
 *  unit is finer still: the sheet writes 0.2207. */
function Sheets({ v, className = "", digits = 4 }: { v: number | null; className?: string; digits?: 3 | 4 }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className={`tabnum ltr ${className}`}>{Number.isInteger(v) ? v : Number(v.toFixed(digits))}</span>;
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

function CellInput({ id, field, value, action, title, bold, step = "0.01", className = "w-20", placeholder = "—" }: {
  id: number; field: "actualPerUnit" | "sheetsUsed" | "producedQty" | "utilization"; value: number | null;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>; title: string; bold?: boolean;
  step?: string; className?: string; placeholder?: string;
}) {
  const a = useAction();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  function save() {
    const current = value === null ? "" : String(value);
    if (draft.trim() === current) return;
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set(field, draft.trim());
    a.run(action, fd, "Saved.");
  }
  return (
    <span className="inline-flex flex-col items-center">
      <input
        type="number" step={step} min="0" value={draft} disabled={a.pending}
        onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
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
  return (
    <>
      <div>{mo}</div>
      {status
        ? <span className="pill pill-ok text-[10px]" title={`On the ODOO tab — ${status}`}>✓ ODOO · {status}</span>
        : <span className="pill pill-muted text-[10px]" title="No ODOO row carries this MO yet">not on ODOO</span>}
    </>
  );
}

function LineRow({ line, knownBoms, knownCodes, canEdit, showMonth, product, odoo }: { line: MaterialLineView; knownBoms: string[]; knownCodes: string[]; canEdit: boolean; showMonth: boolean; product: ProductLine; odoo: Record<string, string> }) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
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
  const actions = (
    <td className="p-2 text-center whitespace-nowrap no-print">
      {canEdit ? (
        <span className="inline-flex gap-1">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="btn btn-sm btn-danger" disabled={del.pending}
            onClick={() => {
              if (!confirm(`Delete ${line.partCode ? `${line.partCode} ` : ""}${line.material} ${line.thicknessMm}mm ${line.sheetSize} from ${line.mo || line.bom}?`)) return;
              const fd = new FormData(); fd.set("id", String(line.id));
              del.run(deleteMaterialLine, fd, "Deleted.");
            }}>Delete</button>
        </span>
      ) : <span className="text-muted text-xs">—</span>}
    </td>
  );
  if (lv) {
    // the panels' sheet: the order's head, then the thickness row, then what
    // the tracker produced and what that consumed
    const done = line.remainingUnits === 0 && line.units > 0;
    return (
      <>
        <tr className={`border-t ${done ? "bg-ok-bg/30" : ""}`}>
          <td className="p-2 font-bold whitespace-nowrap ltr text-xs"><MoCell mo={line.mo} odoo={odoo} /></td>
          <td className="p-2 text-center"><span className="pill pill-muted">{line.partName || "—"}</span></td>
          <td className="p-2 whitespace-nowrap ltr text-xs tabnum text-muted">{line.materialCode || "—"}</td>
          <td className="p-2 text-center tabnum font-bold">{line.units}</td>
          <td className="p-2 whitespace-nowrap ltr text-xs">{line.bom}</td>
          <td className="p-2 whitespace-nowrap">{line.material}</td>
          <td className="p-2 text-center tabnum ltr">{line.thicknessMm}</td>
          <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
          <td className="p-2 text-center"><Sheets v={line.sheetsPerUnit} digits={4} /></td>
          <td className="p-2 text-center font-bold"><Sheets v={line.forJob} /></td>
          <td className="p-2 text-center">
            {canEdit ? (
              <CellInput id={line.id} field="actualPerUnit" value={line.actualPerUnit} action={setActualPerUnit} step="0.0001" className={`w-24 ${line.actualPerUnitManual ? "font-semibold" : "text-muted font-normal"}`} title="Sheets ONE unit really takes — blank means the BOM's figure" />
            ) : <Sheets v={line.actualPerUnit} digits={4} />}
          </td>
          <td className="p-2 text-center bg-brand-light/30 whitespace-nowrap">
            {canEdit ? (
              <CellInput id={line.id} field="producedQty" value={line.producedQty} action={setProducedQty} placeholder={line.producedAuto === null ? "—" : String(line.producedAuto)} title={line.producedAuto === null ? "Units produced — type it" : `${line.producedAuto} painted on the tracker — type over it only to override`} />
            ) : <Sheets v={line.producedUsed} />}
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
      <tr className="border-t">
        <td className="p-2 whitespace-nowrap ltr text-xs">{line.mtr || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs font-semibold">{line.soi || <span className="text-muted">—</span>}</td>
        {/* the sheet files each part under Odoo's MO — the key an ODOO row finds it by */}
        <td className="p-2 font-bold whitespace-nowrap ltr text-xs"><MoCell mo={line.mo} odoo={odoo} /></td>
        <td className="p-2 whitespace-nowrap ltr text-xs">{line.bom}</td>
        <td className="p-2 text-center tabnum ltr">{line.units}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs font-bold">{line.partCode || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap text-xs">{line.partName || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs">{line.materialCode || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap">{line.material}</td>
        <td className="p-2 text-center tabnum ltr">{line.thicknessMm}</td>
        <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
        <td className="p-2 text-center tabnum"><Sheets v={line.weightKg} digits={3} /></td>
        <td className="p-2 text-center"><Sheets v={line.sheetsPerUnit} digits={4} /></td>
        {/* Actual / unit — the sheet's own figure where it carries one, and
            typed here for the lines it leaves blank (most of them). What is
            typed outranks the sheet: a re-import fills the blanks and leaves
            these standing. It is the rate everything below multiplies. */}
        <td className="p-2 text-center">
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
              <Sheets v={line.actualPerUnit} digits={4} />
            </span>
          )}
        </td>
        <td className="p-2 text-center font-bold"><Sheets v={line.forJob} /></td>
        <td className="p-2 text-center">
          {canEdit ? <CellInput id={line.id} field="sheetsUsed" value={line.sheetsUsed} action={setSheetsUsed} title="No. of Pieces in Actual Nesting for the job" bold /> : <Sheets v={line.sheetsUsed} className="font-extrabold" />}
        </td>
        <td className="p-2 text-center">
          {canEdit ? <CellInput id={line.id} field="utilization" value={line.utilization} action={setUtilization} step="0.0001" title="Average utilization of the nesting — as the sheet writes it (0.85 or 85)" /> : <Utilization v={line.utilization} />}
        </td>
        <td className="p-2 text-center tabnum font-semibold" title={line.actualWeightKg === null ? "Needs the pieces nested for the job and the weight" : `${line.sheetsUsed} × ${line.weightKg} kg`}><Sheets v={line.actualWeightKg} digits={3} /></td>
        <td className={`p-2 text-center font-extrabold ${diffCls}`}><Sheets v={line.difference} /></td>
        <td className="p-2 text-xs max-w-[200px]">{line.note}</td>
        <td className="p-2 text-center bg-brand-light/30">
          {canEdit ? <CellInput id={line.id} field="producedQty" value={line.producedQty} action={setProducedQty} title="The quantity to cost — the tab multiplies the actual rate by it" /> : <Sheets v={line.producedQty} />}
        </td>
        <td className="p-2 text-center font-extrabold bg-brand-light/30" title={line.actualPerUnit === null ? "No rate yet — type one under Actual Nesting for one Unit, or nest the job" : `${Number(line.actualPerUnit.toFixed(4))} sheets a unit × the quantity beside it`}>
          <Sheets v={line.forProduced} />
        </td>
        {showMonth && <td className="p-2 whitespace-nowrap text-xs">{line.month || <span className="text-muted">—</span>}</td>}
        {actions}
      </tr>
      {editor}
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
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>➕ Add a material line</button>
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
  const [open, setOpen] = useState(false);
  function submit(form: HTMLFormElement, preview: boolean) {
    const fd = new FormData(form); fd.set("preview", String(preview));
    startTransition(async () => {
      const r = await importMaterialAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) { setRes({ ok: false, text: r.error ?? "Import failed." }); return; }
      const stale = r.recomputed ? ` · ${r.recomputed} row(s) where the sheet's “Actual Nesting for Job” disagrees with its own per-unit rate × units — kept as written, worth a look` : "";
      const gone = r.missing
        ? preview
          ? ` · ${r.missing} row(s) on the tab are not in this file${fd.get("prune") ? " — they would be removed" : " — they stay"}`
          : r.removed ? ` · ${r.removed} row(s) no longer in the file removed` : ` · ${r.missing} row(s) not in this file kept`
        : "";
      const tail = `${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged${r.sheet ? ` (sheet “${r.sheet}”)` : ""}${gone}${stale}`;
      setRes({ ok: true, text: preview ? `Preview only — nothing saved: ${tail}.` : `Table updated: ${tail}.` });
      if (!preview) router.refresh();
    });
  }
  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => { setRes(null); setIssues([]); setOpen(true); }}>
        📥 {lv ? "Upload the Consumption Details sheet" : "Upload the material sheet"}
      </button>
      {open && (
        <Modal title={lv ? "📥 Upload the Consumption Details sheet" : "📥 Upload the material sheet"} sub="No month to pick — each row is matched on its MO and the table is updated." onClose={() => setOpen(false)} busy={pending}>
          <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
            <label className="block">
              <span className="text-xs font-bold text-muted">Excel file</span>
              <input type="file" name="file" accept=".xlsx,.xlsm,.xls" required className="block text-sm mt-1" />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="prune" className="mt-1" />
              <span>Remove the rows that are no longer in the file <span className="text-muted">(lines typed in the tab stay)</span></span>
            </label>
            <p className="text-xs text-muted">
              {lv ? (
                <>Reads the panels&apos; Consumption Details sheet as it is — Product, Sec Item, Planned qty, MO, BOM, Material, then one row per Thickness with the sheets for one unit and what was actually consumed (“For 8 Units 14.4 Sheets Consumed”, or Done). Uploading it again updates the rows, never doubles them.</>
              ) : (<>Reads the sheet by its headers — MO, BOM Ref, Quantity of Units, Part Code, Part Name, Codes, Material, Thickness, Sheet Size, Sheets in BOM for one Unit, Actual Nesting for Job, Notes. Each row is matched on its MO (with the BOM, part, material, thickness and size): uploading again adds the new rows and updates the
              changed ones — never doubles them — and leaves your “Quantity” exactly as typed. The ODOO tab finds each MO&apos;s lines by the same MO.</>)}
            </p>
            <Msg msg={res} />
            {issues.length > 0 && (
              <ul className="text-xs text-warn-fg list-disc ps-5 space-y-0.5 max-h-40 overflow-y-auto">{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
            )}
            <div className="flex justify-end gap-2 pt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>Close</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, true)}>Preview</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, false)}>{pending ? "Working…" : "Upload"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}


// ---- totals ----

function TotalsTable({ totals, lv = false }: { totals: MaterialTotal[]; lv?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 text-left">
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

const SEL = "border rounded-md px-2 py-1.5 bg-surface text-sm font-semibold";

function Pick({ label, value, options, onChange, render }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; render?: (v: string) => string;
}) {
  return (
    <select aria-label={label} title={label} className={SEL} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}: all</option>
      {options.map((o) => <option key={o} value={o}>{render ? render(o) : o}</option>)}
    </select>
  );
}

function FilterBar({ lines, filters, onChange, shown }: { lines: MaterialLineView[]; filters: MaterialFilters; onChange: (f: MaterialFilters) => void; shown: number }) {
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
    <div className="flex flex-wrap items-center gap-2 no-print">
      <input
        type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })}
        placeholder="Search BOM, SOI, part, code, note…" aria-label="Search"
        className={`${SEL} ltr w-64 font-normal`}
      />
      <Pick label="Part" value={filters.partCode} options={parts} onChange={(v) => set({ partCode: v })} render={(c) => `${c}${nameOf(c) ? ` · ${nameOf(c)}` : ""}`} />
      <Pick label="Material" value={filters.material} options={materials} onChange={(v) => set({ material: v })} />
      <Pick label="Thickness" value={filters.thicknessMm} options={thicknesses} onChange={(v) => set({ thicknessMm: v })} render={(t) => `${t} mm`} />
      <Pick label="Sheet size" value={filters.sheetSize} options={sizes} onChange={(v) => set({ sheetSize: v })} />
      <select aria-label="Status" title="Where the line stands" className={SEL} value={filters.status} onChange={(e) => set({ status: e.target.value as MaterialStatusFilter })}>
        {(Object.keys(MATERIAL_STATUS_FILTERS) as MaterialStatusFilter[]).map((k) => <option key={k} value={k}>{MATERIAL_STATUS_FILTERS[k]}</option>)}
      </select>
      <span className="text-xs text-muted tabnum">
        {active ? `${shown} of ${lines.length} line(s)` : `${lines.length} line(s)`}
      </span>
      {active && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(EMPTY_MATERIAL_FILTERS)}>✕ Clear</button>}
    </div>
  );
}

export function MaterialClient({ lines, totals, month, knownBoms, canEdit, product = "TR", lvOrders = [], lvTemplates = {}, odooByMo = {} }: {
  lines: MaterialLineView[]; totals: MaterialTotal[]; month: string; knownBoms: string[]; canEdit: boolean;
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
  return (
    <div className="space-y-5">
      {canEdit && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="flex flex-wrap gap-2">
            <ImportPanel product={product} />
            {lv ? <AddLvOrder orders={lvOrders} templates={lvTemplates} /> : <AddLine knownBoms={knownBoms} knownCodes={knownCodes} product={product} />}
          </span>
        </div>
      )}
      {lines.length > 0 && <FilterBar lines={lines} filters={filters} onChange={changeFilters} shown={shown.length} />}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {lines.length === 0 ? (
          <p className="text-sm text-muted p-4">
            {showMonth ? "No material recorded yet." : month ? `Nothing filed under ${month}.` : "The table is empty."} {lv ? "Upload the Consumption Details sheet, or add an order." : "Upload the material sheet, or add a line."}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted p-4">No line matches these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                {/* The Nesting Tracker's OWN columns, in the sheet's order and
                    under the sheet's own names, so the tab reads as the sheet
                    does. Then the two this tab adds — the quantity he types and
                    what it really costs — and last the app's own identity
                    columns, which the sheet has never carried. */}
                {lv ? (
                  <tr className="bg-brand text-white text-left align-bottom">
                    <th className={TH}>MO</th>
                    <th className={`${TH} text-center`}>Product</th>
                    <th className={TH}>Sec Item</th>
                    <th className={`${TH} text-center`}>Planned qty</th>
                    <th className={TH}>BOM</th>
                    <th className={TH}>Material</th>
                    <th className={`${TH} text-center`}>Thickness (mm)</th>
                    <th className={`${TH} text-center`}>Sheet Size</th>
                    <th className={`${TH} text-center`}>No. of Sheets in BOM for one Unit</th>
                    <th className={`${TH} text-center`} title="Per unit × planned qty">Sheets Qty as per BOM</th>
                    <th className={`${TH} text-center`} title="Sheets one unit really takes — blank means the BOM's figure">Actual per Unit</th>
                    <th className={`${TH} text-center bg-brand-dark`} title="Panels painted on the tracker; type here only to override">Produced</th>
                    <th className={`${TH} text-center bg-brand-dark`} title="Sheets the produced panels consumed — per unit × produced">Actually Consumed</th>
                    <th className={`${TH} text-center`}>Remaining units</th>
                    <th className={TH}>Remarks</th>
                    {showMonth && <th className={TH}>Month</th>}
                    <th className="p-2 no-print" />
                  </tr>
                ) : (
                <tr className="bg-brand text-white text-left align-bottom">
                  <th className={TH} title="The material request the sheets were drawn on">MTR Request #</th>
                  <th className={TH}>SOI</th>
                  <th className={TH} title="Odoo's MO for the part — the ODOO tab finds the line by it">MO</th>
                  <th className={TH}>BOM Ref</th>
                  <th className={`${TH} text-center`}>Quantity of Units</th>
                  <th className={TH}>Part Code</th>
                  <th className={TH}>Part Name</th>
                  <th className={TH}>Material Code</th>
                  <th className={TH}>Material</th>
                  <th className={`${TH} text-center`}>Thickness (mm)</th>
                  <th className={`${TH} text-center`}>Sheet Size</th>
                  <th className={`${TH} text-center`} title="One sheet's weight">Weight(Kg)</th>
                  <th className={`${TH} text-center`}>BOM Qty for one Unit</th>
                  <th className={`${TH} text-center`} title="From the sheet, or typed here for the lines it leaves blank">No. of Pieces in Actual Nesting for one Unit</th>
                  <th className={`${TH} text-center`} title="BOM Qty for one Unit × units">BOM Pieces for Job</th>
                  <th className={`${TH} text-center`} title="Type here">No. of Pieces in Actual Nesting for Job</th>
                  <th className={`${TH} text-center`}>Average Utilization</th>
                  <th className={`${TH} text-center`} title="Pieces in Actual Nesting for Job × Weight(Kg)">Actual Weight (Kg)</th>
                  <th className={`${TH} text-center`} title="BOM Pieces for Job − Actual Nesting for Job. Red = ate more than the BOM allows">Difference</th>
                  <th className={TH}>Notes</th>
                  <th className={`${TH} text-center bg-brand-dark`} title="Type the quantity you want costed — it does not have to be the whole job">Quantity</th>
                  <th className={`${TH} text-center bg-brand-dark`} title="Actual Nesting for one Unit × the quantity beside it">Actual for Quantity</th>
                  {showMonth && <th className={TH}>Month</th>}
                  <th className="p-2 no-print" />
                </tr>
                )}
              </thead>
              <tbody>
                {shown.map((l) => <LineRow key={l.id} line={l} knownBoms={knownBoms} knownCodes={knownCodes} canEdit={canEdit} showMonth={showMonth} product={product} odoo={odooByMo} />)}
              </tbody>
            </table>
          </div>
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
