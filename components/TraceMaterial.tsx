"use client";

import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { EMPTY_MATERIAL_FILTERS, materialSummary, type MaterialLineView } from "@/lib/domain/material";
import { FIELD_DP, formatNumber, formatQty } from "@/lib/domain/format";
import { hrefWithLine, type ProductLine } from "@/lib/domain/lines";
import type { UserPrefs } from "@/lib/domain/userPrefs";
import { MATERIAL_FILTERS_KEY, MaterialLinesTable, readSavedFilters } from "@/components/MaterialClient";
import { useStoredFilters } from "@/components/useStoredFilters";
import { TableEmpty } from "@/components/DataTable";

// An order's (or a code's) MATERIAL on its trace: the nesting sheet's lines
// that belong to it (lib/domain/material.ts traceMaterialMatch), what they
// add up to, and the way to the MATERIAL tab already narrowed to it.

export function TraceMaterial({ lines, odooByMo, product, prefs, search, code, mos }: {
  lines: MaterialLineView[];
  odooByMo: Record<string, string>;
  product: ProductLine;
  prefs?: UserPrefs;
  /** What the MATERIAL tab is searched for when opened from here: the order's MO, its SOI or its code. */
  search: string;
  /** The order's code (BOM) and MOs: a line on neither is here through its SOI alone. */
  code: string;
  mos: readonly string[];
}) {
  const lv = product === "LV";
  const router = useRouter();
  const { setFilters } = useStoredFilters(MATERIAL_FILTERS_KEY, readSavedFilters, EMPTY_MATERIAL_FILTERS, product);
  const open = () => {
    setFilters({ ...EMPTY_MATERIAL_FILTERS, q: search });
    router.push(hrefWithLine("/material", product));
  };
  const s = materialSummary(lines);
  // filed under the SOI on a code no order of it carries (a sub-assembly, an
  // older revision) — the same lines show on each of the SOI's orders
  const key = (v: string) => v.trim().toUpperCase();
  const own = new Set(mos.map(key));
  // closed against this order on the ODOO log — the exact link
  const linked = lv ? 0 : lines.filter((l) => l.orderMos.some((m) => own.has(key(m)))).length;
  const viaSoi = lv ? 0 : lines.filter((l) => l.orderMos.length === 0 && key(l.bom) !== key(code) && !own.has(key(l.mo))).length; // the panels' lines are found by their MO
  return (
    <section id="material" className="rounded-2xl bg-surface border border-border/60 shadow-sm overflow-hidden scroll-mt-28">
      <div className="px-5 py-3 border-b border-border/40 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-extrabold uppercase tracking-wide">Material</h2>
        {lines.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="pill pill-muted tabnum">{s.lines} line{s.lines === 1 ? "" : "s"}</span>
            {lv ? (
              <>
                <span className="pill pill-muted tabnum ltr">BOM qty {formatNumber(s.forJob, FIELD_DP.sheets)}</span>
                {s.forProduced !== null && <span className="pill pill-muted tabnum ltr">consumed {formatNumber(s.forProduced, FIELD_DP.sheets)}</span>}
                {s.remainingUnits !== null && <span className="pill pill-muted tabnum ltr">{formatQty(s.remainingUnits)} to make</span>}
              </>
            ) : (
              <>
                <span className="pill pill-muted tabnum ltr">BOM {formatNumber(s.forJob, FIELD_DP.sheets)}</span>
                {s.sheetsUsed !== null && <span className="pill pill-muted tabnum ltr">actual {formatNumber(s.sheetsUsed, FIELD_DP.sheets)}</span>}
                {s.actualWeightKg !== null && <span className="pill pill-muted tabnum ltr">{formatNumber(s.actualWeightKg, 0)} kg</span>}
                <span className={`pill tabnum ${s.overLines ? "pill-bad" : "pill-ok"}`}>{s.overLines ? `${s.overLines} over the BOM` : "within the BOM"}</span>
              </>
            )}
          </div>
        )}
        {linked > 0 && (
          <span className="pill pill-ok tabnum text-xs" title="Lines whose part MO was closed against this order on the ODOO log — linked exactly">
            {linked} linked on ODOO
          </span>
        )}
        {viaSoi > 0 && (
          <span className="pill pill-warn tabnum text-xs" title="Lines not closed on the ODOO log yet that the sheet files under the order's SOI on another code (a sub-assembly, an older revision of the code) — they show on each order of the SOI until their part MO is closed">
            {viaSoi} via the SOI
          </span>
        )}
        <button type="button" onClick={open} className="btn btn-ghost btn-sm ms-auto" title={`Open the MATERIAL tab searched for ${search}`}>
          <ExternalLink size={13} aria-hidden />Open in Material
        </button>
      </div>
      {lines.length === 0 ? (
        <TableEmpty
          title="No material for this order yet"
          hint={lv ? "No line of the Consumption Details sheet carries it." : "No line of the material sheet carries it, and none of its parts' MOs closed on the ODOO log has one."}
        />
      ) : (
        <MaterialLinesTable lines={lines} product={product} odooByMo={odooByMo} prefs={prefs} />
      )}
    </section>
  );
}
