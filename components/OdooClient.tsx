"use client";

import { traceHref } from "@/lib/domain/links";
import Link from "next/link";

import { FilterSelect, SearchBox } from "@/components/FilterControls";
import { Check, FilterX, MessageSquarePlus, X } from "lucide-react";
import { CellEditor, TableEmpty, TableFrame, Th, useConfirm, useRowMenu } from "@/components/DataTable";
import { formatDate, formatDateTime } from "@/lib/domain/format";
import { ProductSwatch } from "@/components/Badge";
import { productColor } from "@/lib/domain/productColors";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useTransition, Fragment } from "react";
import {
  ODOO_PRODUCTS, ODOO_STATUSES, ODOO_OPEN_STATUS, ODOO_DONE_STATUS, ODOO_CANCELLED_STATUS, CANCEL_NEEDS_NOTE,
  cancelLocked, isCancelledStatus, isDoneStatus, isOpenStatus, EMPTY_ODOO_FILTERS, filterOdooEntries, groupOdooEntries,
  odooItemTotals, odooScopeLabel, singleDayOf, type OdooItemTotal,
  type OdooEntryView, type OdooGroup, type OdooNoteView, type OdooTone, type OdooFilters,
} from "@/lib/domain/odoo";
import { sourceLabel } from "@/lib/domain/odooMirror";
import { LV_PRODUCTS } from "@/lib/domain/lv";
import { resolveLine, type ProductLine } from "@/lib/domain/lines";
import { useActiveLine } from "@/components/LineContext";
import { SAVE_UNCONFIRMED, Soi } from "@/components/ui";
import { OdooMaterialPopup } from "@/components/OdooMaterialPopup";
import { Modal } from "@/components/Modal";
import { MO_MATERIAL_FLAG, MO_MATERIAL_STATES, entryMaterialNeed, moMaterialFlag, rowMaterialState, type MoMaterialFlagState, type NeedContext, type NestingLookup } from "@/lib/domain/odooMaterial";
import { ODOO_CHANGED_EVENT } from "@/lib/domain/odooAlerts";
import { updateOdooEntry, deleteOdooEntry, setOdooStatus, setOdooMo, addOdooNote, deleteOdooNote, updateOdooGroup, deleteOdooEntries } from "@/app/odoo/actions";
import { factoryDayISO } from "@/lib/domain/dates";

// The ODOO log — the office's daily log of Odoo close attempts, one strip per
// row, the columns of the sheet it replaces: Date · SOI# · FG-CODE · Product ·
// MO# · QTY · Status. The page adds no rows of its own: a row is BORN here when
// a painting record (or the core's shot blast) writes it with everything but
// Odoo's MO, which the clerk types in place — and an FG-CODE the app had to
// compose is flagged until it is looked at — or comes from the assistant. The
// planner moves the Status in place and keeps Notes on it — a list, each deletable.

function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(
    (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string, after?: () => void) => {
      startTransition(async () => {
        // A rejected action (network cut, server fault) must stay a message on
        // this row — thrown, React hands it to the route's error boundary, which
        // replaces the whole tab and says nothing was changed when it may have been.
        try {
          const res = await fn(fd);
          setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "Failed." });
          if (res.ok) {
            after?.();
            window.dispatchEvent(new Event(ODOO_CHANGED_EVENT)); // the ODOO log's count follows now
          }
        } catch {
          setMsg({ ok: false, text: SAVE_UNCONFIRMED });
        }
      });
    },
    []
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
  disabled,
  shared = false,
}: {
  e?: OdooEntryView;
  day: string;
  knownSois: string[];
  disabled?: boolean;
  /** A merged line's fields: what its rows share — no date, no quantity. */
  shared?: boolean;
}) {
  const line = useActiveLine();
  const today = factoryDayISO(new Date());
  const born = isBorn(e);
  return (
    <>
      {!shared && (
        <Field hint="Date of the close attempt" label="Date" className="w-[8.5rem]">
          <input name="date" type="date" aria-label="Date" defaultValue={e?.dateISO ?? singleDayOf(day) ?? today} required disabled={disabled} className={`${F} ltr tabnum w-full`} />
        </Field>
      )}
      <Field hint="SOI#" label="SOI#" className="w-28">
        <input name="soi" list="odoo-sois" aria-label="SOI" defaultValue={e?.soi ?? ""} disabled={disabled} placeholder="SOI#" className={`${F} ltr w-full`} />
        <datalist id="odoo-sois">{knownSois.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <Field hint="Product" label="Product" className="w-32">
        <input name="product" list="odoo-products" aria-label="Product" defaultValue={e?.product ?? ""} required disabled={disabled} placeholder="Product" className={`${F} w-full`} />
        <datalist id="odoo-products">{productsOf(line).map((p) => <option key={p} value={p} />)}</datalist>
      </Field>
      <Field hint="Odoo MO number (SF01/MO/…)" label="MO#" className="w-44">
        <input name="odooMo" aria-label="MO#" defaultValue={e?.odooMo ?? ""} required={!born} disabled={disabled} placeholder="SF01/MO/…" className={`${F} ltr w-full`} />
      </Field>
      {!shared && (
        <Field hint="Quantity" label="QTY" className="w-20">
          <input name="qty" type="number" step="1" min="0" aria-label="QTY" defaultValue={e?.qty ?? ""} required disabled={disabled} placeholder="QTY" className={`${F} ltr tabnum w-full font-extrabold`} />
        </Field>
      )}
      <Field hint="Status" label="Status" className="w-40">
        <select name="status" aria-label="Status" defaultValue={e?.status ?? "MO to be close"} disabled={disabled} className={`${F} w-full`}>
          {statusOptions(e?.status).map((s) => {
            // cancelled only with a reason: a new row has none, an open one needs a note first
            const locked = isCancelledStatus(s) && cancelLocked(e?.status, e?.notes.length ?? 0);
            return <option key={s} value={s} disabled={locked}>{s}{locked ? " — add a note first" : ""}</option>;
          })}
        </select>
      </Field>
    </>
  );
}

// ---- Status: the planner's ✓ / ✗, ticked in place ----

/** The Edit form's status choices, plus whatever the row already says if it is not one of them. */
function statusOptions(current?: string | null): string[] {
  const cur = (current ?? "").trim();
  return cur && !(ODOO_STATUSES as readonly string[]).includes(cur) ? [...ODOO_STATUSES, cur] : [...ODOO_STATUSES];
}

const TONE_PILL: Record<OdooTone, string> = { ok: "pill-ok", warn: "pill-warn", bad: "pill-bad", muted: "pill-muted" };

/** A row born from a closing in the ledger, not typed or imported. */
function isBorn(e?: OdooEntryView | null): boolean {
  return e?.source === "painting" || e?.source === "shotblast";
}

/** A merged line's day — or its first and last day, when the same MO's
 *  closings were recorded on several. */
function dayRange(rows: OdooEntryView[]): string {
  const days = rows.map((r) => r.dateISO).sort();
  const first = days[0], last = days[days.length - 1];
  return first === last ? formatDate(first) : `${formatDate(first)} – ${formatDate(last)}`;
}

/** The row's BOM, and a quiet mark when it is less than certain. */
function BomValue({ bom, line }: { bom: OdooEntryView["bom"]; line: string }) {
  if (bom.boms.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {/* each BOM opens its order's page — the row's own click stays the material */}
      {bom.boms.map((b, i) => (
        <Fragment key={b}>
          {i > 0 && " / "}
          <Link href={traceHref({ bom: b, line: resolveLine(line) })} onClick={(ev) => ev.stopPropagation()} className="text-brand-ink hover:underline" title="Open the order's details">{b}</Link>
        </Fragment>
      ))}
      {bom.boms.length > 1 && <span className="pill pill-warn text-[11px]" title="The SOI has several BOMs — the row does not say which">{bom.boms.length} BOMs</span>}
    </span>
  );
}

function bomTitle(e: OdooEntryView): string {
  const how = e.bom.via === "closing" ? "the closing recorded on the Plan Tracker" : e.bom.via === "soi" ? "the SOI's order" : "the row";
  return e.bom.boms.length ? `BOM from ${how}` : "No BOM known for this row";
}

/** One value typed straight into the row and saved on Enter or blur — Odoo's
 *  MO on a born row, or a guessed FG-CODE the office confirms or corrects. */
function InlineValue({ ids, name, value, placeholder, action, warn, hint, list }: {
  /** The rows the value is written to — one, or every row of a merged line. */
  ids: number[]; name: "odooMo" | "fgCode"; value: string; placeholder: string; warn: boolean; hint: string; list?: string;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const a = useAction();
  function submit(v: string) {
    const fd = new FormData();
    fd.set("ids", ids.join(","));
    fd.set(name, v);
    a.run(action, fd, "Saved.");
  }
  return (
    <span className="inline-flex flex-col no-print">
      <CellEditor
        type="text" col={name} value={value} onCommit={submit} list={list} disabled={a.pending} warn={warn}
        placeholder={placeholder} title={hint} ariaLabel={name === "odooMo" ? "MO#" : "FG-CODE"}
        className={`ltr font-bold ${name === "fgCode" ? "!w-48" : "!w-40"}`}
      />
      {a.msg?.ok === false && <span className="text-[11px] text-bad-fg">{a.msg.text}</span>}
    </span>
  );
}

function DoneStamp({ e }: { e: OdooEntryView }) {
  if (!e.done || !e.doneAtISO) return null;
  return (
    <span className="text-[11px] text-muted tabnum ltr" title="When the status was moved to Done — the day the dashboard counts the close on" suppressHydrationWarning>
      closed {stamp(e.doneAtISO)}
    </span>
  );
}

/**
 * The planner's two marks: ✓ closes the row (Done), ✗ cancels it — only once
 * a note says why. A second click on the lit mark opens the row again. A row
 * carrying an older word (Pending, Blocked, the sheet's own) shows it beside them.
 */
function StatusCell({ e, canEdit, ids }: { e: OdooEntryView; canEdit: boolean; ids?: number[] }) {
  const a = useAction();
  const [confirm, confirmDialog] = useConfirm();
  // ✗ pressed before a note: said under the marks — a phone has no tooltip
  const [needNote, setNeedNote] = useState(false);
  const targets = ids ?? [e.id];
  const done = isDoneStatus(e.status);
  const cancelled = isCancelledStatus(e.status);
  const other = !done && !cancelled && !isOpenStatus(e.status);
  if (!canEdit) {
    return (
      <span className="inline-flex flex-col">
        <span className={`pill ${TONE_PILL[e.tone]}`}>{e.status}</span>
        <DoneStamp e={e} />
      </span>
    );
  }
  const locked = cancelLocked(e.status, e.notes.length);
  async function tick(mark: typeof ODOO_DONE_STATUS | typeof ODOO_CANCELLED_STATUS) {
    setNeedNote(false);
    if (mark === ODOO_CANCELLED_STATUS && locked) { setNeedNote(true); return; }
    // a second click on the lit mark opens the row again
    const reopen = mark === ODOO_DONE_STATUS ? done : cancelled;
    const next = reopen ? ODOO_OPEN_STATUS : mark;
    // leaving Done forgets the moment it was closed on — the dashboard counts that day
    if (done) {
      const ok = await confirm({
        title: reopen ? "Open this row again?" : "Cancel this closed row?",
        body: <>It was closed {e.doneAtISO ? stamp(e.doneAtISO) : ""}. Ticking ✓ again closes it from that moment.</>,
        confirmLabel: reopen ? "Open again" : "Cancel the row",
        danger: !reopen,
      });
      if (!ok) return;
    }
    const fd = new FormData();
    fd.set("ids", targets.join(","));
    fd.set("status", next);
    a.run(setOdooStatus, fd, "Saved.");
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={`pill ${TONE_PILL[e.tone]} print-only`}>{e.status}</span>
      <span className="inline-flex items-center gap-1 no-print" role="group" aria-label="Status">
        {other && <span className={`pill ${TONE_PILL[e.tone]}`} title="The row's earlier status — ✓ or ✗ replaces it">{e.status}</span>}
        <button
          type="button"
          className="icon-btn tick tick-ok"
          aria-pressed={done}
          disabled={a.pending}
          onClick={() => tick(ODOO_DONE_STATUS)}
          // a toggle keeps one name — aria-pressed says whether it is ticked
          aria-label="Done"
          title={done ? "Done — click to open the row again" : "Mark Done — closed now, saves at once"}
        >
          <Check size={15} strokeWidth={3} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-btn tick tick-bad"
          aria-pressed={cancelled}
          // focusable while locked, so a press says why rather than nothing
          aria-disabled={locked || undefined}
          disabled={a.pending}
          onClick={() => tick(ODOO_CANCELLED_STATUS)}
          aria-label="Cancelled"
          title={cancelled ? "Cancelled — click to open the row again" : locked ? CANCEL_NEEDS_NOTE : "Cancel the row — the note says why"}
        >
          <X size={15} strokeWidth={3} aria-hidden />
        </button>
      </span>
      <DoneStamp e={e} />
      {needNote && locked && <span className="text-[11px] text-bad-fg whitespace-normal max-w-[12rem]" role="alert">{CANCEL_NEEDS_NOTE}</span>}
      {a.msg?.ok === false && <span className="text-[11px] text-bad-fg">{a.msg.text}</span>}
      {confirmDialog}
    </span>
  );
}

// ---- Notes: a list per row, newest first, each deletable; add one below ----

// a moment on the factory clock, in the app's one date format
const stamp = (iso: string): string => formatDateTime(iso);

function Note({ n, canEdit }: { n: OdooNoteView; canEdit: boolean }) {
  const del = useAction();
  const [confirmDelete, confirmDialog] = useConfirm();
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
        {del.msg?.ok === false && <span className="text-[11px] text-bad-fg">{del.msg.text}</span>}
      </div>
      {canEdit && (
        <button
          type="button"
          className="btn btn-sm btn-ghost text-bad-fg shrink-0 opacity-40 group-hover:opacity-100 no-print"
          title="Delete this note"
          aria-label="Delete this note"
          disabled={del.pending}
          onClick={async () => {
            const ok = await confirmDelete({
              title: "Delete this note?",
              items: [`${n.text}${n.by ? ` — ${n.by}` : ""}, ${stamp(n.atISO)}`],
              confirmLabel: "Delete note",
              danger: true,
            });
            if (!ok) return;
            const fd = new FormData();
            fd.set("noteId", String(n.id));
            del.run(deleteOdooNote, fd, "Deleted.");
          }}
        >
          ✕
        </button>
      )}
      {confirmDialog}
    </li>
  );
}

/**
 * A row's notes in two lines at most: the newest, cut with an ellipsis (the
 * whole text in its tooltip), and "+N earlier" to open the full list. A new
 * note is typed in a field the + button opens; Enter keeps it, Escape drops it.
 */
function NotesCell({ e, canEdit }: { e: OdooEntryView; canEdit: boolean }) {
  const add = useAction();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  function submit() {
    const body = draft.trim();
    if (!body) { setAdding(false); return; }
    const fd = new FormData();
    fd.set("id", String(e.id));
    fd.set("text", body);
    add.run(addOdooNote, fd, "Added.", () => { setDraft(""); setAdding(false); });
  }
  const latest = e.notes[0];
  const earlier = e.notes.length - 1;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          {expanded ? (
            <ul className="space-y-1.5">
              {e.notes.map((n) => <Note key={n.id} n={n} canEdit={canEdit} />)}
            </ul>
          ) : latest ? (
            <p className="line-clamp-2 break-words" title={`${latest.text}\n— ${stamp(latest.atISO)}${latest.by ? ` · ${latest.by}` : ""}`}>
              {latest.blockedItem && <span className="pill pill-bad ltr me-1">{latest.blockedItem}</span>}
              {latest.text}
              <span className="text-[11px] text-muted"> · <span className="tabnum ltr" suppressHydrationWarning>{stamp(latest.atISO)}</span>{latest.by && ` · ${latest.by}`}</span>
            </p>
          ) : (
            !adding && <span className="text-muted">—</span>
          )}
          {e.notes.length > 0 && (earlier > 0 || expanded) && (
            <button type="button" className="text-[11px] font-semibold text-brand-ink hover:underline no-print" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? "Show the newest only" : `+${earlier} earlier`}
            </button>
          )}
        </div>
        {canEdit && !adding && (
          <button type="button" className="icon-btn shrink-0 no-print" onClick={() => setAdding(true)} aria-label="Add a note" title="Add a note — kept with the time and your name">
            <MessageSquarePlus size={14} />
          </button>
        )}
      </div>
      {canEdit && adding && (
        <input
          autoFocus
          value={draft}
          disabled={add.pending}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); submit(); }
            else if (ev.key === "Escape") { ev.preventDefault(); setDraft(""); setAdding(false); }
          }}
          onBlur={submit}
          placeholder="Type the note, Enter to keep it"
          title="Type a note and press Enter — it is kept with the time and your name"
          className="px-2 py-1 text-xs w-full no-print"
        />
      )}
      {add.msg?.ok === false && <span className="text-[11px] text-bad-fg">{add.msg.text}</span>}
    </div>
  );
}

/** What the marks on a row mean — the one place they are spelled out. */
function FlagLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-t text-xs text-muted no-print" aria-label="What the marks mean">
      <span className="filter-label">Marks</span>
      <span className="inline-flex items-center gap-1.5"><span className="pill pill-warn">needs MO</span>waiting for Odoo&apos;s MO number</span>
      <span className="inline-flex items-center gap-1.5"><span className="pill pill-info">from Painting</span>written by a closing on the floor</span>
      <span className="inline-flex items-center gap-1.5"><span className="pill pill-muted">3 closings</span>rows of one closing, added up — click to open</span>
      <span className="inline-flex items-center gap-1.5">🧱 the material the quantity takes</span>
      <span className="inline-flex items-center gap-1.5"><MatSwatch state="missing" big />MO not on the Material tab</span>
      <span className="inline-flex items-center gap-1.5"><MatSwatch state="partial" big />MO on the Material tab, not all of it nested yet</span>
      <span className="inline-flex items-center gap-1.5"><MatSwatch state="ok" big />MO on the Material tab, all nested</span>
    </div>
  );
}

/** The table's column count — the full-width rows (a message, a group head) span it. */
const COLS = 11;

function LinePill({ line }: { line: string }) {
  return <span className={`pill ${line === "LV" ? "pill-info" : "pill-muted"}`}>{line}</span>;
}

/** Where the row came from: typed, imported, or written by a floor closing. */
function SourceTag({ source }: { source: string }) {
  const label = sourceLabel(source);
  if (!label) return <span className="text-muted text-xs">typed</span>;
  return <span className={`pill ${label === "imported" ? "pill-muted" : "pill-info"}`}>{label}</span>;
}

function Row({ e, day, knownSois, nesting, needCtx, canEdit, inGroup = false }: {
  e: OdooEntryView; day: string; knownSois: string[]; nesting: NestingLookup; needCtx: NeedContext; canEdit: boolean;
  /** One of the closings under a merged line — indented, so the line above
   *  reads as the total of what follows it. */
  inGroup?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [material, setMaterial] = useState(false);
  const edit = useAction();
  const del = useAction();
  const [confirmDelete, confirmDialog] = useConfirm();
  const what = `${e.odooMo || `${e.product} ×${e.qty}`} · ${formatDate(e.dateISO)}`;
  const row = useRowMenu(() => [
    { heading: what },
    { key: "material", label: "Material for this row", icon: "🧱", onSelect: () => setMaterial(true) },
    { key: "edit", label: "Edit row…", icon: "✏️", onSelect: () => setEditing(true) },
    { sep: true },
    {
      key: "delete", label: "Delete row…", icon: "🗑", danger: true, disabled: del.pending,
      onSelect: async () => {
        const ok = await confirmDelete({
          title: "Delete this ODOO row?",
          body: <>The row leaves the log. A closing recorded on the floor that wrote it stays in the daily log.</>,
          items: [`${what} · ${e.product} ×${e.qty}${e.soi ? ` · ${e.soi}` : ""}`],
          confirmLabel: "Delete row",
          danger: true,
        });
        if (!ok) return;
        const fd = new FormData();
        fd.set("id", String(e.id));
        del.run(deleteOdooEntry, fd, "Deleted.");
      },
    },
  ], `Actions for ${what}`);
  // the row's material, as a hint on the button — none when the tracker has
  // no lines for this part on this BOM
  const need = useMemo(() => entryMaterialNeed(nesting, e, e.qty, needCtx), [nesting, e, needCtx]);
  const closeMaterial = useCallback(() => setMaterial(false), []);
  // clicking the row's plain cells opens its material; the status and notes
  // cells keep their own controls
  const cell = "p-2 whitespace-nowrap cursor-pointer";
  const open = () => setMaterial(true);
  const rowTitle = need ? `Click for the material behind ${e.qty} units` : `Click — no material lines for this ${needCtx.lv ? "order" : "row"} yet`;
  const born = isBorn(e);
  // the MO typed for it, against the Material tab: red when no nesting is
  // filed under it, yellow when some of its lines are not nested yet, green
  // when every line is
  const moState = rowMaterialState(nesting, e, needCtx);
  const flag = moMaterialFlag(moState);
  return (
    <>
      <tr
        className={`border-t ${flag ? `${flag.cls} hover:brightness-95` : `hover:bg-surface-2/60 ${inGroup ? "bg-surface-2/40" : ""}`}`}
        onContextMenu={canEdit ? row.onContextMenu : undefined}
      >
        <td className={`${cell} tabnum ltr ${inGroup ? "ps-6" : ""}`} onClick={open} title={rowTitle}>
          {inGroup ? <span className="text-muted">↳ {formatDate(e.dateISO)}</span> : formatDate(e.dateISO)}
        </td>
        <td className={cell} onClick={open} title={e.line === "LV" ? "LV Panels" : "Transformers"}>
          {!inGroup && <LinePill line={e.line} />}
        </td>
        <td className={cell} onClick={open} title={born ? "Written by the closing recorded in the daily log — the office fills in Odoo's MO" : rowTitle}>
          <SourceTag source={e.source} />
        </td>
        <td className={cell} onClick={open} title={rowTitle}><Soi soi={e.soi} /></td>
        <td className={`${cell} ltr text-xs font-semibold`} onClick={open} title={bomTitle(e)}>
          <BomValue bom={e.bom} line={e.line} />
        </td>
        <td className={cell} onClick={open} title={rowTitle}>{e.product}</td>
        <td className={`${cell} ltr text-xs font-bold`} onClick={!e.odooMo && canEdit ? undefined : open} title={flag ? flag.text : e.odooMo ? rowTitle : "Odoo's MO is not known here — type it once the MO is printed from Odoo"}>
          {e.odooMo ? e.odooMo : canEdit ? (
            <InlineValue ids={[e.id]} name="odooMo" value="" placeholder="SF01/MO/… (Enter)" action={setOdooMo} warn={false} hint="Type Odoo's MO number for this closing — Enter saves" />
          ) : (
            <span className="pill pill-warn text-[11px]">needs MO</span>
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
              title={need ? `Material for ${e.qty} units: ${need.lines.length} line(s), ${need.totalBook} sheets` : "No nesting lines for this row yet"}
              onClick={open}
            >
              🧱{need ? <span className="tabnum ms-1">{need.totalBook}</span> : null}
            </button>
          {canEdit && <>{row.button}{row.menu}{confirmDialog}</>}
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
              fd.set("version", e.version);
              edit.run(updateOdooEntry, fd, "Saved.", () => setEditing(false));
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <RowFields e={e} day={day} knownSois={knownSois} disabled={edit.pending} />
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
          <td colSpan={COLS} className="px-2 pb-3"><Msg msg={del.msg} /></td>
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
 * their links to the daily-log records that wrote them. The line is edited
 * like a row — its notes, its ⋯ menu — and what is done there lands on every
 * row under it; the line opens to show them for a single one.
 */
function MergedRow({ g, day, knownSois, nesting, needCtx, canEdit }: {
  g: OdooGroup; day: string; knownSois: string[]; nesting: NestingLookup; needCtx: NeedContext; canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [material, setMaterial] = useState(false);
  const [editing, setEditing] = useState(false);
  const edit = useAction();
  const del = useAction();
  const [confirmDelete, confirmDialog] = useConfirm();
  const head = g.rows[0];
  const ids = g.rows.map((r) => r.id);
  // the notes of every row, newest first — a note typed on the line is kept on its first row
  const notes = useMemo(() => g.rows.flatMap((r) => r.notes).sort((a, b) => b.atISO.localeCompare(a.atISO)), [g.rows]);
  const noted = useMemo(() => ({ ...head, notes }), [head, notes]);
  const what = `${head.odooMo || `${head.product} ×${g.qty}`} · ${g.rows.length} closings`;
  const row = useRowMenu(() => [
    { heading: what },
    { key: "material", label: "Material for this line", icon: "🧱", onSelect: () => setMaterial(true) },
    { key: "edit", label: `Edit all ${g.rows.length} rows…`, icon: "✏️", onSelect: () => setEditing(true) },
    { key: "open", label: open ? "Hide the closings" : "Show the closings", icon: open ? "▴" : "▾", onSelect: () => setOpen((v) => !v) },
    { sep: true },
    {
      key: "delete", label: `Delete all ${g.rows.length} rows…`, icon: "🗑", danger: true, disabled: del.pending,
      onSelect: async () => {
        const ok = await confirmDelete({
          title: `Delete the ${g.rows.length} rows of this line?`,
          body: <>The rows leave the log. A closing recorded on the floor that wrote one stays in the daily log.</>,
          items: g.rows.map((r) => `${r.odooMo || r.product} · ${formatDate(r.dateISO)} · ×${r.qty}${r.soi ? ` · ${r.soi}` : ""}`),
          confirmLabel: `Delete ${g.rows.length} rows`,
          danger: true,
        });
        if (!ok) return;
        const fd = new FormData();
        fd.set("ids", ids.join(","));
        del.run(deleteOdooEntries, fd, "Deleted.");
      },
    },
  ], `Actions for ${what}`);
  // the line's material is the material of what it closed in TOTAL — the
  // whole point of the line is that the office reads one figure, not three
  const whole = useMemo(() => ({ ...head, qty: g.qty }), [head, g.qty]);
  const need = useMemo(() => entryMaterialNeed(nesting, head, g.qty, needCtx), [nesting, head, g.qty, needCtx]);
  const closeMaterial = useCallback(() => setMaterial(false), []);
  const born = g.rows.every((r) => isBorn(r));
  const parts = g.rows.map((r) => r.qty).join(" + ");
  const cell = "p-2 whitespace-nowrap cursor-pointer";
  const toggle = () => setOpen((v) => !v);
  // the line's own cells open its details — the material of everything it
  // adds up — the way a single row does; the ▶ and the rows button open the
  // closings underneath
  const details = () => setMaterial(true);
  const moState = rowMaterialState(nesting, head, needCtx);
  const flag = moMaterialFlag(moState);
  const rowTitle = need ? `Click for the material behind all ${g.qty} units` : `Click — no material lines for this ${needCtx.lv ? "order" : "line"} yet`;
  return (
    <>
      <tr
        className={`border-t font-semibold ${flag ? `${flag.cls} hover:brightness-95` : open ? "bg-brand-light/40" : "bg-brand-light/20 hover:bg-brand-light/40"} transition-colors`}
        onContextMenu={canEdit ? row.onContextMenu : undefined}
      >
        <td className={`${cell} tabnum ltr`} onClick={details} title={rowTitle}>
          <button
            type="button"
            className="me-1 px-0.5 rounded hover:bg-surface-3"
            onClick={(ev) => { ev.stopPropagation(); toggle(); }}
            aria-expanded={open}
            title={open ? "Hide the closings" : "Show the closings this line adds up"}
          >
            <span className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden>▶</span>
          </button>
          {dayRange(g.rows)}
        </td>
        <td className={cell} onClick={details} title={head.line === "LV" ? "LV Panels" : "Transformers"}><LinePill line={head.line} /></td>
        <td className={cell} onClick={details} title={born ? "Written by the closings recorded in the daily log" : "Rows that read the same"}>
          <span className="pill pill-muted">{g.rows.length} closings{born ? " · floor" : ""}</span>
        </td>
        <td className={cell} onClick={details} title={rowTitle}><Soi soi={head.soi} /></td>
        <td className={`${cell} ltr text-xs font-semibold`} onClick={details}>
          <span className="inline-flex flex-col" title={bomTitle(head)}>
            <BomValue bom={head.bom} line={head.line} />
          </span>
        </td>
        <td className={cell} onClick={details} title={rowTitle}>{head.product}</td>
        <td className={`${cell} ltr text-xs font-bold`} onClick={!head.odooMo && canEdit ? undefined : details} title={flag?.text}>
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
            <span className="pill pill-warn text-[11px]">needs MO</span>
          )}
        </td>
        <td className="p-2 text-center tabnum font-extrabold cursor-pointer" onClick={details} title={`${parts} — the closings on this line. Click for the material behind all ${g.qty}`}>{g.qty}</td>
        <td className="p-2 whitespace-nowrap text-xs align-top">
          <StatusCell e={noted} canEdit={canEdit} ids={ids} />
        </td>
        <td className="p-2 text-xs min-w-[18rem] max-w-[28rem] align-top font-normal">
          <NotesCell e={noted} canEdit={canEdit} />
        </td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          <span className="inline-flex gap-1">
            <button
              type="button"
              className={`btn btn-sm ${need ? "btn-secondary" : "btn-ghost"}`}
              title={need ? `Material for all ${g.qty} units: ${need.lines.length} line(s), ${need.totalBook} sheets` : "No nesting lines for this row yet"}
              onClick={() => setMaterial(true)}
            >
              🧱{need ? <span className="tabnum ms-1">{need.totalBook}</span> : null}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={toggle}>{open ? "Close" : `${g.rows.length} rows`}</button>
            {canEdit && <>{row.button}{row.menu}{confirmDialog}</>}
          </span>
        </td>
      </tr>
      {material && <OdooMaterialPopup e={whole} nesting={nesting} needCtx={needCtx} onClose={closeMaterial} />}
      {editing && (
        <Modal title={`Edit all ${g.rows.length} rows of this line`} sub={`${parts} · each row keeps its own date and quantity`} onClose={() => setEditing(false)} busy={edit.pending} width="max-w-3xl">
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const fd = new FormData(ev.currentTarget);
              fd.set("ids", ids.join(","));
              // each row's last change as drawn — a stale modal must not revert a row closed meanwhile
              fd.set("versions", g.rows.map((r) => r.version).join(","));
              edit.run(updateOdooGroup, fd, "Saved.", () => setEditing(false));
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <RowFields e={noted} day={day} knownSois={knownSois} disabled={edit.pending} shared />
            </div>
            <Msg msg={edit.msg} />
            <div className="flex justify-end gap-2 pt-3 mt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={edit.pending}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={edit.pending}>{edit.pending ? "Saving…" : `Save ${g.rows.length} rows`}</button>
            </div>
          </form>
        </Modal>
      )}
      {del.msg?.ok === false && (
        <tr className="border-t-0">
          <td colSpan={COLS} className="px-2 pb-3"><Msg msg={del.msg} /></td>
        </tr>
      )}
      {open && g.rows.map((e) => (
        <Row key={e.id} e={e} day={day} knownSois={knownSois} nesting={nesting} needCtx={needCtx} canEdit={canEdit} inGroup />
      ))}
    </>
  );
}

// ---- filters: one row above the table ----
// Every visit opens the same way: every day, the rows still marked "MO to be
// close" — the office's to-do list. A filter changed here holds while the tab
// is open; Reset comes back to this.
const DEFAULT_ODOO_FILTERS: OdooFilters = { ...EMPTY_ODOO_FILTERS, status: "MO to be close" };

/** One of the day's counts, as a filter. Reads as the sentence it always was
 *  until it is hovered or picked — a count that filters must not look like a
 *  button parked in the middle of a line of prose. */
/** A count that is also its filter — a chip: click it to narrow the log to
 *  those rows, click it again to show them all. */
function CountFilter({ n, label, tone, on, title, onClick }: { n: number; label: string; tone: string; on: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${title}${on ? " — click again to show them all" : ""}`}
      aria-pressed={on}
      className="chip-toggle inline-flex items-center gap-1.5 tabnum"
    >
      <span className={`font-extrabold ${on ? "" : tone}`}>{n}</span>{label}
    </button>
  );
}

/** One colour of the MO-on-Material tint, as a count that filters to it. */
/** A row colour in small — the tint with its coloured left edge. */
function MatSwatch({ state, big = false }: { state: MoMaterialFlagState; big?: boolean }) {
  return <span aria-hidden className={`inline-block rounded-sm border-l-4 ${big ? "w-[18px] h-3" : "w-3.5 h-[11px]"} ${MO_MATERIAL_FLAG[state].swatch}`} />;
}

function MatChip({ state, n, on, onClick }: { state: MoMaterialFlagState; n: number; on: boolean; onClick: () => void }) {
  const flag = MO_MATERIAL_FLAG[state];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={`${flag.text}${on ? " — click again to show them all" : " — show only these rows"}`}
      className="chip-toggle inline-flex items-center gap-1.5 tabnum"
    >
      <MatSwatch state={state} />
      <span className={`font-extrabold ${on ? "" : flag.ink}`}>{n}</span>{flag.label}
    </button>
  );
}

function FilterBar({ entries, filters, onChange }: { entries: OdooEntryView[]; filters: OdooFilters; onChange: (f: OdooFilters) => void }) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const statuses = uniq([...ODOO_STATUSES, ...entries.map((e) => e.status)]);
  const set = (patch: Partial<OdooFilters>) => onChange({ ...filters, ...patch });
  const active = JSON.stringify(filters) !== JSON.stringify(DEFAULT_ODOO_FILTERS);
  return (
    <div className="toolbar toolbar-row no-print !mb-0">
      <SearchBox value={filters.q} onChange={(v) => set({ q: v })} placeholder="Search SOI, BOM, MO, product, notes…" wide settle />
      <FilterSelect label="Line" title="Product line" value={filters.line} allLabel="both" onChange={(v) => set({ line: v })} options={[{ value: "TR", label: "Transformers" }, { value: "LV", label: "LV Panels" }]} />
      <FilterSelect label="Status" value={filters.status} onChange={(v) => set({ status: v })} options={statuses.map((st) => ({ value: st, label: st }))} />
      {active && <button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={() => onChange(DEFAULT_ODOO_FILTERS)} title="Back to the rows marked MO to be close"><FilterX size={13} aria-hidden />Reset</button>}
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
      className={`h-16 text-start bg-surface border rounded-[10px] px-3 py-1.5 min-w-0 flex flex-col justify-center transition-colors hover:border-brand/60 ${on ? "border-brand ring-2 ring-brand/30" : ""}`}
      style={key !== "all" ? { boxShadow: `inset 0 3px 0 ${productColor(key)}` } : undefined}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-muted uppercase tracking-wide min-w-0">
        {key !== "all" && <ProductSwatch product={key} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-lg font-extrabold tabnum leading-tight">{t.qty.toLocaleString("en")}</span>
        <span className="text-[11px] text-muted tabnum truncate" title={`${t.rows} row${t.rows === 1 ? "" : "s"} · ${t.doneQty} closed · ${t.openQty} open`}>
          <span className="text-ok-fg font-semibold">{t.doneQty.toLocaleString("en")} closed</span>
          {t.openQty > 0 && <> · <span className="text-bad-fg font-semibold">{t.openQty.toLocaleString("en")} open</span></>}
        </span>
      </div>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(min(8.5rem,100%),1fr))] no-print" aria-label="Quantity per item">
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
  nesting,
  needCtx,
  canEditLine,
  totalRows,
  openRows,
}: {
  entries: OdooEntryView[];
  day: string;
  knownSois: string[];
  nesting: NestingLookup;
  /** How a row finds its material — each row's own line decides: by part ×
   *  BOM (transformers) or by MO (panels). */
  needCtx: NeedContext;
  /** Both lines share the tab; a row is editable with its own line's Odoo right. */
  canEditLine: Record<string, boolean>;
  /** The whole log behind this day — see ElsewhereBanner. */
  totalRows: number;
  openRows: number;
}) {
  const [filters, setFilters] = useState<OdooFilters>(DEFAULT_ODOO_FILTERS);
  // the colour a row's MO reads on the Material tab — red / yellow / green —
  // as one more filter over the rest
  const [matState, setMatState] = useState<"" | "missing" | "partial" | "ok">("");
  const byMat = useCallback(
    (rows: OdooEntryView[], st: typeof matState = matState) => (st ? rows.filter((e) => rowMaterialState(nesting, e, { ...needCtx, lv: e.line === "LV" }) === st) : rows),
    [nesting, matState, needCtx]
  );
  const pick = useCallback((f: OdooFilters) => byMat(filterOdooEntries(entries, f)), [byMat, entries]);
  const shown = useMemo(() => pick(filters), [pick, filters]);
  // the rows that are the same closing read as one line carrying the total
  const groups = useMemo(() => groupOdooEntries(shown), [shown]);
  // Each count is taken with its OWN filter lifted, so the numbers hold still
  // while they are toggled — a count that collapses to 0 the moment you use it
  // cannot be clicked back off.
  const byClosing = useMemo(() => pick({ ...filters, closed: "all" }), [pick, filters]);
  const done = byClosing.filter((e) => e.done).length;
  const open = byClosing.length - done;
  const needMo = useMemo(
    () => pick({ ...filters, mo: "all" }).filter((e) => !e.odooMo).length,
    [pick, filters]
  );
  // The office's own queue: still open AND Odoo's MO already on the row, so
  // nothing stands between it and a closing but someone doing it. Faceted on
  // both filters it controls, so its number holds while it is toggled.
  const ready = useMemo(
    () => pick({ ...filters, closed: "all", mo: "all" }).filter((e) => !e.done && !!e.odooMo.trim()).length,
    [pick, filters]
  );
  const readyOn = filters.closed === "open" && filters.mo === "has";
  // what the Notes and MO dropdowns did, as two more counts
  const withNotes = useMemo(() => pick({ ...filters, notes: "all" }).filter((e) => e.notes.length > 0).length, [pick, filters]);
  // the colours, each counted with the colour filter lifted
  const matCounts = useMemo(() => {
    const out = { missing: 0, partial: 0, ok: 0 };
    for (const e of byMat(filterOdooEntries(entries, filters), "")) {
      const st = rowMaterialState(nesting, e, { ...needCtx, lv: e.line === "LV" });
      if (st !== "none") out[st] += 1;
    }
    return out;
  }, [byMat, entries, filters, nesting, needCtx]);
  const showAll = useShowAll();
  const elsewhere = day === "all" ? 0 : Math.max(0, totalRows - entries.length);
  const elsewhereLink = elsewhere > 0 && (
    <button type="button" className="text-brand-ink font-semibold hover:underline" onClick={showAll} title="Show every row ever logged">
      +{elsewhere} on other days{openRows > 0 ? ` (${openRows} open)` : ""} — show all
    </button>
  );
  // the cards: every filter but the product one, so all items stay in view —
  // the products of the line filtered to, or of both lines
  const itemTotals = useMemo(
    () => odooItemTotals(
      pick({ ...filters, product: "" }),
      filters.line === "TR" || filters.line === "LV" ? productsOf(filters.line) : [...productsOf("TR"), ...productsOf("LV")],
    ),
    [pick, filters]
  );
  return (
    <div className="space-y-3">
      <ItemCards totals={itemTotals} selected={filters.product} onPick={(product) => setFilters({ ...filters, product })} periodLabel={odooScopeLabel(day)} />
      {entries.length > 0 && (
        // The filters and the counts share one row. The counts ARE filters:
        // the planner reads "19 not closed" and the next thing he wants is
        // those nineteen. Clicking one narrows to it, clicking it again clears
        // it. The filters stay even when nothing matches, so they can be undone.
        <div className="text-sm text-muted flex flex-wrap items-center gap-x-1.5 gap-y-1.5 no-print">
          <FilterBar entries={entries} filters={filters} onChange={setFilters} />
          {shown.length > 0 && (<>
          <span className="w-2" aria-hidden />
          <span className="tabnum me-1">{shown.length} row{shown.length === 1 ? "" : "s"}</span>
          {(done > 0 || filters.closed === "done") && <CountFilter
            n={done}
            label="done"
            tone="text-ok-fg"
            on={filters.closed === "done"}
            title="Only the rows Odoo has closed"
            onClick={() => setFilters({ ...filters, closed: filters.closed === "done" ? "all" : "done" })}
          />}
          {(open > 0 || filters.closed === "open") && <CountFilter
            n={open}
            label="not closed"
            tone="text-bad-fg"
            on={filters.closed === "open"}
            title="Only the rows still waiting to close, whatever status they carry"
            onClick={() => setFilters({ ...filters, closed: filters.closed === "open" ? "all" : "open" })}
          />}
          {(ready > 0 || readyOn) && (
            <>
              <CountFilter
                n={ready}
                label="ready to close"
                tone="text-brand-ink"
                on={readyOn}
                title="Still open and Odoo's MO is already on the row — nothing is missing but the closing itself"
                onClick={() => setFilters(readyOn ? { ...filters, closed: "all", mo: "all" } : { ...filters, closed: "open", mo: "has" })}
              />
            </>
          )}
          {elsewhereLink && <span className="ms-1">{elsewhereLink}</span>}
          {(needMo > 0 || filters.mo === "missing") && (
            <>
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
          {(withNotes > 0 || filters.notes !== "all") && (
            <CountFilter
              n={filters.notes === "without" ? shown.length : withNotes}
              label={filters.notes === "without" ? "without notes" : "with notes"}
              tone="text-muted"
              on={filters.notes !== "all"}
              title="Only the rows that carry a note"
              onClick={() => setFilters({ ...filters, notes: filters.notes === "all" ? "with" : "all" })}
            />
          )}
          </>)}
          {(matCounts.missing + matCounts.partial + matCounts.ok > 0 || matState) && (
            <span className="inline-flex flex-wrap items-center gap-1.5 ms-1" role="group" aria-label="The row's MO on the Material tab">
              <span className="filter-label">Material</span>
              {MO_MATERIAL_STATES.map((st) => (matCounts[st] > 0 || matState === st) && (
                <MatChip key={st} state={st} n={matCounts[st]} on={matState === st} onClick={() => setMatState(matState === st ? "" : st)} />
              ))}
            </span>
          )}
        </div>
      )}
      <section className="bg-surface border rounded-xl overflow-hidden">
        {entries.length === 0 ? (
          <TableEmpty
            title={day === "all" ? "No rows logged yet" : singleDayOf(day) ? `Nothing logged on ${formatDate(singleDayOf(day))}` : `Nothing logged ${odooScopeLabel(day)}`}
            hint="Rows come in from the floor's closings (painting, shot blast) — or ask the assistant to add them."
            action={elsewhereLink || undefined}
          />
        ) : shown.length === 0 ? (
          <TableEmpty
            title={`No row matches these filters${day !== "all" ? ` ${odooScopeLabel(day)}` : ""}`}
            hint={day !== "all" ? `The search only covers ${singleDayOf(day) ? "the day" : "the period"} on screen — switch to All days to search the whole log.` : undefined}
            filtered
          />
        ) : (
          <TableFrame>
            <table className="table-cards w-full text-sm border-collapse">
              <thead>
                <tr className="text-left">
                  <Th label="Date" />
                  <Th label="Line" hint="TR = Transformers · LV = LV Panels" />
                  <Th label="Source" hint="typed here · imported from the sheet · from Painting / Shot Blast = written by a closing on the floor" />
                  <Th label="SOI #" full="SOI#" />
                  <Th label="BOM" full="The BOM — from the closing recorded on the Plan Tracker, else the SOI's order" />
                  <Th label="Product" />
                  <Th label="MO #" full="MO#" hint="Odoo's MO number — typed once the MO is printed from Odoo" />
                  <Th label="Qty" unit="pcs" full="QTY" center />
                  <Th label="Status" hint="✓ Done · ✗ Cancelled — cancelling needs a note first" />
                  <Th label="Notes" hint="What Odoo said and what was done — one note at a time, newest first" />
                  <Th label="🧱" full="Material" hint="Click a row (or 🧱) for the material its qty consumes, ready to copy into Odoo" className="no-print" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const line = g.rows[0].line;
                  const ctx = { ...needCtx, lv: line === "LV" };
                  const can = !!canEditLine[line];
                  return g.rows.length === 1 ? (
                    <Row key={g.rows[0].id} e={g.rows[0]} day={day} knownSois={knownSois} nesting={nesting} needCtx={ctx} canEdit={can} />
                  ) : (
                    <MergedRow key={g.key} g={g} day={day} knownSois={knownSois} nesting={nesting} needCtx={ctx} canEdit={can} />
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        )}
        {shown.length > 0 && <FlagLegend />}
      </section>
    </div>
  );
}
