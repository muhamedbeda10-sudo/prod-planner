"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Plus, Upload } from "lucide-react";
import { FilterBar, FilterSelect, SearchBox, useSavedFilter } from "@/components/FilterControls";
import { CellEditor, TableEmpty, TableFrame, Th, useConfirm, useRowMenu } from "@/components/DataTable";
import { Modal } from "@/components/Modal";
import { Tooltip } from "@/components/Tooltip";
import { createPhysicalItem, deletePhysicalItem, importPhysicalAction, updatePhysicalCell } from "@/app/physical/actions";
import { STATUS_LABEL, STOCK_GROUPS, summarizeStock, type StockStatus } from "@/lib/domain/physicalStock";
import { formatDateTime, formatNumber } from "@/lib/domain/format";
import { normCode, type needByStock, type StockNeed } from "@/lib/domain/materialCoverage";
import type { PhysicalStockItem } from "@/lib/server/physicalStock";

// PHYSICAL MATERIAL — the store's count beside SF01's stock in Odoo, one row
// per product code, grouped by family (HR sheet, coil, galvanized, sections).
// The gap is the store's count minus Odoo's: below zero the store holds less
// than Odoo says, above it more. The sheet is uploaded straight in; a count
// is corrected in its cell. Beside Odoo's stock, the sheets the open orders
// still need (the MATERIAL tab's nesting × the pieces Fabrication owes) and
// what Odoo holds after them.

const STATUS_PILL: Record<StockStatus, string> = { match: "pill-ok", short: "pill-bad", over: "pill-warn", empty: "pill-muted" };

/** Pieces read whole when they are whole, kilos to the kilo; a fraction keeps two places. */
const qty = (n: number) => formatNumber(n, Number.isInteger(n) ? 0 : 2);

type NeedData = ReturnType<typeof needByStock>;
/** A code the open orders need more of than Odoo holds, or more than the store counted. */
const needShort = (n: StockNeed | undefined) => n?.status === "short" || n?.status === "store_short";

export function PhysicalStockClient({ items, canEdit, lastUpdate, need, needFailed = false }: {
  items: PhysicalStockItem[];
  canEdit: boolean;
  /** When the store's count was last loaded, and by whom. */
  lastUpdate: { atISO: string; by: string | null } | null;
  /** The open orders' sheets per code; null when the Material screen is closed to this person. */
  need: NeedData | null;
  /** The open need could not be worked out this time. */
  needFailed?: boolean;
}) {
  const [q, setQ] = useSavedFilter("physical.q");
  const [group, setGroup] = useSavedFilter("physical.group");
  const [status, setStatus] = useSavedFilter("physical.status");
  const [uom, setUom] = useSavedFilter("physical.uom");
  const [hideEmpty, setHideEmpty] = useSavedFilter("physical.hideEmpty", "1");
  const [shortOnly, setShortOnly] = useSavedFilter("physical.needShort", "0");
  const needOf = (i: PhysicalStockItem) => need?.byCode[normCode(i.code)];
  const [folded, setFolded] = useState<Set<string>>(new Set());

  const uoms = useMemo(() => [...new Set(items.map((i) => i.uom).filter(Boolean))].sort(), [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      if (needle && !`${i.code} ${i.name} ${i.note ?? ""}`.toLowerCase().includes(needle)) return false;
      if (group && i.group !== group) return false;
      if (status && i.status !== status) return false;
      if (uom && i.uom !== uom) return false;
      // a saved filter with no need to read (the Material screen closed since) filters nothing
      if (need && shortOnly === "1" && !needShort(need.byCode[normCode(i.code)])) return false;
      if (hideEmpty === "1" && i.status === "empty" && !status && !need?.byCode[normCode(i.code)]) return false;
      return true;
    });
  }, [items, q, group, status, uom, hideEmpty, shortOnly, need]);
  const shortCount = useMemo(() => items.filter((i) => needShort(need?.byCode[normCode(i.code)])).length, [items, need]);
  // none-held codes the open orders need stay on the table, so the chip counts only the ones it hides
  const emptyHidden = useMemo(() => items.filter((i) => i.status === "empty" && !need?.byCode[normCode(i.code)]).length, [items, need]);
  const all = useMemo(() => summarizeStock(items), [items]);
  const groups = useMemo(
    () => STOCK_GROUPS.map((g) => ({ g, rows: shown.filter((i) => i.group === g) })).filter((x) => x.rows.length > 0),
    [shown]
  );
  const hasActive = !!(q || group || status || uom || hideEmpty !== "1" || (need && shortOnly === "1"));
  const reset = () => { setQ(""); setGroup(""); setStatus(""); setUom(""); setHideEmpty("1"); setShortOnly("0"); };
  const toggle = (g: string) => setFolded((f) => { const n = new Set(f); if (n.has(g)) n.delete(g); else n.add(g); return n; });

  return (
    <div className="space-y-3">
      <SummaryCards summary={all} onPick={(s) => setStatus(status === s ? "" : s)} picked={status}
        need={need ? { short: shortCount, missing: need.missing.length, picked: shortOnly === "1", onPick: () => setShortOnly(shortOnly === "1" ? "0" : "1") } : null} />

      <FilterBar
        count={shown.length}
        total={items.length}
        onReset={reset}
        hasActive={hasActive}
        head={<SearchBox value={q} onChange={setQ} placeholder="Search code, product, note…" wide />}
        actions={canEdit && <><ImportButton /><AddItem /></>}
      >
        <FilterSelect label="Family" value={group} onChange={setGroup} options={STOCK_GROUPS.filter((g) => items.some((i) => i.group === g)).map((g) => ({ value: g, label: g }))} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={(Object.keys(STATUS_LABEL) as StockStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        {uoms.length > 1 && <FilterSelect label="UOM" value={uom} onChange={setUom} options={uoms.map((u) => ({ value: u, label: u }))} />}
        <button type="button" className="chip-toggle" aria-pressed={hideEmpty === "1"} onClick={() => setHideEmpty(hideEmpty === "1" ? "0" : "1")} title="Codes with nothing in the store and nothing in Odoo">
          Hide none-held ({emptyHidden})
        </button>
        {need && (
          <button type="button" className="chip-toggle" aria-pressed={shortOnly === "1"} onClick={() => setShortOnly(shortOnly === "1" ? "0" : "1")} title="Codes the open orders need more of than Odoo holds, or than the store counted">
            Short for open orders ({shortCount})
          </button>
        )}
      </FilterBar>

      <section className="bg-surface border rounded-[10px] overflow-hidden">
        {items.length === 0 ? (
          <TableEmpty title="No stock counted yet" hint="Upload the store's sheet — Product Code, Product Name, the physical count, UOM and SF01's stock in Odoo." action={canEdit ? <ImportButton /> : undefined} />
        ) : shown.length === 0 ? (
          <TableEmpty filtered title="No item matches these filters" hint={`${items.length} items are hidden by the filters above.`} action={<button type="button" className="btn btn-sm btn-secondary" onClick={reset}>Reset filters</button>} />
        ) : (
          <TableFrame>
            <table className="erp-table grid-lines w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr>
                  <Th label="Code" full="Odoo product code" />
                  <Th label="Product" />
                  <Th label="UOM" center />
                  <Th label="Store count" full="Physically in the internal store" num group="input" />
                  <Th label="SF01 in Odoo" full="SF01's stock in Odoo" num group="source" />
                  {need && <Th label="Open need" full="Sheets the open orders still need" hint="The pieces Fabrication still owes on every open order not on hold × the MATERIAL tab's sheets a piece (the actual nesting, or the BOM's rate where not nested yet — marked ≈)." num group="computed" />}
                  {need && <Th label="After need" full="SF01 in Odoo − open need" hint="Below zero Odoo holds fewer sheets than the open orders still need." num group="computed" />}
                  <Th label="Difference" full="Store count − Odoo" hint="Below zero the store holds less than Odoo says; above zero, more." num group="computed" />
                  <Th label="vs Odoo" full="The difference as a share of Odoo's stock" num group="computed" />
                  <Th label="Status" center />
                  <Th label="Note" />
                </tr>
              </thead>
              <tbody>
                {groups.map(({ g, rows }) => {
                  const s = summarizeStock(rows);
                  const open = !folded.has(g);
                  return (
                    <Fragment key={g}>
                      <tr className="mat-group">
                        <td className="p-2" colSpan={3}>
                          <button type="button" onClick={() => toggle(g)} aria-expanded={open} className="inline-flex items-center gap-1.5 font-bold">
                            <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
                            {g}
                            <span className="text-xs text-muted font-semibold tabnum">· {rows.length} item{rows.length === 1 ? "" : "s"}</span>
                          </button>
                        </td>
                        <td className="p-2" colSpan={need ? 6 : 4}>
                          <span className="flex flex-wrap gap-x-4 text-xs tabnum">
                            {s.byUom.map((u) => (
                              <span key={u.uom} className="text-muted">
                                {u.uom}: <b className="text-foreground">{qty(u.physical)}</b> / {qty(u.odoo)} · <Gap n={u.diff} />
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="p-2 text-center text-xs" colSpan={2}>
                          {s.short > 0 && <span className="pill pill-bad me-1">{s.short} short</span>}
                          {s.over > 0 && <span className="pill pill-warn">{s.over} over</span>}
                        </td>
                      </tr>
                      {open && rows.map((i) => <StockRow key={i.id} i={i} canEdit={canEdit} need={need ? needOf(i) ?? null : undefined} />)}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>
      <p className="text-xs text-muted">
        {lastUpdate ? <>Last change {formatDateTime(lastUpdate.atISO)}{lastUpdate.by ? ` · ${lastUpdate.by}` : ""}. </> : null}
        A difference under a hundredth of a piece (or a kilo on coils) counts as matching. Totals never add pieces and kilos together.
        {need && " The open need is in sheets, so codes held in kilos show it without an after figure."}
      </p>
      {needFailed && <p className="text-xs text-warn-fg">The open orders&apos; need could not be worked out just now — the stock above is complete; reload to try again.</p>}
      {need && (need.unpriced.noNesting > 0 || need.unpriced.uncoded > 0) && (
        <p className="text-xs text-muted">
          Not in the open need: {[need.unpriced.noNesting > 0 && `${need.unpriced.noNesting} part${need.unpriced.noNesting === 1 ? "" : "s"} with no nesting line yet`, need.unpriced.uncoded > 0 && `${need.unpriced.uncoded} nesting line${need.unpriced.uncoded === 1 ? "" : "s"} with no product code`].filter(Boolean).join(" and ")} — the need is at least what is shown.
        </p>
      )}
      {need && need.missing.length > 0 && (
        <p className="text-xs text-warn-fg">
          {need.missing.length} code{need.missing.length === 1 ? "" : "s"} the open orders need {need.missing.length === 1 ? "is" : "are"} not on this table:{" "}
          {need.missing.slice(0, 12).map((m) => `${m.code} (${qty(m.sheets)} sheets)`).join(", ")}{need.missing.length > 12 ? ", …" : ""}.
        </p>
      )}
    </div>
  );
}

/** A signed gap in its tone: short red, over amber, none quiet. */
function Gap({ n }: { n: number }) {
  if (n === 0) return <span className="text-muted">0</span>;
  return <b className={n < 0 ? "text-bad-fg" : "text-warn-fg"}>{n > 0 ? "+" : "−"}{qty(Math.abs(n))}</b>;
}

function SummaryCards({ summary, onPick, picked, need }: {
  summary: ReturnType<typeof summarizeStock>;
  onPick: (s: StockStatus) => void;
  picked: string;
  need: { short: number; missing: number; picked: boolean; onPick: () => void } | null;
}) {
  const card = (s: StockStatus | "all", label: string, n: number, tone: string, note: string) => (
    <button
      key={s}
      type="button"
      onClick={() => s !== "all" && onPick(s)}
      aria-pressed={picked === s}
      disabled={s === "all"}
      className={`kpi text-start transition-colors ${s !== "all" ? "hover:border-brand/60" : "cursor-default"} ${picked === s ? "border-brand ring-2 ring-brand/30" : ""}`}
    >
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`kpi-value ${tone}`}>{n}</div>
      <div className="text-[11px] text-muted truncate">{note}</div>
    </button>
  );
  return (
    <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 xl:grid-cols-6">
      {card("all", "Items", summary.items, "", `${summary.empty} held nowhere`)}
      {card("match", "Matches Odoo", summary.match, "text-ok-fg", "store = SF01")}
      {card("short", "Store short", summary.short, "text-bad-fg", "less on the shelf than in Odoo")}
      {card("over", "Store over", summary.over, "text-warn-fg", "more on the shelf than in Odoo")}
      {need && (
        <button type="button" onClick={need.onPick} aria-pressed={need.picked}
          className={`kpi text-start transition-colors hover:border-brand/60 ${need.picked ? "border-brand ring-2 ring-brand/30" : ""}`}>
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Short for open orders</div>
          <div className={`kpi-value ${need.short > 0 ? "text-bad-fg" : "text-ok-fg"}`}>{need.short}</div>
          <div className="text-[11px] text-muted truncate">{need.missing > 0 ? `${need.missing} needed code${need.missing === 1 ? "" : "s"} not on the table` : "need more than Odoo or the store holds"}</div>
        </button>
      )}
      {summary.byUom.map((u) => (
        <div key={u.uom} className="kpi">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Total · {u.uom}</div>
          <div className="kpi-value"><Gap n={u.diff} /></div>
          <div className="text-[11px] text-muted tabnum truncate">store {qty(u.physical)} · Odoo {qty(u.odoo)}</div>
        </div>
      ))}
    </div>
  );
}

/** The open need of one code: the sheets, ≈ where part of it is still at the
 *  BOM's rate, and the orders behind it on hover or focus. */
function NeedCell({ n }: { n: StockNeed | null }) {
  if (!n) return <td className="p-2 text-end text-muted">—</td>;
  return (
    <td className="p-2 text-end tabnum">
      <Tooltip content={
        <span className="block max-w-[18rem] text-xs">
          <span className="block font-semibold">{n.orders} order{n.orders === 1 ? "" : "s"} need {qty(n.need)} sheets{n.estimated ? " (partly at the BOM's rate)" : ""}</span>
          {n.jobs.map((j) => <span key={`${j.mo}|${j.item}`} className="block">{j.mo} · {j.item} · {qty(j.sheets)}</span>)}
          {n.jobCount > n.jobs.length && <span className="block opacity-75">…and {n.jobCount - n.jobs.length} more</span>}
        </span>
      }>
        <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">{n.estimated ? "≈" : ""}{qty(n.need)}</span>
      </Tooltip>
    </td>
  );
}

/** Odoo's stock after the need: short red, store-short amber, kilos not comparable. */
function AfterCell({ n }: { n: StockNeed | null }) {
  if (!n) return <td className="p-2 text-end text-muted">—</td>;
  const why = n.after === null ? "Held in another unit — sheets cannot be set against it." : n.status === "store_short" ? "Odoo holds enough, but the store counted fewer than the open orders need." : null;
  const tone = n.status === "short" ? "text-bad-fg font-bold" : n.status === "store_short" ? "text-warn-fg font-semibold" : n.after === null ? "text-xs text-muted" : "";
  const value = n.after === null ? "n/a" : `${n.after < 0 ? "−" : ""}${qty(Math.abs(n.after))}`;
  return (
    <td className={`p-2 text-end tabnum ${tone}`}>
      {why ? <Tooltip content={<span className="block max-w-[16rem] text-xs">{why}</span>}><span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">{value}</span></Tooltip> : value}
    </td>
  );
}

function StockRow({ i, canEdit, need }: { i: PhysicalStockItem; canEdit: boolean; need?: StockNeed | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const [confirmIt, confirmDialog] = useConfirm();
  const save = (field: "code" | "name" | "uom" | "physical" | "odoo" | "note", value: string) => {
    const fd = new FormData();
    fd.set("id", String(i.id)); fd.set("field", field); fd.set("value", value);
    setErr("");
    start(async () => {
      const r = await updatePhysicalCell(fd);
      if (r.ok) router.refresh(); else setErr(r.error ?? "Failed");
    });
  };
  const row = useRowMenu(() => [
    { heading: i.code },
    {
      key: "delete", label: "Remove from the table…", icon: "🗑", danger: true,
      onSelect: async () => {
        const ok = await confirmIt({ title: `Remove ${i.code}?`, body: <>It leaves this table; the next upload that carries it brings it back.</>, items: [`${i.code} · ${i.name}`], confirmLabel: "Remove", danger: true });
        if (!ok) return;
        const fd = new FormData(); fd.set("id", String(i.id));
        start(async () => { const r = await deletePhysicalItem(fd); if (r.ok) router.refresh(); else setErr(r.error ?? "Failed"); });
      },
    },
  ], `Actions for ${i.code}`);
  const num = (field: "physical" | "odoo", v: number) =>
    canEdit ? (
      <CellEditor value={String(v)} col={field} onCommit={(x) => save(field, x)} disabled={pending} min="0" step="any" inputMode="decimal" ariaLabel={`${field === "physical" ? "Store count" : "Odoo stock"} for ${i.code}`} className="!w-24 text-end" />
    ) : <span className="tabnum">{qty(v)}</span>;
  return (
    <tr className={pending ? "opacity-60" : ""} onContextMenu={canEdit ? row.onContextMenu : undefined}>
      {canEdit ? (
        <>
          <td className="p-1"><CellEditor value={i.code} col="code" type="text" onCommit={(x) => save("code", x)} disabled={pending} ariaLabel={`Product code ${i.code}`} className="!w-44 font-semibold ltr text-xs" /></td>
          <td className="p-1 min-w-[16rem]"><CellEditor value={i.name} col="name" type="text" onCommit={(x) => save("name", x)} disabled={pending} ariaLabel={`Product name for ${i.code}`} className="!w-full" /></td>
          <td className="p-1 text-center"><CellEditor value={i.uom} col="uom" type="text" onCommit={(x) => save("uom", x)} disabled={pending} ariaLabel={`UOM for ${i.code}`} className="!w-14 text-center text-xs" /></td>
        </>
      ) : (
        <>
          <td className="p-2 font-semibold ltr whitespace-nowrap text-xs">{i.code}</td>
          <td className="p-2 text-sm min-w-[16rem]">{i.name || <span className="text-muted">—</span>}</td>
          <td className="p-2 text-center text-xs text-muted">{i.uom || "—"}</td>
        </>
      )}
      <td className="p-1 text-end">{num("physical", i.physical)}</td>
      <td className="p-1 text-end">{num("odoo", i.odoo)}</td>
      {need !== undefined && <><NeedCell n={need} /><AfterCell n={need} /></>}
      <td className="p-2 text-end tabnum"><Gap n={i.diff} /></td>
      <td className="p-2 text-end tabnum text-xs">{i.diffPct === null || i.diff === 0 ? <span className="text-muted">—</span> : <span className={i.diff < 0 ? "text-bad-fg" : "text-warn-fg"}>{i.diffPct > 0 ? "+" : ""}{i.diffPct}%</span>}</td>
      <td className="p-2 text-center"><span className={`pill ${STATUS_PILL[i.status]}`}>{STATUS_LABEL[i.status]}</span></td>
      <td className="p-1 min-w-[12rem]">
        <span className="flex items-center gap-1">
          {canEdit ? (
            <CellEditor value={i.note ?? ""} col="note" type="text" onCommit={(x) => save("note", x)} disabled={pending} placeholder="—" title="Why the count differs — Enter saves" ariaLabel={`Note for ${i.code}`} className="!w-full" />
          ) : <span className="text-xs text-muted">{i.note ?? ""}</span>}
          {canEdit && <span className="no-print">{row.button}</span>}
        </span>
        {err && <span className="block text-[10px] text-bad-fg">{err}</span>}
        {row.menu}{confirmDialog}
      </td>
    </tr>
  );
}

/** Upload the store's sheet: picking the file is the upload. The menu offers
 *  the same with the codes the file no longer carries removed. */
function ImportButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [menu, setMenu] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const prune = useRef(false);
  const pick = (withPrune: boolean) => { prune.current = withPrune; setMenu(false); picker.current?.click(); };
  const upload = (file: File) => {
    const fd = new FormData();
    fd.set("file", file);
    if (prune.current) fd.set("prune", "on");
    setMsg(null); setIssues([]); setShowIssues(false);
    start(async () => {
      const r = await importPhysicalAction(fd);
      setIssues(r.issues ?? []);
      if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Import failed." }); return; }
      const gone = r.missing ? (r.removed ? ` · ${r.removed} no longer in the file removed` : ` · ${r.missing} not in this file kept`) : "";
      setMsg({ ok: true, text: `Updated: ${r.added} new, ${r.updated} changed, ${r.unchanged} unchanged${gone}.` });
      router.refresh();
    });
  };
  return (
    <span className="relative inline-flex flex-wrap items-center gap-2">
      <input ref={picker} type="file" accept=".xlsx,.xlsm,.xls,.csv" className="hidden" aria-label="Upload the stock sheet"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
      <span className="inline-flex">
        <button type="button" className="btn btn-sm btn-primary rounded-e-none" disabled={pending} onClick={() => pick(false)}
          title="Reads Product Code, Product Name, the physical count, UOM and SF01's stock in Odoo. Each code's row is updated, never doubled; codes not in the file stay.">
          <Upload size={14} aria-hidden />{pending ? "Uploading…" : "Upload stock sheet"}
        </button>
        <button type="button" className="btn btn-sm btn-primary rounded-s-none border-s border-white/25 !px-1.5" disabled={pending} aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((v) => !v)} title="More upload options">
          <ChevronDown size={13} aria-hidden />
        </button>
      </span>
      {menu && (
        <span className="absolute top-full end-0 z-30 mt-1 w-72 rounded-[10px] border bg-surface shadow-xl p-1 text-sm">
          <button type="button" className="w-full text-start rounded-md px-2 py-1.5 hover:bg-surface-2" onClick={() => pick(true)}>
            Upload and remove the codes no longer in the file
            <span className="block text-xs text-muted">Items added by hand go too if the file lacks them.</span>
          </button>
        </span>
      )}
      {msg && <span className={`text-xs font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
      {issues.length > 0 && (
        <button type="button" className="text-xs font-semibold text-warn-fg hover:underline" onClick={() => setShowIssues((v) => !v)}>
          {issues.length} note{issues.length === 1 ? "" : "s"} from the file
        </button>
      )}
      {showIssues && issues.length > 0 && (
        <ul className="absolute top-full end-0 z-30 mt-1 w-[28rem] max-w-[90vw] max-h-56 overflow-y-auto rounded-[10px] border bg-surface shadow-xl p-2 ps-6 text-xs text-warn-fg list-disc space-y-0.5">
          {issues.map((x, n) => <li key={n}>{x}</li>)}
        </ul>
      )}
    </span>
  );
}

function AddItem() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const F = "ctl w-full";
  return (
    <>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setErr(""); setOpen(true); }}>
        <Plus size={14} aria-hidden />Add item
      </button>
      {open && (
        <Modal title="Add an item" sub="A code the sheet does not carry yet" onClose={() => setOpen(false)} busy={pending} width="max-w-2xl">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              start(async () => {
                const r = await createPhysicalItem(fd);
                if (r.ok) { setOpen(false); router.refresh(); } else setErr(r.error ?? "Failed");
              });
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-sm"><span className="filter-label">Product code</span><input name="code" required className={`${F} ltr`} placeholder="C-SHR-005" /></label>
              <label className="block text-sm"><span className="filter-label">UOM</span><input name="uom" className={F} placeholder="PC or KG" /></label>
              <label className="block text-sm sm:col-span-2"><span className="filter-label">Product name</span><input name="name" className={F} placeholder="HR Sheet 5mm- 1220x2440mm" /></label>
              <label className="block text-sm"><span className="filter-label">Store count</span><input name="physical" type="number" min="0" step="any" className={`${F} tabnum`} /></label>
              <label className="block text-sm"><span className="filter-label">SF01 in Odoo</span><input name="odoo" type="number" min="0" step="any" className={`${F} tabnum`} /></label>
            </div>
            {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}
            <div className="flex justify-end gap-2 pt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>{pending ? "Adding…" : "Add item"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
