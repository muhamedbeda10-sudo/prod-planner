"use client";

import { formatDate } from "@/lib/domain/format";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EMPTY_MATERIAL_FILTERS, type MaterialFilters } from "@/lib/domain/material";
import {
  bookText, candidateBoms, candidateMos, entryMaterialNeed, materialNeedText, moKey, monthLabelOfISO, nestingKey, VARIANCE_BAD, VARIANCE_WARN, varianceText,
  type MaterialNeed, type NeedContext, type NeedVia, type NestingLookup, type VarianceTone,
} from "@/lib/domain/odooMaterial";
import type { OdooEntryView } from "@/lib/domain/odoo";
import { Soi } from "@/components/ui";
import { parseSaved, useStoredFilters } from "@/components/useStoredFilters";

// The material behind a logged Odoo row, in a popup on the row itself: the
// planner used to take the SOI to the MATERIAL tab, search it, and work out
// by hand what the row's qty consumed before booking it in Odoo. Now the row
// opens its nesting lines scaled to its qty, each number one click from the
// clipboard — the qty can be changed here for a partial close.

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http or a denied permission — the old way still works
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async (id: string, text: string) => {
    const ok = await writeClipboard(text);
    setCopied(ok ? id : null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { copied, copy };
}

function CopyBtn({ id, text, copied, onCopy, label, className = "" }: {
  id: string; text: string; copied: string | null; onCopy: (id: string, text: string) => void; label?: string; className?: string;
}) {
  const done = copied === id;
  return (
    <button
      type="button"
      className={`btn btn-sm ${done ? "btn-primary" : "btn-secondary"} ${className}`}
      title={`Copy ${text}`}
      onClick={() => onCopy(id, text)}
    >
      {done ? "Copied ✓" : label ?? "Copy"}
    </button>
  );
}

const per4 = (n: number | null) => (n === null ? "—" : n.toFixed(4).replace(/\.?0+$/, ""));

// A line whose nesting sits far from its BOM is the one to look at before
// booking: the actual cell and the "vs BOM" pill take the tone, the row a
// tint, so it is caught at a glance rather than read off the decimals.
const TONE_PILL: Record<VarianceTone, string> = { ok: "pill-muted", warn: "pill-warn", bad: "pill-bad" };
const TONE_ROW: Record<VarianceTone, string> = { ok: "", warn: "bg-warn-bg/40", bad: "bg-bad-bg/50" };
const TONE_INK: Record<VarianceTone, string> = { ok: "", warn: "text-warn-fg", bad: "text-bad-fg" };

function VariancePill({ pct, tone }: { pct: number | null; tone: VarianceTone | null }) {
  if (pct === null || tone === null) return <span className="text-muted">—</span>;
  const title =
    tone === "bad" ? `Actual is ${Math.abs(pct)}% ${pct > 0 ? "over" : "under"} the BOM — more than ${VARIANCE_BAD}%: check the nesting before booking`
    : tone === "warn" ? `Actual is ${Math.abs(pct)}% ${pct > 0 ? "over" : "under"} the BOM — more than ${VARIANCE_WARN}%`
    : "Actual sits close to the BOM";
  return (
    <span className={`pill ${TONE_PILL[tone]} tabnum ltr`} title={title}>
      {tone === "bad" ? "⚠ " : ""}{varianceText(pct)}
    </span>
  );
}

const MATERIAL_FILTERS_KEY = "material:filters";
const readMaterialFilters = (raw: string) => parseSaved(raw) as Partial<MaterialFilters>;

/** Go to the MATERIAL tab already narrowed to this part on this BOM. */
function useOpenInMaterial() {
  const router = useRouter();
  const { setFilters } = useStoredFilters(MATERIAL_FILTERS_KEY, readMaterialFilters, EMPTY_MATERIAL_FILTERS);
  return (q: string, partCode: string, month: string) => {
    setFilters({ ...EMPTY_MATERIAL_FILTERS, q, partCode });
    router.push(month ? `/material?month=${encodeURIComponent(month)}` : "/material");
  };
}

const VIA_TEXT: Record<NeedVia, string> = {
  soi: "via the SOI's order",
  fg: "from the row's code",
  row: "the row's own BOM",
  ledger: "the closing this row came from",
  odoo: "the MO typed on the row",
  order: "one of the SOI's orders",
};

function NeedTable({ need, copied, copy, lv }: { need: MaterialNeed; copied: string | null; copy: (id: string, text: string) => void; lv: boolean }) {
  // panels consume sheets on the order; transformer parts are nested
  const none = lv ? "not consumed" : "not nested";
  return (
    <div className="overflow-x-auto border rounded-xl">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 text-left text-xs">
            <th className="p-2">Code</th>
            <th className="p-2">Material</th>
            <th className="p-2 text-center">Thk</th>
            <th className="p-2">Sheet</th>
            <th className="p-2 text-right" title="Sheets one unit needs in the nesting BOM">BOM / unit</th>
            <th className="p-2 text-right" title="Sheets actually nested for the job ÷ its units">Actual / unit</th>
            <th className="p-2 text-right" title={`${need.qty} × BOM per unit`}>For {need.qty} (BOM)</th>
            <th className="p-2 text-right" title={`${need.qty} × actual per unit — the number to book`}>For {need.qty} (actual)</th>
            <th className="p-2 text-center" title={`Actual against BOM — past ±${VARIANCE_WARN}% it is amber, past ±${VARIANCE_BAD}% red`}>vs BOM</th>
            <th className="p-2" />
          </tr>
        </thead>
        <tbody>
          {need.lines.map((l) => (
            <tr key={l.id} className={`border-t ${l.varianceTone ? TONE_ROW[l.varianceTone] : ""}`}>
              <td className="p-2 ltr text-xs font-bold whitespace-nowrap">{l.materialCode || <span className="text-muted">—</span>}</td>
              <td className="p-2 whitespace-nowrap">{l.material}</td>
              <td className="p-2 text-center tabnum">{l.thicknessMm}</td>
              <td className="p-2 ltr tabnum text-xs whitespace-nowrap">{l.sheetSize}</td>
              <td className="p-2 text-right tabnum">{per4(l.sheetsPerUnit)}</td>
              <td className="p-2 text-right tabnum">{per4(l.actualPerUnit)}</td>
              <td className="p-2 text-right tabnum">{bookText(l.forQtyBom)}</td>
              <td className={`p-2 text-right tabnum font-extrabold text-base ${l.varianceTone ? TONE_INK[l.varianceTone] : ""}`}>
                {l.forQtyActual === null ? (
                  <span className="text-muted font-semibold text-xs" title={`${lv ? "Nothing consumed" : "Not nested"} yet — the BOM number is what there is`}>
                    {none}
                  </span>
                ) : (
                  bookText(l.forQtyActual)
                )}
              </td>
              <td className="p-2 text-center whitespace-nowrap"><VariancePill pct={l.variancePct} tone={l.varianceTone} /></td>
              <td className="p-2 text-right whitespace-nowrap">
                <CopyBtn id={`l${l.id}`} text={bookText(l.book)} copied={copied} onCopy={copy} label={l.bookIsActual ? "Copy" : "Copy BOM"} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t bg-surface-2 font-bold">
            <td className="p-2 text-xs" colSpan={6}>
              Total sheets{need.notNested > 0 && <span className="text-muted font-normal"> · {need.notNested} line(s) {none} yet</span>}
            </td>
            <td className="p-2 text-right tabnum">{bookText(need.totalBom)}</td>
            <td className={`p-2 text-right tabnum ${need.totalVarianceTone ? TONE_INK[need.totalVarianceTone] : ""}`}>{bookText(need.totalActual)}</td>
            <td className="p-2 text-center"><VariancePill pct={need.totalVariancePct} tone={need.totalVarianceTone} /></td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function OdooMaterialPopup({ e, nesting, needCtx, onClose }: { e: OdooEntryView; nesting: NestingLookup; needCtx: NeedContext; onClose: () => void }) {
  const [qty, setQty] = useState(String(e.qty));
  const { copied, copy } = useCopy();
  const openInMaterial = useOpenInMaterial();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = Number(qty);
  const soiKey = (e.soi ?? "").trim().toUpperCase();
  const need = entryMaterialNeed(nesting, e, Number.isFinite(q) ? q : 0, needCtx);
  // transformers: the part × BOM pairs that were tried; panels: the orders
  const cand = needCtx.lv ? null : candidateBoms(e.fgCode, needCtx.soiBoms[soiKey] ?? [], e.bom.boms);
  const mos = needCtx.lv ? candidateMos(e, needCtx.soiMos[soiKey] ?? []) : [];
  const partCode = need?.partCode ?? cand?.partCode ?? "";
  const bom = need?.bom ?? cand?.boms[0]?.bom ?? e.fgCode;
  // what the Material tab is searched for on the way over: the order for a
  // panel, the BOM for a part
  const openQuery = needCtx.lv ? (need?.mo ?? mos[0]?.mo ?? bom) : bom;
  // when nothing matched: which of the looked-up BOMs the tracker has at all,
  // and for which parts — "the BOM is there, the part isn't" is the usual case
  const bomsSeen = cand
    ? cand.boms.map((c) => ({
        ...c,
        parts: [...new Set(Object.keys(nesting).filter((k) => k.endsWith(`|${c.bom}`) && nesting[k].length > 0).map((k) => k.split("|")[0]))],
        // the part IS nested on this BOM — for other orders, not this row's
        others: [...new Set((nesting[nestingKey(cand?.partCode ?? "", c.bom)] ?? []).map((l) => l.soi || l.mo || "").filter(Boolean))],
      }))
    : [];

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-3 text-left font-normal" role="dialog" aria-modal="true" aria-label={`Material for ${e.odooMo}`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
      <div ref={box} tabIndex={-1} className="relative w-full max-w-4xl max-h-[92vh] overflow-y-auto bg-surface text-foreground border rounded-xl shadow-lg p-4 outline-none focus-visible:outline-none">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 mb-3">
          <div className="min-w-0">
            <div className="font-extrabold text-base">🧱 Material for <span className="ltr">{e.odooMo || need?.mo || e.mo || e.bom.boms.join(" / ") || e.product}</span></div>
            <div className="text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
              <span>SOI <Soi soi={e.soi} className="text-foreground" /></span>
              {e.bom.boms.length > 0 && <span>BOM <b className="ltr text-foreground">{e.bom.boms.join(" / ")}</b></span>}
              <span>{e.product}{need?.partName && need.partName.toLowerCase() !== e.product.toLowerCase() ? ` (${need.partName})` : ""}</span>
              <span>logged <b className="tabnum ltr text-foreground">{formatDate(e.dateISO)}</b> · qty <b className="tabnum text-foreground">{e.qty}</b></span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto btn btn-sm btn-ghost">✕</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="inline-flex items-center gap-1.5 text-sm font-semibold">
            Sheets for
            <input
              type="number" min={0} step="any" value={qty} onChange={(ev) => setQty(ev.target.value)}
              aria-label="Quantity" title="Change to see the material for a different quantity — a partial close"
              className="border rounded-md px-2 py-1 w-20 bg-surface font-extrabold tabnum text-center"
            />
            units
          </label>
          {need && need.lines.length > 0 && (
            <>
              <CopyBtn id="all" text={materialNeedText(need)} copied={copied} onCopy={copy} label="Copy table" />
              <CopyBtn
                id="codes" copied={copied} onCopy={copy} label="Copy codes + sheets"
                text={need.lines.map((l) => `${l.materialCode}\t${bookText(l.book)}`).join("\n")}
              />
            </>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openInMaterial(openQuery, partCode, need?.month ?? monthLabelOfISO(e.dateISO))}>
            Open in Material →
          </button>
          {need && (
            <span className="text-xs text-muted ml-auto">
              {need.mo ? (
                <>MO <b className="ltr text-foreground">{need.mo}</b> — {VIA_TEXT[need.via]}{need.bom && <> · BOM <b className="ltr text-foreground">{need.bom}</b></>}</>
              ) : (
                <>BOM <b className="ltr text-foreground">{need.bom}</b> {VIA_TEXT[need.via]}</>
              )} ·{" "}
              <b>{need.month || "untagged"}</b> {needCtx.lv ? "sheet" : "tracker"} · {needCtx.lv ? "order" : "job"} of <b className="tabnum">{need.lines[0]?.units ?? "—"}</b> units
              {need.otherMonths.length > 0 && <> · also in {need.otherMonths.join(", ")}</>}
            </span>
          )}
        </div>

        {!need ? (
          <p className="text-sm text-muted border rounded-xl p-4">
            {needCtx.lv ? (
              mos.length > 0 ? (
                <>
                  No material lines in the Material tab for{" "}
                  {mos.map((c, i) => (
                    <span key={c.mo}>
                      {i > 0 && " or "}
                      MO <b className="ltr">{c.mo}</b> ({VIA_TEXT[c.via]}{nesting[moKey(c.mo)] ? "" : ", not in the tab"})
                    </span>
                  ))}
                  {" "}— add the order there (its thickness rows come from the BOM&apos;s template) or import the Consumption Details sheet.
                </>
              ) : (
                <>
                  The row names no order: it was not born from a painting closing, has no MO typed, and its SOI{" "}
                  {e.soi ? <>(<b className="ltr">{e.soi}</b>) has no order in the registry</> : "is blank"} — type Odoo&apos;s MO on the row and its material can be looked up.
                </>
              )
            ) : cand ? (
              <>
                No nesting line for <b className="ltr">{cand.partCode}</b> in the Material tab under{" "}
                {bomsSeen.map((c, i) => (
                  <span key={c.bom}>
                    {i > 0 && " or "}
                    BOM <b className="ltr">{c.bom}</b> ({c.via === "row" ? "this row's BOM" : c.via === "soi" ? "the SOI's order" : "the row's code"}
                    {c.others.length > 0 ? `, nested only for other orders: ${c.others.join(", ")}` : c.parts.length > 0 ? `, has ${c.parts.join(", ")}` : ", not in the tracker"})
                  </span>
                ))}
                {" "}— add it there or import the month&apos;s tracker.
                {!e.soi && <> The row has no SOI, so only its own code could be tried.</>}
              </>
            ) : (
              <>The row carries no part code to look its material up by.</>
            )}
          </p>
        ) : (
          <>
            {need.offBom > 0 && (
              <p className={`text-sm font-semibold rounded-lg px-3 py-2 mb-2 ${need.lines.some((l) => l.varianceTone === "bad") ? "bg-bad-bg text-bad-fg" : "bg-warn-bg text-warn-fg"}`}>
                ⚠ {need.offBom} line(s) where the actual {needCtx.lv ? "consumption" : "nesting"} is far from the BOM
                {need.totalVariancePct !== null && <> · overall <b className="tabnum ltr">{varianceText(need.totalVariancePct)}</b> against the BOM</>}
                . Check them before booking.
              </p>
            )}
            <NeedTable need={need} copied={copied} copy={copy} lv={needCtx.lv} />
          </>
        )}
        <p className="text-[11px] text-muted mt-2">
          {needCtx.lv ? (
            <><b>For qty (actual)</b> = sheets actually consumed on the order ÷ the units it produced them for × this qty — what to book in Odoo. Where nothing
            was consumed yet, Copy takes the BOM number instead and says so.</>
          ) : (
            <><b>For qty (actual)</b> = sheets actually nested for the job ÷ its units × this qty — what to book in Odoo. Where nothing was
            nested yet, Copy takes the BOM number instead and says so.</>
          )}{" "}
          <b>vs BOM</b> is the actual against the BOM: past ±{VARIANCE_WARN}% amber, past ±{VARIANCE_BAD}% red.
        </p>
      </div>
    </div>
  );
}
