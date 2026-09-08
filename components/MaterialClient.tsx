"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import {
  MATERIAL_PRESETS, PART_PRESETS, SHEET_SIZE_PRESETS, MATERIAL_STATUS_FILTERS, EMPTY_MATERIAL_FILTERS,
  partNameFor, filterMaterialLines, summarizeMaterial,
  type MaterialLineView, type MaterialTotal, type MaterialFilters, type MaterialStatusFilter,
} from "@/lib/domain/material";
import { monthInputFromLabel } from "@/lib/domain/dates";
import { Soi } from "@/components/ui";
import {
  createMaterialLine, updateMaterialLine, setSheetsUsed, setProducedQty, deleteMaterialLine, importMaterialAction,
} from "@/app/material/actions";

// The MATERIAL tab — the planner's Nesting Project Tracker, month by month.
//
// The table is the sheet's row in the sheet's order — BOM Ref · Quantity of
// Units · Part Code · Part Name · Codes · Material · Thickness · Sheet Size ·
// Sheets in BOM for one Unit · for Job · Actual Nesting for one Unit · for
// Job · Difference · Notes — plus two columns of the tab's own: units
// PRODUCED (typed) and the sheets those units really consumed (at the actual
// rate). Sheets-for-job, actual-per-unit and Difference are computed, never
// typed, so they can never disagree.

const cellInput = "w-20 px-2 py-1 text-sm font-bold tabnum ltr text-center";

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
function Sheets({ v, className = "", digits = 3 }: { v: number | null; className?: string; digits?: 3 | 4 }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className={`tabnum ltr ${className}`}>{Number.isInteger(v) ? v : Number(v.toFixed(digits))}</span>;
}

// ---- month picker (drives ?month=; this month by default, "all" for everything) ----

export function MaterialMonthPicker({ month, months }: { month: string; months: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const options = months.includes(month) || month === "all" ? months : [month, ...months];
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold">
      Month:
      <select
        className="border rounded-md px-2 py-1.5 bg-surface font-bold"
        value={month}
        onChange={(e) => {
          const p = new URLSearchParams(params.toString());
          p.set("month", e.target.value);
          router.push(`${pathname}?${p}`);
        }}
      >
        <option value="all">All months</option>
        {options.map((m) => (
          <option key={m} value={m}>{m || "No month"}</option>
        ))}
      </select>
    </label>
  );
}

// ---- the line form: one strip, the sheet's columns in the sheet's order ----

const F = "px-2 py-1.5 text-sm font-semibold";

function Field({ hint, className = "", children }: { hint: string; className?: string; children: React.ReactNode }) {
  return <span className={`inline-flex flex-col ${className}`} title={hint}>{children}</span>;
}

function LineFields({ line, month, knownBoms, knownCodes, disabled }: { line?: MaterialLineView; month: string; knownBoms: string[]; knownCodes: string[]; disabled?: boolean }) {
  const monthDefault = monthInputFromLabel(line?.month ?? (month === "all" ? "" : month)) ?? "";
  return (
    <>
      <Field hint="Plan month this line belongs to" className="w-[9.5rem]">
        <input name="month" type="month" aria-label="Month" defaultValue={monthDefault} required disabled={disabled} className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="BOM reference" className="w-36">
        <input name="bom" list="material-boms" aria-label="BOM" defaultValue={line?.bom ?? ""} required disabled={disabled} placeholder="BOM" className={`${F} ltr w-full`} />
        <datalist id="material-boms">{knownBoms.map((b) => <option key={b} value={b} />)}</datalist>
      </Field>
      <Field hint="Quantity of Units — the job size on the sheet" className="w-20">
        <input name="units" type="number" step="1" min="0" aria-label="Quantity of units" defaultValue={line?.units ?? ""} required disabled={disabled} placeholder="units" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Part Code — the part these sheets go into (FB-022 tank, FB-051 top cover …)" className="w-24">
        <input
          name="partCode" list="part-codes" aria-label="Part code" defaultValue={line?.partCode ?? ""} disabled={disabled} placeholder="FB-022" className={`${F} ltr w-full`}
          onChange={(e) => {
            // a known code fills the name; a typed name is never overwritten
            const name = partNameFor(e.target.value);
            const el = e.target.form?.elements.namedItem("partName");
            if (name && el instanceof HTMLInputElement && (!el.value || partNameFor(el.dataset.from ?? "") === el.value)) { el.value = name; el.dataset.from = e.target.value; }
          }}
        />
        <datalist id="part-codes">{PART_PRESETS.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
      </Field>
      <Field hint="Part Name" className="w-28">
        <input name="partName" aria-label="Part name" defaultValue={line?.partName ?? ""} disabled={disabled} placeholder="TANK" className={`${F} w-full`} />
      </Field>
      <Field hint="Codes — the material's code on the sheet (T-SSS-5MM)" className="w-28">
        <input name="materialCode" list="material-codes" aria-label="Material code" defaultValue={line?.materialCode ?? ""} disabled={disabled} placeholder="T-SSS-5MM" className={`${F} ltr w-full`} />
        <datalist id="material-codes">{knownCodes.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field hint="Material type" className="w-32">
        <input name="material" list="material-types" aria-label="Material" defaultValue={line?.material ?? ""} required disabled={disabled} placeholder="Steel" className={`${F} w-full`} />
        <datalist id="material-types">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <Field hint="Thickness in mm" className="w-20">
        <input name="thicknessMm" type="number" step="0.1" min="0.1" aria-label="Thickness" defaultValue={line?.thicknessMm ?? ""} required disabled={disabled} placeholder="mm" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Sheet size" className="w-32">
        <input name="sheetSize" list="sheet-sizes" aria-label="Sheet size" defaultValue={line?.sheetSize ?? ""} required disabled={disabled} placeholder="1220*2440" className={`${F} ltr w-full`} />
        <datalist id="sheet-sizes">{SHEET_SIZE_PRESETS.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="No. of Sheets in BOM for ONE unit" className="w-24">
        <input name="sheetsPerUnit" type="number" step="0.0001" min="0" aria-label="Sheets per unit" defaultValue={line?.sheetsPerUnit ?? ""} required disabled={disabled} placeholder="per unit" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="No. of Sheets in Actual Nesting for the job — leave empty until nested" className="w-24">
        <input name="sheetsUsed" type="number" step="0.01" min="0" aria-label="Sheets actually nested" defaultValue={line?.sheetsUsed ?? ""} disabled={disabled} placeholder="actual" className={`${F} ltr tabnum w-full font-extrabold`} />
      </Field>
      <Field hint="Units produced so far — the tab works out the sheets they really consumed" className="w-24">
        <input name="producedQty" type="number" step="1" min="0" aria-label="Units produced" defaultValue={line?.producedQty ?? ""} disabled={disabled} placeholder="produced" className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="Notes" className="w-40">
        <input name="note" aria-label="Notes" defaultValue={line?.note ?? ""} disabled={disabled} placeholder="notes" className={`${F} w-full`} />
      </Field>
    </>
  );
}

// ---- one editable number cell (actual nested · units produced) ----

function CellInput({ id, field, value, action, title, bold }: {
  id: number; field: "sheetsUsed" | "producedQty"; value: number | null;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>; title: string; bold?: boolean;
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
        type="number" step="0.01" min="0" value={draft} disabled={a.pending}
        onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="—" title={title} className={`${cellInput} ${bold ? "font-extrabold" : ""}`}
      />
      {a.msg?.ok === false && <span className="text-[10px] text-bad-fg">{a.msg.text}</span>}
    </span>
  );
}

// ---- one row of the table ----

function LineRow({ line, month, knownBoms, knownCodes, canEdit, showMonth }: { line: MaterialLineView; month: string; knownBoms: string[]; knownCodes: string[]; canEdit: boolean; showMonth: boolean }) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
  const diffCls = line.difference === null ? "" : line.difference < 0 ? "text-bad-fg" : line.difference > 0 ? "text-ok-fg" : "text-muted";
  const cols = 19 + (showMonth ? 1 : 0);
  return (
    <>
      <tr className="border-t">
        {showMonth && <td className="p-2 whitespace-nowrap text-xs">{line.month || <span className="text-muted">—</span>}</td>}
        <td className="p-2 font-bold whitespace-nowrap ltr">{line.bom}</td>
        <td className="p-2 whitespace-nowrap"><Soi soi={line.soi} /></td>
        <td className="p-2 text-center tabnum ltr">{line.units}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs font-bold">{line.partCode || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap text-xs">{line.partName || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs">{line.materialCode || <span className="text-muted">—</span>}</td>
        <td className="p-2 whitespace-nowrap">{line.material}</td>
        <td className="p-2 text-center tabnum ltr">{line.thicknessMm}</td>
        <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
        <td className="p-2 text-center"><Sheets v={line.sheetsPerUnit} digits={4} /></td>
        <td className="p-2 text-center font-bold"><Sheets v={line.forJob} /></td>
        <td className="p-2 text-center text-muted" title="Sheets actually nested ÷ quantity of units"><Sheets v={line.actualPerUnit} digits={4} /></td>
        <td className="p-2 text-center">
          {canEdit ? <CellInput id={line.id} field="sheetsUsed" value={line.sheetsUsed} action={setSheetsUsed} title="No. of Sheets in Actual Nesting for the job" bold /> : <Sheets v={line.sheetsUsed} className="font-extrabold" />}
        </td>
        <td className={`p-2 text-center font-extrabold ${diffCls}`}><Sheets v={line.difference} /></td>
        <td className="p-2 text-center bg-brand-light/30">
          {canEdit ? <CellInput id={line.id} field="producedQty" value={line.producedQty} action={setProducedQty} title="Units produced so far" /> : <Sheets v={line.producedQty} />}
        </td>
        <td className="p-2 text-center font-extrabold bg-brand-light/30" title={line.actualPerUnit === null ? "Nest the job first — the rate comes from the actual nesting" : `${Number(line.actualPerUnit.toFixed(4))} sheets per unit, actually`}>
          <Sheets v={line.forProduced} />
        </td>
        <td className="p-2 text-xs max-w-[200px]">{line.note}</td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          {canEdit ? (
            <span className="inline-flex gap-1">
              <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={del.pending}
                onClick={() => {
                  if (!confirm(`Delete ${line.partCode ? `${line.partCode} ` : ""}${line.material} ${line.thicknessMm}mm ${line.sheetSize} from ${line.bom} (${line.month || "no month"})?`)) return;
                  const fd = new FormData(); fd.set("id", String(line.id));
                  del.run(deleteMaterialLine, fd, "Deleted.");
                }}>Delete</button>
            </span>
          ) : <span className="text-muted text-xs">—</span>}
        </td>
      </tr>
      {(del.msg?.ok === false || editing) && (
        <tr className="border-t-0">
          <td colSpan={cols} className="px-2 pb-3">
            <Msg msg={del.msg?.ok === false ? del.msg : null} />
            {editing && (
              <form className="mt-2 border rounded-xl p-2" onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget); fd.set("id", String(line.id));
                edit.run(updateMaterialLine, fd, "Saved.", () => setEditing(false));
              }}>
                <div className="flex flex-wrap items-stretch gap-1.5">
                  <LineFields line={line} month={month} knownBoms={knownBoms} knownCodes={knownCodes} disabled={edit.pending} />
                  <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={edit.pending}>Save</button>
                </div>
                <Msg msg={edit.msg} />
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ---- add ----

// A BOM is never one line: the sheet runs five to seven thicknesses under the
// same BOM, units and sheet size. A successful add clears only what changes
// from line to line and returns the cursor to the material.
const PER_LINE = ["partCode", "partName", "material", "thicknessMm", "sheetsPerUnit", "sheetsUsed", "producedQty", "note"] as const;

function AddLine({ month, knownBoms, knownCodes, startOpen }: { month: string; knownBoms: string[]; knownCodes: string[]; startOpen: boolean }) {
  const add = useAction();
  const [open, setOpen] = useState(startOpen);
  function clearForNext(form: HTMLFormElement) {
    for (const n of PER_LINE) { const el = form.elements.namedItem(n); if (el instanceof HTMLInputElement) el.value = ""; }
    const first = form.elements.namedItem("partCode"); if (first instanceof HTMLInputElement) first.focus();
  }
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>➕ Add a material line</button>;
  return (
    <form className="border rounded-xl p-2" onSubmit={(e) => {
      e.preventDefault(); const form = e.currentTarget;
      add.run(createMaterialLine, new FormData(form), "Added — next line.", () => clearForNext(form));
    }}>
      <div className="flex flex-wrap items-stretch gap-1.5">
        <LineFields month={month} knownBoms={knownBoms} knownCodes={knownCodes} disabled={add.pending} />
        <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={add.pending}>Add</button>
        <button type="button" className="btn btn-sm btn-ghost shrink-0" onClick={() => setOpen(false)}>✕</button>
      </div>
      <Msg msg={add.msg} />
    </form>
  );
}

// ---- import the sheet for a month ----

function ImportPanel({ month }: { month: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const monthDefault = monthInputFromLabel(month === "all" ? "" : month) ?? "";
  function submit(form: HTMLFormElement, preview: boolean) {
    const fd = new FormData(form); fd.set("preview", String(preview));
    startTransition(async () => {
      const r = await importMaterialAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) { setRes({ ok: false, text: r.error ?? "Import failed." }); return; }
      const tail = `${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged${r.sheet ? ` (sheet “${r.sheet}”)` : ""}`;
      setRes({ ok: true, text: preview ? `Preview only — nothing saved: ${tail}.` : `Imported: ${tail}.` });
      if (!preview) router.refresh();
    });
  }
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>📥 Import the Nesting Tracker sheet</button>;
  return (
    <form className="border rounded-xl p-3 space-y-2" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-bold text-muted">Excel file</span>
          <input type="file" name="file" accept=".xlsx,.xlsm,.xls" required className="block text-sm" />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-muted">Plan month</span>
          <input type="month" name="month" defaultValue={monthDefault} required className={`${F} ltr tabnum block`} />
        </label>
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, true)}>Preview</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, false)}>Import</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>✕</button>
      </div>
      <p className="text-xs text-muted">
        Reads the Nesting Project Tracker by its headers — BOM Ref, Quantity of Units, Part Code, Part Name, Codes, Material, Thickness, Sheet Size, Sheets in BOM for one Unit, Actual Nesting for Job, Notes. Importing the same month again adds the new rows and updates the
        ones whose values changed — it never doubles them, and it leaves your “Units produced” exactly as typed.
      </p>
      <Msg msg={res} />
      {issues.length > 0 && (
        <ul className="text-xs text-warn-fg list-disc ps-5 space-y-0.5 max-h-40 overflow-y-auto">{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
      )}
    </form>
  );
}

// ---- totals ----

function TotalsTable({ totals }: { totals: MaterialTotal[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 text-left">
            <th className="p-2">Material</th><th className="p-2 text-center">Thk (mm)</th><th className="p-2 text-center">Sheet size</th>
            <th className="p-2 text-center" title="Sheets the BOMs call for">Sheets for job</th>
            <th className="p-2 text-center" title="Sheets actually nested">Actual nested</th>
            <th className="p-2 text-center" title="Sheets the produced units really consumed">Used for produced</th>
            <th className="p-2 text-center">Not nested yet</th>
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
function readSavedFilters(saved: string): MaterialFilters {
  let raw: unknown = null;
  try { raw = saved ? JSON.parse(saved) : null; } catch { raw = null; }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: keyof MaterialFilters) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const status = str("status");
  return {
    q: str("q"), partCode: str("partCode"), material: str("material"), thicknessMm: str("thicknessMm"), sheetSize: str("sheetSize"),
    status: status in MATERIAL_STATUS_FILTERS ? (status as MaterialStatusFilter) : "all",
  };
}

// The filters live in this browser's storage, so the tab reopens narrowed the
// way it was left. Storage is the source of truth: the server renders the
// page unfiltered, and the browser takes over after hydration.
const filterListeners = new Set<() => void>();
function subscribeFilters(cb: () => void) {
  filterListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { filterListeners.delete(cb); window.removeEventListener("storage", cb); };
}
let memoryRaw = ""; // when storage is blocked, the filters still work for this page load
function readFiltersRaw(): string {
  try { return localStorage.getItem(FILTERS_KEY) ?? memoryRaw; } catch { return memoryRaw; }
}
function useSavedFilters() {
  const raw = useSyncExternalStore(subscribeFilters, readFiltersRaw, () => "");
  const filters = useMemo(() => (raw ? readSavedFilters(raw) : EMPTY_MATERIAL_FILTERS), [raw]);
  const changeFilters = (f: MaterialFilters) => {
    memoryRaw = JSON.stringify(f);
    try { localStorage.setItem(FILTERS_KEY, memoryRaw); } catch { /* storage unavailable — the filter holds for this page load only */ }
    filterListeners.forEach((l) => l());
  };
  return { filters, changeFilters };
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
      <Pick label="Part" value={filters.partCode} options={parts} onChange={(v) => set({ partCode: v })} render={(c) => `${c}${partNameFor(c) ? ` · ${partNameFor(c)}` : ""}`} />
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

export function MaterialClient({ lines, totals, month, knownBoms, canEdit }: {
  lines: MaterialLineView[]; totals: MaterialTotal[]; month: string; knownBoms: string[]; canEdit: boolean;
}) {
  const showMonth = month === "all";
  const knownCodes = [...new Set(lines.map((l) => l.materialCode).filter(Boolean))].sort();
  const { filters, changeFilters } = useSavedFilters();
  const shown = useMemo(() => filterMaterialLines(lines, filters), [lines, filters]);
  const filtering = shown.length !== lines.length;
  // the totals follow the filter, so "Stainless steel 5 mm, tanks only" adds up on its own
  const shownTotals = filtering ? summarizeMaterial(shown) : totals;
  return (
    <div className="space-y-5">
      {canEdit && (
        <div className="flex flex-wrap items-start gap-2">
          <ImportPanel month={month} />
        </div>
      )}
      {lines.length > 0 && <FilterBar lines={lines} filters={filters} onChange={changeFilters} shown={shown.length} />}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {lines.length === 0 ? (
          <p className="text-sm text-muted p-4">
            {showMonth ? "No material recorded yet." : `Nothing recorded for ${month}.`} Import the month&apos;s Nesting Tracker sheet, or add lines below.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted p-4">No line matches these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-left">
                  {showMonth && <th className="p-2">Month</th>}
                  <th className="p-2">BOM Ref</th>
                  <th className="p-2" title="Sales order item">SOI</th>
                  <th className="p-2 text-center" title="Quantity of Units">Units</th>
                  <th className="p-2" title="Part Code">Part</th>
                  <th className="p-2" title="Part Name">Part name</th>
                  <th className="p-2" title="Codes — the material's code">Codes</th>
                  <th className="p-2">Material</th>
                  <th className="p-2 text-center">Thk (mm)</th>
                  <th className="p-2 text-center">Sheet size</th>
                  <th className="p-2 text-center" title="No. of Sheets in BOM for one Unit">BOM / unit</th>
                  <th className="p-2 text-center" title="No. of Sheets in BOM for Job = per unit × units">BOM for job</th>
                  <th className="p-2 text-center" title="No. of Sheets in Actual Nesting for one Unit = actual for job ÷ units">Actual / unit</th>
                  <th className="p-2 text-center" title="No. of Sheets in Actual Nesting for Job — type here">Actual for job</th>
                  <th className="p-2 text-center" title="BOM for job − actual for job. Red = ate more than the BOM allows">Difference</th>
                  <th className="p-2 text-center bg-brand-dark" title="Units produced so far — type here">Produced</th>
                  <th className="p-2 text-center bg-brand-dark" title="Sheets the produced units really consumed, at the job's actual rate">Sheets used for produced</th>
                  <th className="p-2">Notes</th>
                  <th className="p-2 no-print" />
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => <LineRow key={l.id} line={l} month={month} knownBoms={knownBoms} knownCodes={knownCodes} canEdit={canEdit} showMonth={showMonth} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {canEdit && <AddLine month={month} knownBoms={knownBoms} knownCodes={knownCodes} startOpen={false} />}
      {shownTotals.length > 0 && (
        <section>
          <h2 className="font-bold mb-2">
            Totals {showMonth ? "across every month" : `for ${month}`} — per material, thickness and size
            {filtering && <span className="text-sm font-normal text-muted"> · filtered lines only</span>}
          </h2>
          <div className="bg-surface border rounded-xl overflow-hidden"><TotalsTable totals={shownTotals} /></div>
        </section>
      )}
    </div>
  );
}
