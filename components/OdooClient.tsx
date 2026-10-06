"use client";

import { formatDate, formatDateTime } from "@/lib/domain/format";
import { ProductSwatch } from "@/components/Badge";
import { productColor } from "@/lib/domain/productColors";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  ODOO_PRODUCTS, ODOO_STATUSES, ODOO_NOTE_FILTERS, ODOO_MO_FILTERS, ODOO_CLOSED_FILTERS, EMPTY_ODOO_FILTERS, filterOdooEntries, groupOdooEntries,
  odooItemTotals, odooScopeLabel, singleDayOf, type OdooItemTotal,
  type OdooEntryView, type OdooGroup, type OdooNoteView, type OdooTone, type OdooFilters, type OdooNoteFilter, type OdooMoFilter, type OdooClosedFilter,
} from "@/lib/domain/odoo";
import { sourceLabel } from "@/lib/domain/odooMirror";
import { LV_PRODUCTS } from "@/lib/domain/lv";
import type { ProductLine } from "@/lib/domain/lines";
import { useActiveLine } from "@/components/LineContext";
import { Soi } from "@/components/ui";
import { OdooMaterialPopup } from "@/components/OdooMaterialPopup";
import { Modal } from "@/components/Modal";
import { entryMaterialNeed, type NeedContext, type NestingLookup } from "@/lib/domain/odooMaterial";
import { parseSaved, savedString, useStoredFilters } from "@/components/useStoredFilters";
import { ODOO_CHANGED_EVENT } from "@/lib/domain/odooAlerts";
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
          window.dispatchEvent(new Event(ODOO_CHANGED_EVENT)); // the ODOO tab's count follows now
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

// ---- the row form: one strip, the sheet's columns in the sheet's order ----

const F = "px-2 py-1.5 text-sm font-semibold";

function Field({ hint, label, className = "", children }: { hint: string; label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`inline-flex flex-col gap-0.5 ${className}`} title={hint}>
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

/** The Product column's vocabulary: the transformers' parts, or the panel
 *  types. Suggestions only — the field takes anything typed. */
function productsOf(line: ProductLine): readonly string[] {
  return line === "LV" ? LV_PRODUCTS : ODOO_PRODUCTS;
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
  const line = useActiveLine();
  const today = new Date().toISOString().slice(0, 10);
  const born = isBorn(e);
  return (
    <>
      <Field hint="Date of the close attempt" label="Date" className="w-[8.5rem]">
        <input name="date" type="date" aria-label="Date" defaultValue={e?.dateISO ?? singleDayOf(day) ?? today} required disabled={disabled} className={`${F} ltr tabnum w-full`} />
      </Field>
      <Field hint="SOI#" label="SOI#" className="w-28">
        <input name="soi" list="odoo-sois" aria-label="SOI" defaultValue={e?.soi ?? ""} disabled={disabled} placeholder="SOI#" className={`${F} ltr w-full`} />
        <datalist id="odoo-sois">{knownSois.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="FG-CODE — Odoo's finished-good code" label="FG-CODE" className="w-48">
        <input name="fgCode" list="odoo-fg" aria-label="FG-CODE" defaultValue={e?.fgCode ?? ""} required={!born} disabled={disabled} placeholder="FG-CODE" className={`${F} ltr w-full`} />
        <datalist id="odoo-fg">{knownFgCodes.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="Product" label="Product" className="w-32">
        <input name="product" list="odoo-products" aria-label="Product" defaultValue={e?.product ?? ""} required disabled={disabled} placeholder="Product" className={`${F} w-full`} />
        <datalist id="odoo-products">{productsOf(line).map((p) => <option key={p} value={p} />)}</datalist>
      </Field>
      <Field hint="Odoo MO number (SF01/MO/…)" label="MO#" className="w-44">
        <input name="odooMo" aria-label="MO#" defaultValue={e?.odooMo ?? ""} required={!born} disabled={disabled} placeholder="SF01/MO/…" className={`${F} ltr w-full`} />
      </Field>
      <Field hint="Quantity" label="QTY" className="w-20">
        <input name="qty" type="number" step="1" min="0" aria-label="QTY" defaultValue={e?.qty ?? ""} required disabled={disabled} placeholder="QTY" className={`${F} ltr tabnum w-full font-extrabold`} />
      </Field>
      <Field hint="Status" label="Status" className="w-40">
        <select name="status" aria-label="Status" defaultValue={e?.status ?? "MO to be close"} disabled={disabled} className={`${F} w-full`}>
          {statusOptions(e?.status).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
    </>
  );
}

// the columns that change from row to row on the same day; date stays
const PER_ROW = ["soi", "fgCode", "product", "odooMo", "qty"] as const;

/** Which line a new row or a sheet goes to — only the lines this person may
 *  record on; a single one is fixed and shown. */
function LinePick({ lines, defaultLine }: { lines: readonly string[]; defaultLine: string }) {
  const start = lines.includes(defaultLine) ? defaultLine : lines[0];
  if (lines.length === 1) {
    return (
      <label className="inline-flex flex-col gap-0.5">
        <span className="text-[11px] font-bold text-muted uppercase tracking-wide">Line</span>
        <input type="hidden" name="line" value={start} />
        <span className="pill pill-muted">{start === "LV" ? "LV Panels" : "Transformers"}</span>
      </label>
    );
  }
  return (
    <label className="inline-flex flex-col gap-0.5">
      <span className="text-[11px] font-bold text-muted uppercase tracking-wide">Line</span>
      <select name="line" defaultValue={start} className={`${F} w-36`}>
        {lines.map((l) => <option key={l} value={l}>{l === "LV" ? "LV Panels" : "Transformers"}</option>)}
      </select>
    </label>
  );
}

function AddRow({ day, knownSois, knownFgCodes, lines, defaultLine }: { day: string; knownSois: string[]; knownFgCodes: string[]; lines: readonly string[]; defaultLine: string }) {
  const add = useAction();
  const [open, setOpen] = useState(false);
  function clearForNext(form: HTMLFormElement) {
    for (const n of PER_ROW) {
      const el = form.elements.namedItem(n);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    const first = form.elements.namedItem("soi");
    if (first instanceof HTMLInputElement) first.focus();
  }
  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
        ➕ Add a row
      </button>
      {open && (
        <Modal title="➕ Add a row" sub="After Add, the date and status stay for the next row." onClose={() => setOpen(false)} busy={add.pending} width="max-w-4xl">
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const form = ev.currentTarget;
              add.run(createOdooEntry, new FormData(form), "Added — next row.", () => clearForNext(form));
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <LinePick lines={lines} defaultLine={defaultLine} />
              <RowFields day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} disabled={add.pending} />
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
function InlineValue({ ids, name, value, placeholder, action, warn, hint, list }: {
  /** The rows the value is written to — one, or every row of a merged line. */
  ids: number[]; name: "odooMo" | "fgCode"; value: string; placeholder: string; warn: boolean; hint: string; list?: string;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const a = useAction();
  const [draft, setDraft] = useState(value);
  function submit() {
    const v = draft.trim();
    if (v === value.trim()) return;
    const fd = new FormData();
    fd.set("ids", ids.join(","));
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

function StatusCell({ e, canEdit, ids }: { e: OdooEntryView; canEdit: boolean; ids?: number[] }) {
  const a = useAction();
  const targets = ids ?? [e.id];
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
          fd.set("ids", targets.join(","));
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

// a moment on the factory clock, in the app's one date format
const stamp = (iso: string): string => formatDateTime(iso);

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

function Row({ e, day, knownSois, knownFgCodes, nesting, needCtx, canEdit, inGroup = false }: {
  e: OdooEntryView; day: string; knownSois: string[]; knownFgCodes: string[]; nesting: NestingLookup; needCtx: NeedContext; canEdit: boolean;
  /** One of the closings under a merged line — indented, so the line above
   *  reads as the total of what follows it. */
  inGroup?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [material, setMaterial] = useState(false);
  const edit = useAction();
  const del = useAction();
  // the row's material, as a hint on the button — none when the tracker has
  // no lines for this part on this BOM
  const need = useMemo(() => entryMaterialNeed(nesting, e, e.qty, needCtx), [nesting, e, needCtx]);
  const closeMaterial = useCallback(() => setMaterial(false), []);
  // clicking the row's plain cells opens its material; the status and notes
  // cells keep their own controls
  const cell = "p-2 whitespace-nowrap cursor-pointer";
  const open = () => setMaterial(true);
  const rowTitle = need ? `Click for the material behind ${e.qty} units` : `Click — no material lines for this ${needCtx.lv ? "order" : "FG-CODE"} yet`;
  const born = isBorn(e);
  return (
    <>
      <tr className={`border-t hover:bg-surface-2/60 ${inGroup ? "bg-surface-2/40" : ""}`}>
        <td className={`${cell} tabnum ltr ${inGroup ? "ps-6" : ""}`} onClick={open} title={rowTitle}>
          <span className="inline-flex flex-col">
            <span className="inline-flex items-center gap-1">
              {inGroup ? <span className="text-muted">↳ {formatDate(e.dateISO)}</span> : formatDate(e.dateISO)}
              {!inGroup && <span className={`pill text-[10px] ${e.line === "LV" ? "pill-muted" : "pill-ok"}`} title={e.line === "LV" ? "LV Panels" : "Transformers"}>{e.line}</span>}
            </span>
            {born && <span className="pill pill-muted text-[10px] mt-0.5" title="Written by the closing recorded in the daily log — the office fills in Odoo's MO">{sourceLabel(e.source)}</span>}
          </span>
        </td>
        <td className={cell} onClick={open} title={rowTitle}><Soi soi={e.soi} /></td>
        <td className={`${cell} ltr text-xs font-semibold`} onClick={e.fgGuessed && canEdit ? undefined : open} title={e.fgGuessed ? "Composed from the part code and the transformer's BOM — no earlier row of this SOI and product to copy from. Confirm or correct it." : rowTitle}>
          {e.fgGuessed && canEdit ? (
            <InlineValue ids={[e.id]} name="fgCode" value={e.fgCode} placeholder="FG-CODE" action={setOdooFgCode} warn list="odoo-fg" hint="Guessed FG-CODE — Enter keeps it, or type the right one" />
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
            <InlineValue ids={[e.id]} name="odooMo" value="" placeholder="SF01/MO/… (Enter)" action={setOdooMo} warn={false} hint="Type Odoo's MO number for this closing — Enter saves" />
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
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={del.pending}
                onClick={() => {
                  if (!confirm(`Delete ${e.odooMo || `${e.product} ×${e.qty}`} (${formatDate(e.dateISO)})?`)) return;
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
      {material && <OdooMaterialPopup e={e} nesting={nesting} needCtx={needCtx} onClose={closeMaterial} />}
      {editing && (
        <Modal title="Edit a row" sub={`${e.odooMo || e.product} · ${formatDate(e.dateISO)}`} onClose={() => setEditing(false)} busy={edit.pending} width="max-w-4xl">
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const fd = new FormData(ev.currentTarget);
              fd.set("id", String(e.id));
              edit.run(updateOdooEntry, fd, "Saved.", () => setEditing(false));
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <RowFields e={e} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} disabled={edit.pending} />
            </div>
            <Msg msg={edit.msg} />
            <div className="flex justify-end gap-2 pt-3 mt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={edit.pending}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>{edit.pending ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </Modal>
      )}
      {del.msg?.ok === false && (
        <tr className="border-t-0">
          <td colSpan={9} className="px-2 pb-3"><Msg msg={del.msg} /></td>
        </tr>
      )}
    </>
  );
}

/**
 * Several closings of the SAME thing, on one line.
 *
 * The tab writes a row per closing recorded in the daily log, so painting the
 * same order three times in a day left three rows reading identically — and
 * the office typed Odoo's MO into each of them. Here they are one line
 * carrying the total, and the MO and the status typed on it are written to
 * every row underneath, so the MO is typed once.
 *
 * Nothing is merged in the database: the rows keep their own quantities and
 * their links to the daily-log records that wrote them, and the line opens to
 * show them — that is where a single one is edited, noted or deleted.
 */
function MergedRow({ g, day, knownSois, knownFgCodes, nesting, needCtx, canEdit }: {
  g: OdooGroup; day: string; knownSois: string[]; knownFgCodes: string[]; nesting: NestingLookup; needCtx: NeedContext; canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [material, setMaterial] = useState(false);
  const head = g.rows[0];
  const ids = g.rows.map((r) => r.id);
  // the line's material is the material of what it closed in TOTAL — the
  // whole point of the line is that the office reads one figure, not three
  const whole = useMemo(() => ({ ...head, qty: g.qty }), [head, g.qty]);
  const need = useMemo(() => entryMaterialNeed(nesting, head, g.qty, needCtx), [nesting, head, g.qty, needCtx]);
  const closeMaterial = useCallback(() => setMaterial(false), []);
  const noteCount = g.rows.reduce((n, r) => n + r.notes.length, 0);
  const guessed = g.rows.some((r) => r.fgGuessed);
  const born = g.rows.every((r) => isBorn(r));
  const parts = g.rows.map((r) => r.qty).join(" + ");
  const cell = "p-2 whitespace-nowrap cursor-pointer";
  const toggle = () => setOpen((v) => !v);
  return (
    <>
      <tr className={`border-t font-semibold ${open ? "bg-brand-light/40" : "bg-brand-light/20 hover:bg-brand-light/40"} transition-colors`}>
        <td className={`${cell} tabnum ltr`} onClick={toggle} title={open ? "Hide the closings" : "Show the closings this line adds up"}>
          <span className="inline-flex flex-col">
            <span>
              <span className={`inline-block me-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
              {formatDate(head.dateISO)}
              <span className={`pill text-[10px] ms-1 ${head.line === "LV" ? "pill-muted" : "pill-ok"}`} title={head.line === "LV" ? "LV Panels" : "Transformers"}>{head.line}</span>
            </span>
            <span className="pill pill-muted text-[10px] mt-0.5" title={born ? "Written by the closings recorded in the daily log" : "Rows that read the same"}>
              {g.rows.length} closings{born ? " · from the floor" : ""}
            </span>
          </span>
        </td>
        <td className={cell} onClick={toggle}><Soi soi={head.soi} /></td>
        <td className={`${cell} ltr text-xs font-semibold`} onClick={toggle}>
          <span className="inline-flex flex-col">
            {head.fgCode || <span className="text-muted">—</span>}
            {guessed && <span className="pill pill-warn text-[10px] mt-0.5" title="Open the line to confirm the guessed code on its rows">check FG-CODE</span>}
          </span>
        </td>
        <td className={cell} onClick={toggle}>{head.product}</td>
        <td className={`${cell} ltr text-xs font-bold`}>
          {head.odooMo ? head.odooMo : canEdit ? (
            <InlineValue
              ids={ids}
              name="odooMo"
              value=""
              placeholder="SF01/MO/… (Enter)"
              action={setOdooMo}
              warn={false}
              hint={`Type Odoo's MO once — it is written to all ${g.rows.length} closings on this line`}
            />
          ) : (
            <span className="pill pill-warn text-[10px]">needs MO</span>
          )}
        </td>
        <td className="p-2 text-center tabnum font-extrabold cursor-pointer" onClick={toggle} title={`${parts} — the closings on this line`}>{g.qty}</td>
        <td className="p-2 whitespace-nowrap text-xs align-top">
          <StatusCell e={head} canEdit={canEdit} ids={ids} />
        </td>
        <td className="p-2 text-xs min-w-[18rem] max-w-[28rem] align-top font-normal">
          {noteCount > 0 ? (
            <button type="button" className="text-xs text-accent hover:underline" onClick={toggle}>
              {noteCount} note(s) — open the line to read them
            </button>
          ) : (
            <span className="text-muted text-xs">—</span>
          )}
        </td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          <span className="inline-flex gap-1">
            <button
              type="button"
              className={`btn btn-sm ${need ? "btn-secondary" : "btn-ghost"}`}
              title={need ? `Material for all ${g.qty} units: ${need.lines.length} line(s), ${need.totalActual || need.totalBom} sheets` : "No nesting lines for this FG-CODE yet"}
              onClick={() => setMaterial(true)}
            >
              🧱{need ? <span className="tabnum ms-1">{need.totalActual || need.totalBom}</span> : null}
            </button>
            <button type="button" className="btn btn-sm" onClick={toggle}>{open ? "Close" : `${g.rows.length} rows`}</button>
          </span>
        </td>
      </tr>
      {material && <OdooMaterialPopup e={whole} nesting={nesting} needCtx={needCtx} onClose={closeMaterial} />}
      {open && g.rows.map((e) => (
        <Row key={e.id} e={e} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} nesting={nesting} needCtx={needCtx} canEdit={canEdit} inGroup />
      ))}
    </>
  );
}

// ---- import: the sheet, once — its first seven columns ----

function ImportPanel({ day, lines, defaultLine }: { day: string; lines: readonly string[]; defaultLine: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  function submit(form: HTMLFormElement, preview: boolean) {
    const fd = new FormData(form);
    fd.set("preview", String(preview));
    fd.set("day", singleDayOf(day) ?? "");
    startTransition(async () => {
      const r = await importOdooAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) { setRes({ ok: false, text: r.error ?? "Import failed." }); return; }
      const tail = `${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged`;
      setRes({ ok: true, text: preview ? `Preview only — nothing saved: ${tail}.` : `Imported: ${tail}.` });
      if (!preview) router.refresh();
    });
  }
  const button = <button type="button" className="btn btn-sm" onClick={() => { setRes(null); setIssues([]); setOpen(true); }}>📥 Import Excel</button>;
  if (!open) return button;
  return (
    <>
    {button}
    <Modal title="📥 Import Excel" onClose={() => setOpen(false)} busy={pending}>
    <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-bold text-muted">Excel file</span>
          <input type="file" name="file" accept=".xlsx,.xlsm,.xls,.csv" required className="block text-sm mt-1" />
        </label>
        <LinePick lines={lines} defaultLine={defaultLine} />
      </div>
      <p className="text-xs text-muted">
        Reads the sheet&apos;s first seven columns — Date · SOI# · FG-CODE · Product · MO# · QTY · Status. Notes are
        never read. The same MO on the same day is updated, never doubled, and its Status stays as moved here
        {singleDayOf(day) ? `; rows with a blank Date are filed under ${day}` : ""}.
      </p>
      <Msg msg={res} />
      {issues.length > 0 && (
        <ul className="text-xs text-warn-fg list-disc ps-5 space-y-0.5 max-h-40 overflow-y-auto">{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
      )}
      <div className="flex justify-end gap-2 pt-3 border-t">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>Close</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, true)}>Preview</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, false)}>{pending ? "Working…" : "Import"}</button>
      </div>
    </form>
    </Modal>
    </>
  );
}

// ---- filters: one row above the table, kept between visits ----

const FILTERS_KEY = "odoo:filters";
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
    line: ["TR", "LV"].includes(savedString(o, "line")) ? savedString(o, "line") : "",
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

function FilterBar({ entries, filters, onChange }: { entries: OdooEntryView[]; filters: OdooFilters; onChange: (f: OdooFilters) => void }) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
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
      <select aria-label="Line" title="Product line" className={SEL} value={filters.line} onChange={(e) => set({ line: e.target.value })}>
        <option value="">Line: both</option>
        <option value="TR">Transformers</option>
        <option value="LV">LV Panels</option>
      </select>
      <select aria-label="Status" title="Status" className={SEL} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
        <option value="">Status: all</option>
        {statuses.map((st) => <option key={st} value={st}>{st}</option>)}
      </select>
      <select aria-label="Notes" title="Rows with or without notes" className={SEL} value={filters.notes} onChange={(e) => set({ notes: e.target.value as OdooNoteFilter })}>
        {(Object.keys(ODOO_NOTE_FILTERS) as OdooNoteFilter[]).map((k) => <option key={k} value={k}>{ODOO_NOTE_FILTERS[k]}</option>)}
      </select>
      <select aria-label="MO" title="Rows born from a closing that still need Odoo's MO, or whose FG-CODE was guessed" className={SEL} value={filters.mo} onChange={(e) => set({ mo: e.target.value as OdooMoFilter })}>
        {(Object.keys(ODOO_MO_FILTERS) as OdooMoFilter[]).map((k) => <option key={k} value={k}>{ODOO_MO_FILTERS[k]}</option>)}
      </select>
      {active && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(EMPTY_ODOO_FILTERS)}>✕ Clear</button>}
    </div>
  );
}

/**
 * How much of each item the rows on screen carry — the period's summary.
 * Every other filter applies; the product filter is lifted so every card
 * stays on screen, and a card IS that filter: click one to narrow the log
 * to it, click it again to clear it.
 */
function ItemCards({ totals, selected, onPick, periodLabel }: { totals: OdooItemTotal[]; selected: string; onPick: (product: string) => void; periodLabel: string }) {
  if (totals.length === 0) return null;
  const all = totals.reduce((a, t) => ({ qty: a.qty + t.qty, rows: a.rows + t.rows, doneQty: a.doneQty + t.doneQty, openQty: a.openQty + t.openQty }), { qty: 0, rows: 0, doneQty: 0, openQty: 0 });
  const card = (key: string, label: string, t: { qty: number; rows: number; doneQty: number; openQty: number }, on: boolean, onClick: () => void, title: string) => (
    <button
      key={key} type="button" onClick={onClick} title={title} aria-pressed={on}
      className={`text-start bg-surface border rounded-xl px-3 py-1.5 min-w-0 transition-colors hover:border-brand/60 ${on ? "border-brand ring-2 ring-brand/30" : ""}`}
      style={key !== "all" ? { boxShadow: `inset 0 3px 0 ${productColor(key)}` } : undefined}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-muted uppercase tracking-wide min-w-0">
        {key !== "all" && <ProductSwatch product={key} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-xl font-extrabold tabnum leading-tight">{t.qty.toLocaleString("en")}</div>
      <div className="text-[11px] text-muted tabnum mt-0.5 whitespace-nowrap" title={`${t.rows} row${t.rows === 1 ? "" : "s"}`}>
        <span className="text-ok-fg font-semibold">{t.doneQty.toLocaleString("en")} closed</span>
        {t.openQty > 0 && <> · <span className="text-bad-fg font-semibold">{t.openQty.toLocaleString("en")} open</span></>}
      </div>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] no-print" aria-label="Quantity per item">
      {card("all", "All items", all, selected === "", () => onPick(""), `Everything the rows ${periodLabel || "in the whole log"} carry, with the other filters applied`)}
      {totals.map((t) => card(t.product, t.product, t, selected === t.product, () => onPick(selected === t.product ? "" : t.product), `${t.product}: ${t.qty} ${periodLabel} — click to show only these rows`))}
    </div>
  );
}

/** The rows of the log outside the period on screen — said in the counts
 *  line with the one click that shows them, so nothing reads as lost. */
function useShowAll() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return () => {
    const p = new URLSearchParams(params.toString());
    p.set("day", "all");
    router.push(`${pathname}?${p}`);
  };
}

export function OdooClient({
  entries,
  day,
  knownSois,
  knownFgCodes,
  nesting,
  needCtx,
  canEditLine,
  defaultLine,
  totalRows,
  openRows,
}: {
  entries: OdooEntryView[];
  day: string;
  knownSois: string[];
  knownFgCodes: string[];
  nesting: NestingLookup;
  /** How a row finds its material — each row's own line decides: by part ×
   *  BOM (transformers) or by MO (panels). */
  needCtx: NeedContext;
  /** Both lines share the tab; a row is editable with its own line's Odoo right. */
  canEditLine: Record<string, boolean>;
  /** The line a new row or a sheet goes to unless another is picked — the nav's toggle. */
  defaultLine: string;
  /** The whole log behind this day — see ElsewhereBanner. */
  totalRows: number;
  openRows: number;
}) {
  const { filters, setFilters } = useStoredFilters(FILTERS_KEY, readSavedFilters, EMPTY_ODOO_FILTERS);
  const editableLines = (["TR", "LV"] as const).filter((l) => canEditLine[l]);
  const shown = useMemo(() => filterOdooEntries(entries, filters), [entries, filters]);
  // the rows that are the same closing read as one line carrying the total
  const groups = useMemo(() => groupOdooEntries(shown), [shown]);
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
  // The office's own queue: still open AND Odoo's MO already on the row, so
  // nothing stands between it and a closing but someone doing it. Faceted on
  // both filters it controls, so its number holds while it is toggled.
  const ready = useMemo(
    () => filterOdooEntries(entries, { ...filters, closed: "all", mo: "all" }).filter((e) => !e.done && !!e.odooMo.trim()).length,
    [entries, filters]
  );
  const readyOn = filters.closed === "open" && filters.mo === "has";
  const showAll = useShowAll();
  const elsewhere = day === "all" ? 0 : Math.max(0, totalRows - entries.length);
  const elsewhereLink = elsewhere > 0 && (
    <button type="button" className="text-accent font-semibold hover:underline" onClick={showAll} title="Show every row ever logged">
      +{elsewhere} on other days{openRows > 0 ? ` (${openRows} open)` : ""} — show all
    </button>
  );
  // the cards: every filter but the product one, so all items stay in view —
  // the products of the line filtered to, or of both lines
  const itemTotals = useMemo(
    () => odooItemTotals(
      filterOdooEntries(entries, { ...filters, product: "" }),
      filters.line === "TR" || filters.line === "LV" ? productsOf(filters.line) : [...productsOf("TR"), ...productsOf("LV")],
    ),
    [entries, filters]
  );
  return (
    <div className="space-y-3">
      <ItemCards totals={itemTotals} selected={filters.product} onPick={(product) => setFilters({ ...filters, product })} periodLabel={odooScopeLabel(day)} />
      {entries.length > 0 && (
        // The filters and the counts share one row. The counts ARE filters:
        // the planner reads "19 not closed" and the next thing he wants is
        // those nineteen. Clicking one narrows to it, clicking it again clears
        // it. The filters stay even when nothing matches, so they can be undone.
        <div className="text-sm text-muted flex flex-wrap items-center gap-x-1 gap-y-1 no-print">
          <FilterBar entries={entries} filters={filters} onChange={setFilters} />
          {shown.length > 0 && (<>
          <span className="w-2" aria-hidden />
          <span className="tabnum">{shown.length} row{shown.length === 1 ? "" : "s"}</span>
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
          {(ready > 0 || readyOn) && (
            <>
              <span aria-hidden>·</span>
              <CountFilter
                n={ready}
                label="ready to close"
                tone="text-accent"
                on={readyOn}
                title="Still open and Odoo's MO is already on the row — nothing is missing but the closing itself"
                onClick={() => setFilters(readyOn ? { ...filters, closed: "all", mo: "all" } : { ...filters, closed: "open", mo: "has" })}
              />
            </>
          )}
          {elsewhereLink && <><span aria-hidden>·</span>{elsewhereLink}</>}
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
          </>)}
        </div>
      )}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {entries.length === 0 ? (
          <p className="text-sm text-muted p-4">
            {day === "all" ? "No rows logged yet." : singleDayOf(day) ? `Nothing logged on ${day}. Add the day's rows below or import the sheet.` : `Nothing logged ${odooScopeLabel(day)}.`}
            {elsewhereLink && <> {elsewhereLink}</>}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted p-4">
            No row matches these filters{day !== "all" ? ` ${odooScopeLabel(day)}` : ""}.
            {day !== "all" && ` The search only covers ${singleDayOf(day) ? "the day" : "the period"} on screen — switch to All days to search the whole log.`}
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
                {groups.map((g) => {
                  const line = g.rows[0].line;
                  const ctx = { ...needCtx, lv: line === "LV" };
                  const can = !!canEditLine[line];
                  return g.rows.length === 1 ? (
                    <Row key={g.rows[0].id} e={g.rows[0]} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} nesting={nesting} needCtx={ctx} canEdit={can} />
                  ) : (
                    <MergedRow key={g.key} g={g} day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} nesting={nesting} needCtx={ctx} canEdit={can} />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editableLines.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <AddRow day={day} knownSois={knownSois} knownFgCodes={knownFgCodes} lines={editableLines} defaultLine={defaultLine} />
          <ImportPanel day={day} lines={editableLines} defaultLine={defaultLine} />
        </div>
      )}
    </div>
  );
}
