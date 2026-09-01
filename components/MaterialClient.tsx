"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { MATERIAL_PRESETS, SHEET_SIZE_PRESETS, type MaterialLineView, type MaterialTotal } from "@/lib/domain/material";
import type { MaterialOrderRef } from "@/lib/server/material";
import {
  createMaterialLine,
  updateMaterialLine,
  setSheetsUsed,
  deleteMaterialLine,
  copyMaterialFromBom,
  importMaterialAction,
} from "@/app/material/actions";

// The MATERIAL tab — the planner's Nesting Tracker, live.
//
// One line per BOM (× order) × material × thickness × sheet size. The two
// numbers a person types are "sheets ONE unit needs" (engineering) and "sheets
// actually nested" (the nester, per job); everything else on the row is
// computed, so nothing here can disagree with the orders registry.

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
        <span className="text-xs font-bold text-muted" title="From the nesting BOM — sheets ONE unit eats">
          Sheets per unit
        </span>
        <input
          name="sheetsPerUnit"
          type="number"
          step="0.0001"
          min="0"
          defaultValue={line?.sheetsPerUnit ?? ""}
          required
          disabled={disabled}
          placeholder="0.429"
          className={`${inputCls} ltr tabnum`}
        />
      </label>

      <label className="block">
        <span className="text-xs font-bold text-muted" title="Leave empty until the job is actually laid out">
          Sheets actually nested
        </span>
        <input
          name="sheetsUsed"
          type="number"
          step="0.01"
          min="0"
          defaultValue={line?.sheetsUsed ?? ""}
          disabled={disabled}
          placeholder="—"
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
  const [usedDraft, setUsedDraft] = useState(line.sheetsUsed === null ? "" : String(line.sheetsUsed));

  function saveUsed() {
    const current = line.sheetsUsed === null ? "" : String(line.sheetsUsed);
    if (usedDraft.trim() === current) return; // nothing typed — no write, no toast
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
          <Sheets v={line.sheetsPerUnit} />
        </td>
        <td className="p-2 text-center">
          <span className="tabnum ltr">{line.units}</span>
          {!line.unitsFromRegistry && (
            <span className="pill pill-warn ml-1" title="Typed by hand — the orders registry does not carry this BOM">
              manual
            </span>
          )}
        </td>
        <td className="p-2 text-center font-bold">
          <Sheets v={line.required} />
        </td>
        <td className="p-2 text-center">
          {canEdit ? (
            <input
              type="number"
              step="0.01"
              min="0"
              value={usedDraft}
              disabled={used.pending}
              onChange={(e) => setUsedDraft(e.target.value)}
              onBlur={saveUsed}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="—"
              title="Sheets actually nested for this job — leave empty until it is laid out"
              className={cellInput}
            />
          ) : (
            <Sheets v={line.sheetsUsed} />
          )}
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
        No material recorded yet. Add a line below — or import the Nesting Tracker workbook and the whole sheet lands here.
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
            <th className="p-2 text-center" title="From the nesting BOM">Sheets / unit</th>
            <th className="p-2 text-center" title="Quantity of units, live from the orders registry">Units</th>
            <th className="p-2 text-center" title="Sheets per unit × units">Sheets for job</th>
            <th className="p-2 text-center" title="What the nester actually laid out">Actual nested</th>
            <th className="p-2 text-center" title="Sheets for job − actual nested. Red = more sheets used than the BOM allows">Difference</th>
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
            <th className="p-2 text-center">Sheets required</th>
            <th className="p-2 text-center">Sheets nested</th>
            <th className="p-2 text-center">Still to nest</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={`${t.material}|${t.thicknessMm}|${t.sheetSize}`} className="border-t">
              <td className="p-2 font-semibold">{t.material}</td>
              <td className="p-2 text-center tabnum ltr">{t.thicknessMm}</td>
              <td className="p-2 text-center tabnum ltr">{t.sheetSize}</td>
              <td className="p-2 text-center font-bold">
                <Sheets v={t.required} />
              </td>
              <td className="p-2 text-center">
                <Sheets v={t.used} />
              </td>
              <td className="p-2 text-center text-xs text-muted">
                {t.pendingLines > 0 ? `${t.pendingLines} line(s) not nested yet` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- add / copy / import ----

function AddLine({ boms, orders, lockedBom }: { boms: string[]; orders: MaterialOrderRef[]; lockedBom?: string }) {
  const add = useAction();
  const [open, setOpen] = useState(false);
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
            add.run(createMaterialLine, new FormData(form), "Added.", () => form.reset());
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

function CopyFromBom({ boms, toBom }: { boms: string[]; toBom: string }) {
  const copy = useAction();
  return (
    <form
      className="border rounded-xl p-4 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("toBom", toBom);
        copy.run(copyMaterialFromBom, fd, `Copied onto ${toBom}.`);
      }}
    >
      <label className="block">
        <span className="text-xs font-bold text-muted">Copy the material lines of</span>
        <select name="fromBom" required className={`${inputCls} ltr min-w-[200px]`}>
          <option value="">Pick a BOM…</option>
          {boms.filter((b) => b !== toBom).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <span className="text-sm font-semibold pb-2">
        onto <b className="ltr">{toBom}</b>
      </span>
      <button type="submit" className="btn btn-secondary btn-sm mb-1" disabled={copy.pending}>
        Copy
      </button>
      <p className="w-full text-xs text-muted">
        Family variants share one nesting BOM — this copies the sheets-per-unit lines only, never another job&apos;s actual nesting.
      </p>
      <Msg msg={copy.msg} />
    </form>
  );
}

function ImportPanel() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  function submit(form: HTMLFormElement, preview: boolean) {
    const fd = new FormData(form);
    fd.set("preview", String(preview));
    startTransition(async () => {
      const r = await importMaterialAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) {
        setRes({ ok: false, text: r.error ?? "Import failed." });
        return;
      }
      setRes({
        ok: true,
        text: preview
          ? `Preview only — nothing saved: ${r.added} new line(s), ${r.updated} would be updated.`
          : `Imported: ${r.added} new line(s), ${r.updated} updated.`,
      });
      if (!preview) router.refresh();
    });
  }

  return (
    <form className="border rounded-xl p-4 space-y-3" onSubmit={(e) => e.preventDefault()}>
      <p className="text-sm font-bold">Import the Nesting Tracker workbook</p>
      <p className="text-xs text-muted">
        Columns are matched by their header text (BOM Ref, Material Type, Thickness, Sheet Size, sheets for one unit, actual
        nesting, Notes). The sheet&apos;s own &quot;for Job&quot; and &quot;Difference&quot; columns are ignored — this tab
        recomputes them. Re-importing a corrected sheet updates the same lines instead of duplicating them.
      </p>
      <input type="file" name="file" accept=".xlsx,.xlsm,.xls" required className="text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={(e) => submit(e.currentTarget.form!, true)}
        >
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending}
          onClick={(e) => submit(e.currentTarget.form!, false)}
        >
          Import
        </button>
        <Msg msg={res} />
      </div>
      {issues.length > 0 && (
        <ul className="text-xs text-warn-fg list-disc ps-5 space-y-0.5 max-h-40 overflow-y-auto">
          {issues.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      )}
    </form>
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
          <AddLine boms={boms} orders={orders} lockedBom={bom || undefined} />
          {bom && <CopyFromBom boms={boms} toBom={bom} />}
        </section>
      )}

      {totals.length > 0 && (
        <section>
          <h2 className="font-bold mb-2">
            Material needed {bom ? `for ${bom}` : "across every BOM"} — per material, thickness and size
          </h2>
          <div className="bg-surface border rounded-xl overflow-hidden">
            <TotalsTable totals={totals} />
          </div>
        </section>
      )}

      {canEdit && (
        <section className="no-print">
          <ImportPanel />
        </section>
      )}
    </div>
  );
}
