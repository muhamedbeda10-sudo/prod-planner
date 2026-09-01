"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { MATERIAL_PRESETS, SHEET_SIZE_PRESETS, type MaterialLineView, type MaterialTotal } from "@/lib/domain/material";
import type { MaterialOrderRef } from "@/lib/server/material";
import { createMaterialLine, updateMaterialLine, setSheetsUsed, deleteMaterialLine } from "@/app/material/actions";

// The MATERIAL tab — what an order ACTUALLY consumed.
//
// One line per BOM (× order) × material × thickness × sheet size. The number a
// person types is "sheets used"; the nesting BOM's sheets-per-unit is optional
// beside it, and giving it turns on the two comparison columns. Everything else
// on the row is computed, so nothing here can disagree with the orders registry.

const inputCls = "px-2.5 py-1.5 text-sm font-semibold w-full";
const cellInput = "w-24 px-2 py-1 text-sm font-bold tabnum ltr text-center";

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(
    (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) => {
      startTransition(async () => {
        const res = await fn(fd);
        setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
        if (res.ok) {
          after?.();
          router.refresh();
        }
      });
    },
    [router]
  );
  return { pending, msg, setMsg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

/** Sheet counts read as fractions of a sheet — 1.287, not 1.3. */
function Sheets({ v, className = "" }: { v: number | null; className?: string }) {
  if (v === null) return <span className="text-muted">—</span>;
  return <span className={`tabnum ltr ${className}`}>{Number.isInteger(v) ? v : Number(v.toFixed(3))}</span>;
}

// ---- BOM picker (drives ?bom= — the tab remembers nothing else) ----

export function MaterialBomPicker({ boms, value }: { boms: string[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold">
      BOM:
      <select
        className="border rounded-md px-2 py-1.5 bg-surface font-bold ltr"
        value={value}
        onChange={(e) => {
          const p = new URLSearchParams(params.toString());
          if (e.target.value) p.set("bom", e.target.value);
          else p.delete("bom");
          router.push(`${pathname}${p.toString() ? `?${p}` : ""}`);
        }}
      >
        <option value="">All BOMs</option>
        {boms.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---- the shared line form (add + edit use the very same fields) ----

function LineFields({
  line,
  boms,
  orders,
  lockedBom,
  disabled,
}: {
  line?: MaterialLineView;
  boms: string[];
  orders: MaterialOrderRef[];
  lockedBom?: string;
  disabled?: boolean;
}) {
  const [bom, setBom] = useState(line?.bom ?? lockedBom ?? "");
  const bomOrders = orders.filter((o) => o.bom === bom);

  return (
    <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
      <label className="block">
        <span className="text-xs font-bold text-muted">BOM Ref</span>
        <input
          name="bom"
          list="material-boms"
          value={bom}
          onChange={(e) => setBom(e.target.value.toUpperCase())}
          required
          disabled={disabled}
          placeholder="12008E18M18"
          className={`${inputCls} ltr`}
        />
        <datalist id="material-boms">
          {boms.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted" title="Leave on ‘every order’ to describe the BOM itself">
          Order (MO)
        </span>
        <select name="mo" defaultValue={line?.mo ?? ""} disabled={disabled} className={`${inputCls} ltr`}>
          <option value="">Every order on this BOM</option>
          {bomOrders.map((o) => (
            <option key={o.mo} value={o.mo}>
              {o.mo} — {o.planQty} pcs{o.status === "closed" ? " (closed)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted">Material type</span>
        <input name="material" list="material-types" defaultValue={line?.material ?? ""} required disabled={disabled} placeholder="Steel" className={inputCls} />
        <datalist id="material-types">
          {MATERIAL_PRESETS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted">Thickness (mm)</span>
        <input
          name="thicknessMm"
          type="number"
          step="0.1"
          min="0.1"
          defaultValue={line?.thicknessMm ?? ""}
          required
          disabled={disabled}
          placeholder="3"
          className={`${inputCls} ltr tabnum`}
        />
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted">Sheet size</span>
        <input name="sheetSize" list="sheet-sizes" defaultValue={line?.sheetSize ?? ""} required disabled={disabled} placeholder="1220*2440" className={`${inputCls} ltr`} />
        <datalist id="sheet-sizes">
          {SHEET_SIZE_PRESETS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>

      <label className="block">
        <span className="text-xs font-bold" title="The sheets this job really ate — what this line is for">
          Sheets used *
        </span>
        <input
          name="sheetsUsed"
          type="number"
          step="0.01"
          min="0"
          defaultValue={line?.sheetsUsed ?? ""}
          required
          disabled={disabled}
          placeholder="17"
          className={`${inputCls} ltr tabnum`}
        />
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted" title="Optional — the nesting BOM's figure, to measure the real usage against">
          Sheets per unit (BOM)
        </span>
        <input
          name="sheetsPerUnit"
          type="number"
          step="0.0001"
          min="0"
          defaultValue={line?.sheetsPerUnit ?? ""}
          disabled={disabled}
          placeholder="optional"
          className={`${inputCls} ltr tabnum`}
        />
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted" title="Only for a BOM the orders registry does not carry — leave empty and the quantity comes from the registry">
          Units override
        </span>
        <input
          name="unitsOverride"
          type="number"
          step="1"
          min="0"
          defaultValue={line?.unitsOverride ?? ""}
          disabled={disabled}
          placeholder="from registry"
          className={`${inputCls} ltr tabnum`}
        />
      </label>

      <label className="block sm:col-span-3 lg:col-span-4">
        <span className="text-xs font-bold text-muted">Notes</span>
        <input name="note" defaultValue={line?.note ?? ""} disabled={disabled} className={inputCls} />
      </label>
    </div>
  );
}

// ---- one row of the table ----

function LineRow({
  line,
  boms,
  orders,
  canEdit,
}: {
  line: MaterialLineView;
  boms: string[];
  orders: MaterialOrderRef[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
  const used = useAction();
  const [usedDraft, setUsedDraft] = useState(String(line.sheetsUsed));

  function saveUsed() {
    if (usedDraft.trim() === "") {
      // the number is mandatory — put the stored one back rather than write a blank
      setUsedDraft(String(line.sheetsUsed));
      return;
    }
    if (usedDraft.trim() === String(line.sheetsUsed)) return; // nothing changed — no write, no toast
    const fd = new FormData();
    fd.set("id", String(line.id));
    fd.set("sheetsUsed", usedDraft.trim());
    used.run(setSheetsUsed, fd, "Saved.");
  }

  const diffCls =
    line.difference === null ? "" : line.difference < 0 ? "text-bad-fg" : line.difference > 0 ? "text-ok-fg" : "text-muted";

  return (
    <>
      <tr className="border-t">
        <td className="p-2 font-bold whitespace-nowrap ltr">{line.bom}</td>
        <td className="p-2 text-xs font-semibold whitespace-nowrap ltr">{line.mo || <span className="text-muted">all orders</span>}</td>
        <td className="p-2 whitespace-nowrap">{line.material}</td>
        <td className="p-2 text-center tabnum ltr">{line.thicknessMm}</td>
        <td className="p-2 text-center whitespace-nowrap ltr tabnum">{line.sheetSize}</td>
        <td className="p-2 text-center">
          {canEdit ? (
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={usedDraft}
              disabled={used.pending}
              onChange={(e) => setUsedDraft(e.target.value)}
              onBlur={saveUsed}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              title="Sheets this job actually ate"
              className={`${cellInput} font-extrabold`}
            />
          ) : (
            <Sheets v={line.sheetsUsed} className="font-extrabold" />
          )}
        </td>
        <td className="p-2 text-center">
          <span className="tabnum ltr">{line.units}</span>
          {!line.unitsFromRegistry && (
            <span className="pill pill-warn ml-1" title="Typed by hand — the orders registry does not carry this BOM">
              manual
            </span>
          )}
        </td>
        <td className="p-2 text-center text-muted">
          <Sheets v={line.sheetsPerUnit} />
        </td>
        <td className="p-2 text-center">
          <Sheets v={line.allowed} />
        </td>
        <td className={`p-2 text-center font-extrabold ${diffCls}`}>
          <Sheets v={line.difference} />
        </td>
        <td className="p-2 text-xs max-w-[220px]">{line.note}</td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          {canEdit ? (
            <span className="inline-flex gap-1">
              <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "Close" : "Edit"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={del.pending}
                onClick={() => {
                  if (!confirm(`Delete ${line.material} ${line.thicknessMm}mm ${line.sheetSize} from ${line.bom}?`)) return;
                  const fd = new FormData();
                  fd.set("id", String(line.id));
                  del.run(deleteMaterialLine, fd, "Deleted.");
                }}
              >
                Delete
              </button>
            </span>
          ) : (
            <span className="text-muted text-xs">—</span>
          )}
        </td>
      </tr>

      {(used.msg?.ok === false || del.msg?.ok === false || editing) && (
        <tr className="border-t-0">
          <td colSpan={12} className="px-2 pb-3">
            <Msg msg={used.msg?.ok === false ? used.msg : null} />
            <Msg msg={del.msg?.ok === false ? del.msg : null} />
            {editing && (
              <form
                className="mt-2 space-y-2.5 border rounded-xl p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  fd.set("id", String(line.id));
                  edit.run(updateMaterialLine, fd, "Saved.", () => setEditing(false));
                }}
              >
                <LineFields line={line} boms={boms} orders={orders} disabled={edit.pending} />
                <div className="flex items-center gap-3">
                  <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>
                    Save
                  </button>
                  <Msg msg={edit.msg} />
                </div>
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ---- the table ----

function LinesTable({
  lines,
  boms,
  orders,
  canEdit,
}: {
  lines: MaterialLineView[];
  boms: string[];
  orders: MaterialOrderRef[];
  canEdit: boolean;
}) {
  if (lines.length === 0) {
    return (
      <p className="text-sm text-muted p-4">
        No material recorded yet. Add the first line below: the sheet that was actually used — material, thickness, size —
        and how many of them the job ate.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-brand text-white text-left">
            <th className="p-2">BOM Ref</th>
            <th className="p-2">Order</th>
            <th className="p-2">Material</th>
            <th className="p-2 text-center">Thk (mm)</th>
            <th className="p-2 text-center">Sheet size</th>
            <th className="p-2 text-center" title="The sheets this job really ate">Sheets used</th>
            <th className="p-2 text-center" title="Quantity of units, live from the orders registry">Units</th>
            <th className="p-2 text-center" title="Optional — the nesting BOM's figure">BOM / unit</th>
            <th className="p-2 text-center" title="Sheets per unit × units — what the BOM allowed for the job">BOM allows</th>
            <th className="p-2 text-center" title="What the BOM allowed − what was used. Red = ate more than the BOM allows">Difference</th>
            <th className="p-2">Notes</th>
            <th className="p-2 no-print" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <LineRow key={l.id} line={l} boms={boms} orders={orders} canEdit={canEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- purchasing totals ----

function TotalsTable({ totals }: { totals: MaterialTotal[] }) {
  if (totals.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 text-left">
            <th className="p-2">Material</th>
            <th className="p-2 text-center">Thk (mm)</th>
            <th className="p-2 text-center">Sheet size</th>
            <th className="p-2 text-center">Sheets used</th>
            <th className="p-2 text-center">BOM allows</th>
            <th className="p-2 text-center">Lines with no BOM figure</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={`${t.material}|${t.thicknessMm}|${t.sheetSize}`} className="border-t">
              <td className="p-2 font-semibold">{t.material}</td>
              <td className="p-2 text-center tabnum ltr">{t.thicknessMm}</td>
              <td className="p-2 text-center tabnum ltr">{t.sheetSize}</td>
              <td className="p-2 text-center font-bold">
                <Sheets v={t.used} />
              </td>
              <td className="p-2 text-center text-muted">
                <Sheets v={t.allowed} />
              </td>
              <td className="p-2 text-center text-xs text-muted">
                {t.linesWithoutBom > 0 ? `${t.linesWithoutBom} — “BOM allows” excludes them` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- add ----

// Typing is the only way material gets in here, and a BOM is never one line:
// the sheet runs five to seven thicknesses under the same BOM, order and sheet
// size. So a successful add clears ONLY the columns that change from line to
// line and puts the cursor back on the material — the repeated columns stay.
const REPEATED_FIELDS = ["material", "thicknessMm", "sheetsPerUnit", "sheetsUsed", "note"] as const;

function AddLine({
  boms,
  orders,
  lockedBom,
  startOpen,
}: {
  boms: string[];
  orders: MaterialOrderRef[];
  lockedBom?: string;
  /** Nothing recorded yet — the form is the page, so it opens itself. */
  startOpen: boolean;
}) {
  const add = useAction();
  const [open, setOpen] = useState(startOpen);

  function clearForNextLine(form: HTMLFormElement) {
    for (const name of REPEATED_FIELDS) {
      const el = form.elements.namedItem(name);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    const first = form.elements.namedItem("material");
    if (first instanceof HTMLInputElement) first.focus();
  }

  return (
    <div className="border rounded-xl p-4">
      <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
        {open ? "Close" : "➕ Add a material line"}
      </button>
      {open && (
        <form
          className="mt-3 space-y-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            add.run(createMaterialLine, new FormData(form), "Added — next line.", () => clearForNextLine(form));
          }}
        >
          <LineFields boms={boms} orders={orders} lockedBom={lockedBom} disabled={add.pending} />
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={add.pending}>
              Add
            </button>
            <Msg msg={add.msg} />
          </div>
        </form>
      )}
    </div>
  );
}

// ---- the page body ----

export function MaterialClient({
  lines,
  totals,
  orders,
  boms,
  bom,
  canEdit,
}: {
  lines: MaterialLineView[];
  totals: MaterialTotal[];
  orders: MaterialOrderRef[];
  boms: string[];
  bom: string;
  canEdit: boolean;
}) {
  return (
    <div className="space-y-6">
      <section className="bg-surface border rounded-xl overflow-hidden">
        <LinesTable lines={lines} boms={boms} orders={orders} canEdit={canEdit} />
      </section>

      {canEdit && (
        <section className="space-y-3">
          <AddLine boms={boms} orders={orders} lockedBom={bom || undefined} startOpen={lines.length === 0} />
        </section>
      )}

      {totals.length > 0 && (
        <section>
          <h2 className="font-bold mb-2">
            Material used {bom ? `on ${bom}` : "across every BOM"} — per material, thickness and size
          </h2>
          <div className="bg-surface border rounded-xl overflow-hidden">
            <TotalsTable totals={totals} />
          </div>
        </section>
      )}
    </div>
  );
}
