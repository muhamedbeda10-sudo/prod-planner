"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { ODOO_PRODUCTS, ODOO_STATUSES, type OdooEntryView, type OdooReasonView } from "@/lib/domain/odoo";
import { Soi } from "@/components/ui";
import { createOdooEntry, updateOdooEntry, deleteOdooEntry, importOdooAction, setOdooReason } from "@/app/odoo/actions";

// The ODOO tab — the office's daily log of Odoo close attempts, one strip per
// row, exactly the columns of the sheet it replaces: Date · SOI# · FG-CODE ·
// Product · MO# · QTY · Status · Reason.

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
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>;
}

// ---- day picker (drives ?day=; today by default, "all" for the whole log) ----

function shiftISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function OdooDayPicker({ day, days }: { day: string; days: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (v: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("day", v);
    router.push(`${pathname}?${p}`);
  };
  const isAll = day === "all";
  return (
    <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
      <button type="button" className="btn btn-sm" disabled={isAll} onClick={() => go(shiftISO(day, -1))} title="Previous day">
        ‹
      </button>
      <input
        type="date"
        aria-label="Day"
        value={isAll ? "" : day}
        onChange={(e) => e.target.value && go(e.target.value)}
        className="border rounded-md px-2 py-1.5 bg-surface font-bold ltr tabnum"
      />
      <button type="button" className="btn btn-sm" disabled={isAll} onClick={() => go(shiftISO(day, 1))} title="Next day">
        ›
      </button>
      <select
        aria-label="Jump to a day"
        className="border rounded-md px-2 py-1.5 bg-surface font-bold ltr"
        value={isAll ? "all" : days.includes(day) ? day : ""}
        onChange={(e) => e.target.value && go(e.target.value)}
      >
        <option value="">Jump…</option>
        <option value="all">All days</option>
        {days.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---- the row form: one strip, the sheet's columns in the sheet's order ----

const F = "px-2 py-1.5 text-sm font-semibold";

function Field({ hint, className = "", children }: { hint: string; className?: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex flex-col ${className}`} title={hint}>
      {children}
    </span>
  );
}

function RowFields({
  e,
  day,
  knownSois,
  knownFgCodes,
  disabled,
}: {
  e?: OdooEntryView;
  day: string;
  knownSois: string[];
  knownFgCodes: string[];
  disabled?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Field hint="Date of the close attempt" className="w-[8.5rem]">
        <input name="date" type="date" aria-label="Date" defaultValue={e?.dateISO ?? (day === "all" ? today : day)} required disabled={disabled} className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="SOI#" className="w-28">
        <input name="soi" list="odoo-sois" aria-label="SOI" defaultValue={e?.soi ?? ""} disabled={disabled} placeholder="SOI#" className={`${F} ltr w-full`} />
        <datalist id="odoo-sois">{knownSois.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="FG-CODE — Odoo's finished-good code" className="w-48">
        <input name="fgCode" list="odoo-fg" aria-label="FG-CODE" defaultValue={e?.fgCode ?? ""} required disabled={disabled} placeholder="FG-CODE" className={`${F} ltr w-full`} />
        <datalist id="odoo-fg">{knownFgCodes.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="Product" className="w-32">
        <input name="product" list="odoo-products" aria-label="Product" defaultValue={e?.product ?? ""} required disabled={disabled} placeholder="Product" className={`${F} w-full`} />
        <datalist id="odoo-products">{ODOO_PRODUCTS.map((p) => <option key={p} value={p} />)}</datalist>
      </Field>
      <Field hint="Odoo MO number (SF01/MO/…)" className="w-44">
        <input name="odooMo" aria-label="MO#" defaultValue={e?.odooMo ?? ""} required disabled={disabled} placeholder="SF01/MO/…" className={`${F} ltr w-full`} />
      </Field>
      <Field hint="Quantity" className="w-20">
        <input name="qty" type="number" step="1" min="0" aria-label="QTY" defaultValue={e?.qty ?? ""} required disabled={disabled} placeholder="QTY" className={`${F} ltr tabnum w-full font-extrabold`} />
      </Field>
      <Field hint="Status" className="w-40">
        <input name="status" list="odoo-statuses" aria-label="Status" defaultValue={e?.status ?? "MO to be close"} disabled={disabled} className={`${F} w-full`} />
        <datalist id="odoo-statuses">{ODOO_STATUSES.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="Reason — 'Done', or the error Odoo returned (paste it whole)" className="flex-1 min-w-[16rem]">
        <input name="reason" aria-label="Reason" defaultValue={e?.reason ?? ""} disabled={disabled} placeholder="Done / Odoo error…" className={`${F} w-full`} />
      </Field>
    </>
  );
}

// the columns that change from row to row on the same day; date stays
const PER_ROW = ["soi", "fgCode", "product", "odooMo", "qty", "reason"] as const;

function AddRow({ day, knownSois, knownFgCodes, startOpen }: { day: string; knownSois: string[]; knownFgCodes: string[]; startOpen: boolean }) {
  const add = useAction();
  const [open, setOpen] = useState(startOpen);
  function clearForNext(form: HTMLFormElement) {
    for (const n of PER_ROW) {
      const el = form.elements.namedItem(n);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    const first = form.elements.namedItem("soi");
    if (first instanceof HTMLInputElement) first.focus();
  }
  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        ➕ Add a row
      </button>
    );
  }
  return (
    <form
      className="border rounded-xl p-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        const form = ev.currentTarget;
        add.run(createOdooEntry, new FormData(form), "Added — next row.", () => clearForNext(form));
      }}
    >
      <div className="flex flex-wrap items-stretch gap-1.5">
        <RowFields day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} disabled={add.pending} />
        <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={add.pending}>Add</button>
        <button type="button" className="btn btn-sm btn-ghost shrink-0" onClick={() => setOpen(false)}>✕</button>
      </div>
      <Msg msg={add.msg} />
    </form>
  );
}

// ---- the Reason cell: the current value, editable in place, with every
// earlier value the row held cascading beneath it ----

function ReasonText({ reason, done, blockedItem, muted }: { reason: string | null; done: boolean; blockedItem: string | null; muted?: boolean }) {
  if (done) return <span className="pill pill-ok">Done</span>;
  if (!reason) return <span className="text-muted">—</span>;
  return (
    <span title={reason}>
      {blockedItem && <span className="pill pill-bad ltr mr-1">{blockedItem}</span>}
      <span className={muted ? "text-muted" : ""}>{reason}</span>
    </span>
  );
}

function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function EarlierReasons({ items }: { items: OdooReasonView[] }) {
  if (items.length === 0) return null;
  return (
    <details className="soi-cascade mt-1 text-xs" title="What this column said before — click to open">
      <summary className="cursor-pointer select-none text-muted">
        <span className="pill pill-muted">🕘 {items.length} earlier</span>
      </summary>
      <ol className="mt-1 space-y-1 border-s-2 border-border ps-2">
        {items.map((h, i) => (
          <li key={i}>
            <span className="tabnum ltr text-[11px] text-muted" suppressHydrationWarning>{stamp(h.atISO)}</span>
            {h.by && <span className="text-[11px] text-muted"> · {h.by}</span>}
            <div><ReasonText reason={h.reason} done={h.done} blockedItem={h.blockedItem} muted /></div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ReasonCell({ e, canEdit }: { e: OdooEntryView; canEdit: boolean }) {
  const a = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(e.reason ?? "");
  function save() {
    setEditing(false);
    if (draft.trim() === (e.reason ?? "").trim()) return;
    const fd = new FormData();
    fd.set("id", String(e.id));
    fd.set("reason", draft.trim());
    a.run(setOdooReason, fd, "Saved.");
  }
  return (
    <div className="flex flex-col">
      {canEdit && editing ? (
        <input
          autoFocus
          value={draft}
          disabled={a.pending}
          onChange={(ev) => setDraft(ev.target.value)}
          onBlur={save}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") ev.currentTarget.blur();
            if (ev.key === "Escape") { setDraft(e.reason ?? ""); setEditing(false); }
          }}
          placeholder="Done / Odoo error…"
          className="px-2 py-1 text-xs font-semibold w-full"
        />
      ) : (
        <span
          className={canEdit ? "cursor-text rounded px-1 -mx-1 hover:bg-surface-2" : ""}
          title={canEdit ? "Click to change the reason — the old one is kept in the history" : undefined}
          onClick={canEdit ? () => { setDraft(e.reason ?? ""); setEditing(true); } : undefined}
        >
          <ReasonText reason={e.reason} done={e.done} blockedItem={e.blockedItem} />
        </span>
      )}
      {a.msg?.ok === false && <span className="text-[10px] text-bad-fg">{a.msg.text}</span>}
      <EarlierReasons items={e.earlierReasons} />
    </div>
  );
}

function Row({ e, day, knownSois, knownFgCodes, canEdit }: { e: OdooEntryView; day: string; knownSois: string[]; knownFgCodes: string[]; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
  return (
    <>
      <tr className="border-t">
        <td className="p-2 whitespace-nowrap tabnum ltr">{e.dateISO}</td>
        <td className="p-2 whitespace-nowrap"><Soi soi={e.soi} /></td>
        <td className="p-2 whitespace-nowrap ltr text-xs font-semibold">{e.fgCode}</td>
        <td className="p-2 whitespace-nowrap">{e.product}</td>
        <td className="p-2 whitespace-nowrap ltr text-xs font-bold">{e.odooMo}</td>
        <td className="p-2 text-center tabnum font-extrabold">{e.qty}</td>
        <td className="p-2 whitespace-nowrap text-xs">{e.status}</td>
        <td className="p-2 text-xs max-w-[28rem] align-top">
          <ReasonCell e={e} canEdit={canEdit} />
        </td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          {canEdit ? (
            <span className="inline-flex gap-1">
              <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={del.pending}
                onClick={() => {
                  if (!confirm(`Delete ${e.odooMo} (${e.dateISO})?`)) return;
                  const fd = new FormData();
                  fd.set("id", String(e.id));
                  del.run(deleteOdooEntry, fd, "Deleted.");
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
      {(editing || del.msg?.ok === false) && (
        <tr className="border-t-0">
          <td colSpan={9} className="px-2 pb-3">
            <Msg msg={del.msg?.ok === false ? del.msg : null} />
            {editing && (
              <form
                className="mt-2 border rounded-xl p-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  const fd = new FormData(ev.currentTarget);
                  fd.set("id", String(e.id));
                  edit.run(updateOdooEntry, fd, "Saved.", () => setEditing(false));
                }}
              >
                <div className="flex flex-wrap items-stretch gap-1.5">
                  <RowFields e={e} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} disabled={edit.pending} />
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

// ---- import: the sheet, once — its first seven columns ----

function ImportPanel({ day }: { day: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  function submit(form: HTMLFormElement, preview: boolean) {
    const fd = new FormData(form);
    fd.set("preview", String(preview));
    fd.set("day", day === "all" ? "" : day);
    startTransition(async () => {
      const r = await importOdooAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) { setRes({ ok: false, text: r.error ?? "Import failed." }); return; }
      const tail = `${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged`;
      setRes({ ok: true, text: preview ? `Preview only — nothing saved: ${tail}.` : `Imported: ${tail}.` });
      if (!preview) router.refresh();
    });
  }
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>📥 Import Excel</button>;
  return (
    <form className="border rounded-xl p-3 space-y-2" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-bold text-muted">Excel file</span>
          <input type="file" name="file" accept=".xlsx,.xlsm,.xls,.csv" required className="block text-sm" />
        </label>
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, true)}>Preview</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, false)}>Import</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>✕</button>
      </div>
      <p className="text-xs text-muted">
        Reads the sheet&apos;s first seven columns — Date · SOI# · FG-CODE · Product · MO# · QTY · Status. Reason is not
        read: it stays as typed here. The same MO on the same day is updated, never doubled
        {day !== "all" ? `; rows with a blank Date are filed under ${day}` : ""}.
      </p>
      <Msg msg={res} />
      {issues.length > 0 && (
        <ul className="text-xs text-warn-fg list-disc ps-5 space-y-0.5 max-h-40 overflow-y-auto">{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
      )}
    </form>
  );
}

export function OdooClient({
  entries,
  day,
  knownSois,
  knownFgCodes,
  canEdit,
}: {
  entries: OdooEntryView[];
  day: string;
  knownSois: string[];
  knownFgCodes: string[];
  canEdit: boolean;
}) {
  const done = entries.filter((e) => e.done).length;
  return (
    <div className="space-y-5">
      {entries.length > 0 && (
        <div className="text-sm text-muted">
          {entries.length} row(s){day !== "all" ? ` on ${day}` : ""} · <span className="text-ok-fg font-bold">{done} done</span> ·{" "}
          <span className="text-bad-fg font-bold">{entries.length - done} not closed</span>
        </div>
      )}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {entries.length === 0 ? (
          <p className="text-sm text-muted p-4">
            {day === "all" ? "No rows logged yet." : `Nothing logged on ${day}. Add the day's rows below, or import the sheet.`}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-brand text-white text-left">
                  <th className="p-2">Date</th>
                  <th className="p-2">SOI#</th>
                  <th className="p-2">FG-CODE</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">MO#</th>
                  <th className="p-2 text-center">QTY</th>
                  <th className="p-2">Status</th>
                  <th className="p-2" title="The latest reason; earlier ones cascade beneath it">Reason</th>
                  <th className="p-2 no-print" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Row key={e.id} e={e} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} canEdit={canEdit} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {canEdit && (
        <div className="space-y-3">
          <AddRow day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} startOpen={entries.length === 0} />
          <ImportPanel day={day} />
        </div>
      )}
    </div>
  );
}
