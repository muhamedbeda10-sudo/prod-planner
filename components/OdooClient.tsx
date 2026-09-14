"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  ODOO_PRODUCTS, ODOO_STATUSES, ODOO_NOTE_FILTERS, ODOO_MO_FILTERS, ODOO_CLOSED_FILTERS, EMPTY_ODOO_FILTERS, filterOdooEntries,
  type OdooEntryView, type OdooNoteView, type OdooTone, type OdooFilters, type OdooNoteFilter, type OdooMoFilter, type OdooClosedFilter,
} from "@/lib/domain/odoo";
import { sourceLabel } from "@/lib/domain/odooMirror";
import { Soi } from "@/components/ui";
import { OdooMaterialPopup } from "@/components/OdooMaterialPopup";
import { materialNeed, monthLabelOfISO, type NestingLookup } from "@/lib/domain/odooMaterial";
import { parseSaved, savedString, useStoredFilters } from "@/components/useStoredFilters";
import { createOdooEntry, updateOdooEntry, deleteOdooEntry, importOdooAction, setOdooStatus, setOdooMo, setOdooFgCode, addOdooNote, deleteOdooNote } from "@/app/odoo/actions";

// The ODOO tab — the office's daily log of Odoo close attempts, one strip per
// row, the columns of the sheet it replaces: Date · SOI# · FG-CODE · Product ·
// MO# · QTY · Status. Two people work a row: the clerk enters it, the planner
// moves the Status in place and keeps Notes on it — a list, each deletable.
// A row can also be BORN here: a painting record (or the core's shot blast)
// writes its own row with everything but Odoo's MO, which the clerk types in
// place — and an FG-CODE the app had to compose is flagged until it is looked at.

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

/** The day to come back to when leaving the all-days view. */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
        value={isAll ? "" : days.includes(day) ? day : ""}
        onChange={(e) => e.target.value && go(e.target.value)}
      >
        <option value="">Jump…</option>
        {days.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      {/* The tab opens on ONE day, which is how a row logged last week reads as
          lost. This is the way back to the whole log, in the open, not buried
          in a dropdown — and it is where the search reaches every day. */}
      <button
        type="button"
        className={`btn btn-sm ${isAll ? "btn-primary" : "btn-ghost"}`}
        onClick={() => go(isAll ? todayISO() : "all")}
        title={isAll ? "Back to a single day" : "Show every row ever logged — the search then covers them all"}
      >
        {isAll ? "✕ All days" : "All days"}
      </button>
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
  const born = isBorn(e);
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
        <input name="fgCode" list="odoo-fg" aria-label="FG-CODE" defaultValue={e?.fgCode ?? ""} required={!born} disabled={disabled} placeholder="FG-CODE" className={`${F} ltr w-full`} />
        <datalist id="odoo-fg">{knownFgCodes.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="Product" className="w-32">
        <input name="product" list="odoo-products" aria-label="Product" defaultValue={e?.product ?? ""} required disabled={disabled} placeholder="Product" className={`${F} w-full`} />
        <datalist id="odoo-products">{ODOO_PRODUCTS.map((p) => <option key={p} value={p} />)}</datalist>
      </Field>
      <Field hint="Odoo MO number (SF01/MO/…)" className="w-44">
        <input name="odooMo" aria-label="MO#" defaultValue={e?.odooMo ?? ""} required={!born} disabled={disabled} placeholder="SF01/MO/…" className={`${F} ltr w-full`} />
      </Field>
      <Field hint="Quantity" className="w-20">
        <input name="qty" type="number" step="1" min="0" aria-label="QTY" defaultValue={e?.qty ?? ""} required disabled={disabled} placeholder="QTY" className={`${F} ltr tabnum w-full font-extrabold`} />
      </Field>
      <Field hint="Status" className="w-40">
        <select name="status" aria-label="Status" defaultValue={e?.status ?? "MO to be close"} disabled={disabled} className={`${F} w-full`}>
          {statusOptions(e?.status).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
    </>
  );
}

// the columns that change from row to row on the same day; date stays
const PER_ROW = ["soi", "fgCode", "product", "odooMo", "qty"] as const;

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

// ---- Status: the planner's column, moved in place ----

/** The dropdown's choices, plus whatever the row already says if it is not one of them. */
function statusOptions(current?: string | null): string[] {
  const cur = (current ?? "").trim();
  return cur && !(ODOO_STATUSES as readonly string[]).includes(cur) ? [...ODOO_STATUSES, cur] : [...ODOO_STATUSES];
}

const TONE_PILL: Record<OdooTone, string> = { ok: "pill-ok", warn: "pill-warn", bad: "pill-bad", muted: "pill-muted" };

/** A row born from a closing in the ledger, not typed or imported. */
function isBorn(e?: OdooEntryView | null): boolean {
  return e?.source === "painting" || e?.source === "shotblast";
}

/** One value typed straight into the row and saved on Enter or blur — Odoo's
 *  MO on a born row, or a guessed FG-CODE the office confirms or corrects. */
function InlineValue({ id, name, value, placeholder, action, warn, hint, list }: {
  id: number; name: "odooMo" | "fgCode"; value: string; placeholder: string; warn: boolean; hint: string; list?: string;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const a = useAction();
  const [draft, setDraft] = useState(value);
  function submit() {
    const v = draft.trim();
    if (v === value.trim()) return;
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set(name, v);
    a.run(action, fd, "Saved.");
  }
  return (
    <span className="inline-flex flex-col">
      <input
        value={draft}
        list={list}
        disabled={a.pending}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } }}
        onBlur={submit}
        onClick={(ev) => ev.stopPropagation()}
        placeholder={placeholder}
        title={hint}
        aria-label={name === "odooMo" ? "MO#" : "FG-CODE"}
        className={`px-2 py-1 text-xs ltr font-bold no-print ${name === "fgCode" ? "w-48" : "w-40"} ${warn ? "border-warn-fg bg-warn-bg/60" : ""}`}
      />
      {a.msg?.ok === false && <span className="text-[10px] text-bad-fg">{a.msg.text}</span>}
    </span>
  );
}

function DoneStamp({ e }: { e: OdooEntryView }) {
  if (!e.done || !e.doneAtISO) return null;
  return (
    <span className="text-[10px] text-muted tabnum ltr" title="When the status was moved to Done — the day the dashboard counts the close on" suppressHydrationWarning>
      closed {stamp(e.doneAtISO)}
    </span>
  );
}

function StatusCell({ e, canEdit }: { e: OdooEntryView; canEdit: boolean }) {
  const a = useAction();
  if (!canEdit) {
    return (
      <span className="inline-flex flex-col">
        <span className={`pill ${TONE_PILL[e.tone]}`}>{e.status}</span>
        <DoneStamp e={e} />
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col">
      <select
        aria-label="Status"
        value={e.status}
        disabled={a.pending}
        title="Move the status — saves at once"
        className={`pill ${TONE_PILL[e.tone]} cursor-pointer pe-5 font-semibold`}
        onChange={(ev) => {
          const fd = new FormData();
          fd.set("id", String(e.id));
          fd.set("status", ev.target.value);
          a.run(setOdooStatus, fd, "Saved.");
        }}
      >
        {statusOptions(e.status).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <DoneStamp e={e} />
      {a.msg?.ok === false && <span className="text-[10px] text-bad-fg">{a.msg.text}</span>}
    </span>
  );
}

// ---- Notes: a list per row, newest first, each deletable; add one below ----

function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Note({ n, canEdit }: { n: OdooNoteView; canEdit: boolean }) {
  const del = useAction();
  return (
    <li className="group flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <div title={n.text}>
          {n.blockedItem && <span className="pill pill-bad ltr mr-1">{n.blockedItem}</span>}
          <span className="whitespace-pre-wrap break-words">{n.text}</span>
        </div>
        <div className="text-[11px] text-muted">
          <span className="tabnum ltr" suppressHydrationWarning>{stamp(n.atISO)}</span>
          {n.by && <span> · {n.by}</span>}
        </div>
        {del.msg?.ok === false && <span className="text-[10px] text-bad-fg">{del.msg.text}</span>}
      </div>
      {canEdit && (
        <button
          type="button"
          className="btn btn-sm btn-ghost text-bad-fg shrink-0 opacity-40 group-hover:opacity-100 no-print"
          title="Delete this note"
          disabled={del.pending}
          onClick={() => {
            if (!confirm("Delete this note?")) return;
            const fd = new FormData();
            fd.set("noteId", String(n.id));
            del.run(deleteOdooNote, fd, "Deleted.");
          }}
        >
          ✕
        </button>
      )}
    </li>
  );
}

function NotesCell({ e, canEdit }: { e: OdooEntryView; canEdit: boolean }) {
  const add = useAction();
  const [draft, setDraft] = useState("");
  function submit() {
    const body = draft.trim();
    if (!body) return;
    const fd = new FormData();
    fd.set("id", String(e.id));
    fd.set("text", body);
    add.run(addOdooNote, fd, "Added.", () => setDraft(""));
  }
  return (
    <div className="flex flex-col gap-1">
      {e.notes.length > 0 && (
        <ul className="space-y-1.5">
          {e.notes.map((n) => <Note key={n.id} n={n} canEdit={canEdit} />)}
        </ul>
      )}
      {e.notes.length === 0 && !canEdit && <span className="text-muted">—</span>}
      {canEdit && (
        <input
          value={draft}
          disabled={add.pending}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } }}
          onBlur={submit}
          placeholder={e.notes.length === 0 ? "Add a note… (Enter)" : "Another note… (Enter)"}
          title="Type a note and press Enter — it is kept with the time and your name"
          className="px-2 py-1 text-xs w-full no-print"
        />
      )}
      {add.msg?.ok === false && <span className="text-[10px] text-bad-fg">{add.msg.text}</span>}
    </div>
  );
}

function Row({ e, day, knownSois, knownFgCodes, nesting, soiBoms, canEdit }: {
  e: OdooEntryView; day: string; knownSois: string[]; knownFgCodes: string[]; nesting: NestingLookup; soiBoms: string[]; canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [material, setMaterial] = useState(false);
  const edit = useAction();
  const del = useAction();
  // the row's material, as a hint on the button — none when the tracker has
  // no lines for this part on this BOM
  const need = useMemo(() => materialNeed(nesting, e.fgCode, e.qty, monthLabelOfISO(e.dateISO), soiBoms), [nesting, e.fgCode, e.qty, e.dateISO, soiBoms]);
  const closeMaterial = useCallback(() => setMaterial(false), []);
  // clicking the row's plain cells opens its material; the status and notes
  // cells keep their own controls
  const cell = "p-2 whitespace-nowrap cursor-pointer";
  const open = () => setMaterial(true);
  const rowTitle = need ? `Click for the material behind ${e.qty} units` : "Click — no nesting lines for this FG-CODE yet";
  const born = isBorn(e);
  return (
    <>
      <tr className="border-t hover:bg-surface-2/60">
        <td className={`${cell} tabnum ltr`} onClick={open} title={rowTitle}>
          <span className="inline-flex flex-col">
            {e.dateISO}
            {born && <span className="pill pill-muted text-[10px] mt-0.5" title="Written by the closing recorded in the daily log — the office fills in Odoo's MO">{sourceLabel(e.source)}</span>}
          </span>
        </td>
        <td className={cell} onClick={open} title={rowTitle}><Soi soi={e.soi} /></td>
        <td className={`${cell} ltr text-xs font-semibold`} onClick={e.fgGuessed && canEdit ? undefined : open} title={e.fgGuessed ? "Composed from the part code and the transformer's BOM — no earlier row of this SOI and product to copy from. Confirm or correct it." : rowTitle}>
          {e.fgGuessed && canEdit ? (
            <InlineValue id={e.id} name="fgCode" value={e.fgCode} placeholder="FG-CODE" action={setOdooFgCode} warn list="odoo-fg" hint="Guessed FG-CODE — Enter keeps it, or type the right one" />
          ) : (
            <span className="inline-flex flex-col">
              {e.fgCode || <span className="text-muted">—</span>}
              {e.fgGuessed && <span className="pill pill-warn text-[10px] mt-0.5">check FG-CODE</span>}
            </span>
          )}
        </td>
        <td className={cell} onClick={open} title={rowTitle}>{e.product}</td>
        <td className={`${cell} ltr text-xs font-bold`} onClick={!e.odooMo && canEdit ? undefined : open} title={e.odooMo ? rowTitle : "Odoo's MO is not known here — type it once the MO is printed from Odoo"}>
          {e.odooMo ? e.odooMo : canEdit ? (
            <InlineValue id={e.id} name="odooMo" value="" placeholder="SF01/MO/… (Enter)" action={setOdooMo} warn={false} hint="Type Odoo's MO number for this closing — Enter saves" />
          ) : (
            <span className="pill pill-warn text-[10px]">needs MO</span>
          )}
        </td>
        <td className="p-2 text-center tabnum font-extrabold cursor-pointer" onClick={open} title={rowTitle}>{e.qty}</td>
        <td className="p-2 whitespace-nowrap text-xs align-top"><StatusCell e={e} canEdit={canEdit} /></td>
        <td className="p-2 text-xs min-w-[18rem] max-w-[28rem] align-top">
          <NotesCell e={e} canEdit={canEdit} />
        </td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          <span className="inline-flex gap-1">
            <button
              type="button"
              className={`btn btn-sm ${need ? "btn-secondary" : "btn-ghost"}`}
              title={need ? `Material for ${e.qty} units: ${need.lines.length} line(s), ${need.totalActual || need.totalBom} sheets` : "No nesting lines for this FG-CODE yet"}
              onClick={open}
            >
              🧱{need ? <span className="tabnum ms-1">{need.totalActual || need.totalBom}</span> : null}
            </button>
          {canEdit && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={del.pending}
                onClick={() => {
                  if (!confirm(`Delete ${e.odooMo || `${e.product} ×${e.qty}`} (${e.dateISO})?`)) return;
                  const fd = new FormData();
                  fd.set("id", String(e.id));
                  del.run(deleteOdooEntry, fd, "Deleted.");
                }}
              >
                Delete
              </button>
            </>
          )}
          </span>
        </td>
      </tr>
      {material && <OdooMaterialPopup e={e} nesting={nesting} soiBoms={soiBoms} onClose={closeMaterial} />}
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
        Reads the sheet&apos;s first seven columns — Date · SOI# · FG-CODE · Product · MO# · QTY · Status. Notes are
        never read. The same MO on the same day is updated, never doubled, and its Status stays as moved here
        {day !== "all" ? `; rows with a blank Date are filed under ${day}` : ""}.
      </p>
      <Msg msg={res} />
      {issues.length > 0 && (
        <ul className="text-xs text-warn-fg list-disc ps-5 space-y-0.5 max-h-40 overflow-y-auto">{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
      )}
    </form>
  );
}

// ---- filters: one row above the table, kept between visits ----

const FILTERS_KEY = "odoo:filters";
const NO_BOMS: string[] = [];
const SEL = "border rounded-md px-2 py-1.5 bg-surface text-sm font-semibold";

function readSavedFilters(raw: string): OdooFilters {
  const o = parseSaved(raw);
  const notes = savedString(o, "notes");
  const mo = savedString(o, "mo");
  const closed = savedString(o, "closed");
  return {
    q: savedString(o, "q"), product: savedString(o, "product"), status: savedString(o, "status"),
    notes: notes in ODOO_NOTE_FILTERS ? (notes as OdooNoteFilter) : "all",
    mo: mo in ODOO_MO_FILTERS ? (mo as OdooMoFilter) : "all",
    closed: closed in ODOO_CLOSED_FILTERS ? (closed as OdooClosedFilter) : "all",
  };
}

/** One of the day's counts, as a filter. Reads as the sentence it always was
 *  until it is hovered or picked — a count that filters must not look like a
 *  button parked in the middle of a line of prose. */
function CountFilter({ n, label, tone, on, title, onClick }: { n: number; label: string; tone: string; on: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${title}${on ? " — click again to show them all" : ""}`}
      aria-pressed={on}
      className={`font-bold rounded px-1 -mx-0.5 transition-colors hover:bg-surface-2 ${tone} ${on ? "ring-2 ring-brand bg-surface-2" : ""}`}
    >
      {n} {label}
    </button>
  );
}

function FilterBar({ entries, filters, onChange, shown }: { entries: OdooEntryView[]; filters: OdooFilters; onChange: (f: OdooFilters) => void; shown: number }) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  // the sheet's names first, then anything else typed on the rows
  const products = uniq([...ODOO_PRODUCTS, ...entries.map((e) => e.product)]);
  const statuses = uniq([...ODOO_STATUSES, ...entries.map((e) => e.status)]);
  const set = (patch: Partial<OdooFilters>) => onChange({ ...filters, ...patch });
  const active = JSON.stringify(filters) !== JSON.stringify(EMPTY_ODOO_FILTERS);
  return (
    <div className="flex flex-wrap items-center gap-2 no-print">
      <input
        type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })}
        placeholder="Search SOI, FG-CODE, MO, product, notes…" aria-label="Search"
        className={`${SEL} ltr w-72 font-normal`}
      />
      <select aria-label="Product" title="Product" className={SEL} value={filters.product} onChange={(e) => set({ product: e.target.value })}>
        <option value="">Product: all</option>
        {products.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select aria-label="Status" title="Status" className={SEL} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
        <option value="">Status: all</option>
        {statuses.map((st) => <option key={st} value={st}>{st}</option>)}
      </select>
      <select aria-label="Closing" title="Closed in Odoo, still open, or both" className={SEL} value={filters.closed} onChange={(e) => set({ closed: e.target.value as OdooClosedFilter })}>
        {(Object.keys(ODOO_CLOSED_FILTERS) as OdooClosedFilter[]).map((k) => <option key={k} value={k}>{ODOO_CLOSED_FILTERS[k]}</option>)}
      </select>
      <select aria-label="Notes" title="Rows with or without notes" className={SEL} value={filters.notes} onChange={(e) => set({ notes: e.target.value as OdooNoteFilter })}>
        {(Object.keys(ODOO_NOTE_FILTERS) as OdooNoteFilter[]).map((k) => <option key={k} value={k}>{ODOO_NOTE_FILTERS[k]}</option>)}
      </select>
      <select aria-label="MO" title="Rows born from a closing that still need Odoo's MO, or whose FG-CODE was guessed" className={SEL} value={filters.mo} onChange={(e) => set({ mo: e.target.value as OdooMoFilter })}>
        {(Object.keys(ODOO_MO_FILTERS) as OdooMoFilter[]).map((k) => <option key={k} value={k}>{ODOO_MO_FILTERS[k]}</option>)}
      </select>
      <span className="text-xs text-muted tabnum">{active ? `${shown} of ${entries.length} row(s)` : `${entries.length} row(s)`}</span>
      {active && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(EMPTY_ODOO_FILTERS)}>✕ Clear</button>}
    </div>
  );
}

/**
 * What the day on screen is hiding.
 *
 * The tab opens on ONE day, so a row logged last week is not gone — it is on
 * last week. That reads as loss, and rows get retyped. This says out loud how
 * much of the log sits on other days and how much of it is still open, with
 * the one click that shows all of it.
 */
function ElsewhereBanner({ day, onDay, totalRows, openRows }: { day: string; onDay: number; totalRows: number; openRows: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  if (day === "all" || totalRows <= onDay) return null;
  const elsewhere = totalRows - onDay;
  const showAll = () => {
    const p = new URLSearchParams(params.toString());
    p.set("day", "all");
    router.push(`${pathname}?${p}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm bg-surface-2 border rounded-xl px-3 py-2 no-print">
      <span>
        <b className="tabnum">{elsewhere}</b> more row(s) sit on other days
        {openRows > 0 && <> — <b className="text-bad-fg tabnum">{openRows}</b> of the whole log is still not closed</>}.
      </span>
      <button type="button" className="btn btn-sm btn-primary ms-auto" onClick={showAll}>
        Show all days
      </button>
    </div>
  );
}

export function OdooClient({
  entries,
  day,
  knownSois,
  knownFgCodes,
  nesting,
  soiBoms,
  canEdit,
  totalRows,
  openRows,
}: {
  entries: OdooEntryView[];
  day: string;
  knownSois: string[];
  knownFgCodes: string[];
  nesting: NestingLookup;
  soiBoms: Record<string, string[]>;
  canEdit: boolean;
  /** The whole log behind this day — see ElsewhereBanner. */
  totalRows: number;
  openRows: number;
}) {
  const bomsOf = (soi: string | null) => soiBoms[(soi ?? "").trim().toUpperCase()] ?? NO_BOMS;
  const { filters, setFilters } = useStoredFilters(FILTERS_KEY, readSavedFilters, EMPTY_ODOO_FILTERS);
  const shown = useMemo(() => filterOdooEntries(entries, filters), [entries, filters]);
  // Each count is taken with its OWN filter lifted, so the numbers hold still
  // while they are toggled — a count that collapses to 0 the moment you use it
  // cannot be clicked back off.
  const byClosing = useMemo(() => filterOdooEntries(entries, { ...filters, closed: "all" }), [entries, filters]);
  const done = byClosing.filter((e) => e.done).length;
  const open = byClosing.length - done;
  const needMo = useMemo(
    () => filterOdooEntries(entries, { ...filters, mo: "all" }).filter((e) => !e.odooMo).length,
    [entries, filters]
  );
  return (
    <div className="space-y-5">
      <ElsewhereBanner day={day} onDay={entries.length} totalRows={totalRows} openRows={openRows} />
      {entries.length > 0 && <FilterBar entries={entries} filters={filters} onChange={setFilters} shown={shown.length} />}
      {shown.length > 0 && (
        // The counts ARE the filters: the planner reads "19 not closed" and the
        // next thing he wants is those nineteen. Clicking one narrows to it,
        // clicking it again clears it, and it stacks with the filter row above
        // rather than replacing it.
        <div className="text-sm text-muted flex flex-wrap items-center gap-x-1 gap-y-1 no-print">
          <span>{shown.length} row(s){day !== "all" ? ` on ${day}` : ""}</span>
          <span aria-hidden>·</span>
          <CountFilter
            n={done}
            label="done"
            tone="text-ok-fg"
            on={filters.closed === "done"}
            title="Only the rows Odoo has closed"
            onClick={() => setFilters({ ...filters, closed: filters.closed === "done" ? "all" : "done" })}
          />
          <span aria-hidden>·</span>
          <CountFilter
            n={open}
            label="not closed"
            tone="text-bad-fg"
            on={filters.closed === "open"}
            title="Only the rows still waiting to close, whatever status they carry"
            onClick={() => setFilters({ ...filters, closed: filters.closed === "open" ? "all" : "open" })}
          />
          {(needMo > 0 || filters.mo === "missing") && (
            <>
              <span aria-hidden>·</span>
              <CountFilter
                n={needMo}
                label="need MO"
                tone="text-warn-fg"
                on={filters.mo === "missing"}
                title="Rows written by a painting / shot-blast record, waiting for Odoo's MO"
                onClick={() => setFilters({ ...filters, mo: filters.mo === "missing" ? "all" : "missing" })}
              />
            </>
          )}
        </div>
      )}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {entries.length === 0 ? (
          <p className="text-sm text-muted p-4">
            {day === "all" ? "No rows logged yet." : `Nothing logged on ${day}. Add the day's rows below, import the sheet, or look at all days.`}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted p-4">
            No row matches these filters{day !== "all" ? ` on ${day}` : ""}.
            {day !== "all" && " The search only covers the day on screen — switch to All days to search the whole log."}
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
                  <th className="p-2" title="Moved in place by the planner">Status</th>
                  <th className="p-2" title="What Odoo said and what was done — one note at a time, newest first">Notes</th>
                  <th className="p-2 no-print" title="Click a row (or 🧱) for the material its qty consumes, ready to copy into Odoo">🧱</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <Row key={e.id} e={e} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} nesting={nesting} soiBoms={bomsOf(e.soi)} canEdit={canEdit} />
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
