import { round3, type MaterialLineInput } from "@/lib/domain/material";
import { monthLabelFromInput, monthLabelSortKey } from "@/lib/domain/dates";

// ODOO row → its nesting lines. A MATERIAL line is keyed by the transformer's
// BOM and the part code (14003E11M11 × FB-022, the TANK). The row names the
// part in its FG-CODE's prefix (FB-022-…) and the transformer through its
// SOI: the orders registry says which BOM the SOI is for. The FG-CODE's
// suffix is the same BOM for a tank (FB-022-14003E11M11) but the part's own
// drawing code for a top cover or core frame (FB-051-12011E12M12 on
// transformer 12011E16M13), so the SOI's BOM is looked up first and the
// suffix only as the fallback — the path the planner's own search takes.

/** "FB-022-14003E11M11" → part FB-022, BOM 14003E11M11. Null when the code is
 *  not shaped that way (a bare BOM, a typo) — nothing to look up. */
export function splitFgCode(fgCode: string): { partCode: string; bom: string } | null {
  const m = /^\s*([A-Z]{1,3}-\d{2,4})-(\S+)\s*$/i.exec(fgCode);
  if (!m) return null;
  return { partCode: m[1].toUpperCase(), bom: m[2].toUpperCase() };
}

/** "2026-09-07" → "September 2026", the month the tracker files its sheets under. */
export function monthLabelOfISO(iso: string): string {
  return monthLabelFromInput(iso.slice(0, 7)) ?? "";
}

/** One tracker line, as the lookup carries it across the server/client boundary. */
export type NestingLine = Pick<
  MaterialLineInput,
  "month" | "bom" | "partCode" | "partName" | "materialCode" | "material" | "thicknessMm" | "sheetSize" | "units" | "sheetsPerUnit" | "actualPerUnit" | "sheetsUsed" | "note"
> & {
  id: number;
  /** The order the line was nested for, as the sheet files it — "" (or
   *  absent) for a line that covers the BOM as a whole. */
  soi?: string;
  mo?: string;
};

/** Lines keyed "FB-022|14003E11M11" — the lookup the log page hands the rows. */
export type NestingLookup = Record<string, NestingLine[]>;

export const nestingKey = (partCode: string, bom: string) => `${partCode}|${bom}`;

export interface MaterialNeedLine {
  id: number;
  materialCode: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  units: number; // the tracker's job size
  sheetsPerUnit: number; // BOM rate
  sheetsUsed: number | null; // nested for the whole job, null while not nested
  actualPerUnit: number | null; // the sheet's own rate, or sheetsUsed / units
  /** Sheets the row's quantity needs at the BOM rate. */
  forQtyBom: number;
  /** Sheets the row's quantity really consumes at the nesting's actual rate —
   *  what the planner books in Odoo. Null while the job is not nested. */
  forQtyActual: number | null;
  /** The number to book: actual when nested, else the BOM's. */
  book: number;
  bookIsActual: boolean;
  /** Actual against BOM for the qty, signed, as a percentage of the BOM
   *  (+20 = the nesting used a fifth more than the BOM says). Null while not
   *  nested or when the BOM asks for nothing. */
  variancePct: number | null;
  /** How far off: within VARIANCE_WARN → "ok", past it → "warn", past
   *  VARIANCE_BAD → "bad". Null when there is no variance to judge. */
  varianceTone: VarianceTone | null;
  note: string | null;
}

export type VarianceTone = "ok" | "warn" | "bad";
/** Actual off the BOM by more than this share of the BOM is worth a look… */
export const VARIANCE_WARN = 15;
/** …and past this it is flagged. */
export const VARIANCE_BAD = 30;

export function varianceOf(actual: number | null, bom: number): { pct: number | null; tone: VarianceTone | null } {
  if (actual === null || !(bom > 0)) return { pct: null, tone: null };
  const pct = Math.round(((actual - bom) / bom) * 100);
  const tone: VarianceTone = Math.abs(pct) > VARIANCE_BAD ? "bad" : Math.abs(pct) > VARIANCE_WARN ? "warn" : "ok";
  return { pct, tone };
}

/** How a row's lines were found. Transformers: the SOI's order ("soi") or the
 *  FG-CODE's suffix ("fg"). Panels, keyed by MO: the closing the row was born
 *  from ("ledger"), the MO typed on the row ("odoo"), or one of the SOI's
 *  orders in the registry ("order"). */
export type NeedVia = "soi" | "fg" | "row" | "ledger" | "odoo" | "order";

export interface MaterialNeed {
  partCode: string;
  partName: string;
  bom: string;
  /** The panel order the lines belong to — panels only, null for a part. */
  mo: string | null;
  via: NeedVia;
  qty: number;
  /** The tracker month the lines came from. */
  month: string;
  /** Other months that also carry this part on this BOM. */
  otherMonths: string[];
  lines: MaterialNeedLine[];
  totalBom: number;
  totalActual: number;
  /** The total to book: each line's actual where it was nested — a nested
   *  0 is 0 — and its BOM figure where it was not (blank). */
  totalBook: number;
  notNested: number;
  /** Lines whose actual is off the BOM past the warn line. */
  offBom: number;
  /** The total's own variance, over the nested lines only. */
  totalVariancePct: number | null;
  totalVarianceTone: VarianceTone | null;
}

/** The nesting's rate per unit: the sheet's own figure where the line carries
 *  it, and the job's sheets over its units only where it does not. The popup
 *  multiplies this by the closing's quantity, so it must be the same number
 *  the Material tab shows — not a second recovery of it. */
const actualRate = (stored: number | null, used: number | null, units: number) =>
  stored !== null && stored >= 0 ? stored : used === null || !(units > 0) ? null : used / units;

/** The BOMs a row's material may sit under, in lookup order: the row's own
 *  BOM when it is known (see odooRowBom) and nothing else; otherwise the
 *  SOI's order(s) from the registry first, then the FG-CODE's own suffix. */
export function candidateBoms(fgCode: string, soiBoms: readonly string[], rowBoms: readonly string[] = []): { partCode: string; boms: { bom: string; via: "soi" | "fg" | "row" }[] } | null {
  const key = splitFgCode(fgCode);
  if (!key) return null;
  // the row knows its own BOM (the closing's, the SOI's order …): that one
  // only — never another transformer of the same SOI
  const own = [...new Set(rowBoms.map((b) => b.trim().toUpperCase()).filter(Boolean))];
  if (own.length > 0) return { partCode: key.partCode, boms: own.map((bom) => ({ bom, via: "row" as const })) };
  const boms: { bom: string; via: "soi" | "fg" | "row" }[] = [];
  for (const b of soiBoms) {
    const bom = b.trim().toUpperCase();
    if (bom && !boms.some((x) => x.bom === bom)) boms.push({ bom, via: "soi" });
  }
  if (!boms.some((x) => x.bom === key.bom)) boms.push({ bom: key.bom, via: "fg" });
  return { partCode: key.partCode, boms };
}

/**
 * The material a logged row's quantity needs: the tracker's lines for the
 * row's part on its transformer's BOM, at the row's qty. The BOM comes from
 * the SOI's order when the registry knows it, else from the FG-CODE. The
 * month the row was logged in wins when the tracker has it; otherwise the
 * newest month that does — a BOM nested in August is the same BOM in
 * September. Null when the code cannot be split or no line exists for it.
 */
export function materialNeed(
  lookup: NestingLookup, fgCode: string, qty: number, loggedMonth: string, soiBoms: readonly string[] = [],
  opts: { rowBoms?: readonly string[]; job?: { soi: string | null; odooMo: string } } = {}
): MaterialNeed | null {
  const cand = candidateBoms(fgCode, soiBoms, opts.rowBoms);
  if (!cand) return null;
  const hit = cand.boms
    .map((c) => ({ ...c, lines: jobLines(lookup[nestingKey(cand.partCode, c.bom)] ?? [], opts.job) }))
    .find((c) => c.lines.length > 0);
  if (!hit) return null;
  return buildNeed(hit.lines, { partCode: cand.partCode, bom: hit.bom, mo: null, via: hit.via }, qty, loggedMonth);
}

/** Of a part × BOM's lines, the ones of THIS row's job: the lines nested
 *  for its Odoo MO, else for its SOI, else the lines that cover the BOM as a
 *  whole (no SOI, no MO). Other orders of the same BOM are theirs, not this
 *  row's — they never mix in. */
export function jobLines(lines: readonly NestingLine[], job?: { soi: string | null; odooMo: string }): NestingLine[] {
  if (!job) return [...lines];
  const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
  const mo = norm(job.odooMo);
  const soi = norm(job.soi);
  const byMo = mo ? lines.filter((l) => norm(l.mo) === mo) : [];
  if (byMo.length > 0) return byMo;
  const bySoi = soi ? lines.filter((l) => norm(l.soi) === soi) : [];
  if (bySoi.length > 0) return bySoi;
  return lines.filter((l) => !norm(l.soi) && !norm(l.mo));
}

// ---- panels: the lines are the ORDER's, keyed by its MO ----

/** "SF01/MO/03673-001" → "MO|SF01/MO/03673-001" — the lookup key of a panel
 *  order's lines. A panel's FG code (FG-SUA-AS-AA-000004) names no part, so
 *  its material is filed by MO, not part × BOM. */
export const moKey = (mo: string) => `MO|${mo.trim().toUpperCase()}`;

export interface MoCandidate { mo: string; via: "ledger" | "odoo" | "order" }

/** The MOs a panel row's material may be filed under, in lookup order: the
 *  closing it was born from, the MO typed on the row, then every order the
 *  registry has for its SOI. */
export function candidateMos(e: { mo?: string | null; odooMo: string; soi: string | null }, soiMos: readonly string[]): MoCandidate[] {
  const out: MoCandidate[] = [];
  const add = (raw: string | null | undefined, via: MoCandidate["via"]) => {
    const mo = (raw ?? "").trim().toUpperCase();
    if (mo && !out.some((c) => c.mo === mo)) out.push({ mo, via });
  };
  add(e.mo, "ledger");
  add(e.odooMo, "odoo");
  for (const mo of soiMos) add(mo, "order");
  return out;
}

/** A panel row's material: the lines of the first candidate order that has
 *  any, scaled to the row's qty. Null when no order carries lines yet. */
export function materialNeedByMo(lookup: NestingLookup, cands: readonly MoCandidate[], qty: number, loggedMonth: string): MaterialNeed | null {
  const hit = cands.map((c) => ({ ...c, lines: lookup[moKey(c.mo)] ?? [] })).find((c) => c.lines.length > 0);
  if (!hit) return null;
  const bom = hit.lines.find((l) => l.bom)?.bom ?? "";
  const partCode = hit.lines.find((l) => l.partCode)?.partCode ?? "";
  return buildNeed(hit.lines, { partCode, bom, mo: hit.mo, via: hit.via }, qty, loggedMonth);
}

/** Everything the log page needs to find a row's material, for either line. */
export interface NeedContext {
  /** Panels: rows look their lines up by MO rather than part × BOM. */
  lv: boolean;
  /** The registry's BOM(s) per SOI (transformers). */
  soiBoms: Record<string, string[]>;
  /** The registry's order MO(s) per SOI (panels). */
  soiMos: Record<string, string[]>;
}

export const EMPTY_NEED_CONTEXT: NeedContext = { lv: false, soiBoms: {}, soiMos: {} };

const soiOf = (soi: string | null) => (soi ?? "").trim().toUpperCase();

/** The material behind one logged row at `qty` units, whichever line it is on.
 *  A transformer row looks first for the lines filed under its OWN Odoo MO —
 *  the material sheet names Odoo's MO per part (SF01/MO/20941), the number
 *  typed on the ODOO row — and falls back to its part × BOM. */
export function entryMaterialNeed(
  lookup: NestingLookup,
  e: { fgCode: string; dateISO: string; soi: string | null; odooMo: string; mo?: string | null; bom?: { boms: readonly string[] } },
  qty: number, ctx: NeedContext
): MaterialNeed | null {
  const month = monthLabelOfISO(e.dateISO);
  if (ctx.lv) return materialNeedByMo(lookup, candidateMos(e, ctx.soiMos[soiOf(e.soi)] ?? []), qty, month);
  const odooMo = e.odooMo.trim().toUpperCase();
  const byMo = odooMo ? materialNeedByMo(lookup, [{ mo: odooMo, via: "odoo" }], qty, month) : null;
  return byMo ?? materialNeed(lookup, e.fgCode, qty, month, ctx.soiBoms[soiOf(e.soi)] ?? [], {
    rowBoms: e.bom?.boms ?? [],
    job: { soi: e.soi, odooMo: e.odooMo },
  });
}

function buildNeed(all: readonly NestingLine[], key: { partCode: string; bom: string; mo: string | null; via: NeedVia }, qty: number, loggedMonth: string): MaterialNeed {
  const months = [...new Set(all.map((l) => l.month))].sort((a, b) => monthLabelSortKey(b) - monthLabelSortKey(a) || b.localeCompare(a));
  const month = months.includes(loggedMonth) ? loggedMonth : months[0];
  const q = Number.isFinite(qty) && qty > 0 ? qty : 0;

  const lines: MaterialNeedLine[] = all
    .filter((l) => l.month === month)
    .map((l) => {
      const rate = actualRate(l.actualPerUnit, l.sheetsUsed, l.units);
      const forQtyBom = round3(l.sheetsPerUnit * q);
      const forQtyActual = rate === null ? null : round3(rate * q);
      // the rates compare the same way whatever the qty — judge them, so a
      // qty of 0 still shows how the nesting sits against the BOM
      const v = varianceOf(rate, l.sheetsPerUnit);
      return {
        id: l.id, materialCode: l.materialCode, material: l.material, thicknessMm: l.thicknessMm, sheetSize: l.sheetSize,
        units: l.units, sheetsPerUnit: l.sheetsPerUnit, sheetsUsed: l.sheetsUsed, actualPerUnit: rate,
        forQtyBom, forQtyActual, book: forQtyActual ?? forQtyBom, bookIsActual: forQtyActual !== null,
        variancePct: v.pct, varianceTone: v.tone, note: l.note,
      };
    })
    .sort((a, b) => a.material.localeCompare(b.material) || a.thicknessMm - b.thicknessMm || a.materialCode.localeCompare(b.materialCode));

  return {
    partCode: key.partCode,
    partName: all.find((l) => l.partName)?.partName ?? "",
    bom: key.bom,
    mo: key.mo,
    via: key.via,
    qty: q,
    month,
    otherMonths: months.filter((m) => m !== month),
    lines,
    totalBom: round3(lines.reduce((s, l) => s + l.forQtyBom, 0)),
    totalActual: round3(lines.reduce((s, l) => s + (l.forQtyActual ?? 0), 0)),
    totalBook: round3(lines.reduce((s, l) => s + l.book, 0)),
    notNested: lines.filter((l) => l.forQtyActual === null).length,
    offBom: lines.filter((l) => l.varianceTone === "warn" || l.varianceTone === "bad").length,
    ...(() => {
      // the total compared on the nested lines only — an un-nested line has
      // no actual to hold against its BOM
      const nested = lines.filter((l) => l.actualPerUnit !== null);
      const v = varianceOf(
        nested.length ? nested.reduce((s, l) => s + l.actualPerUnit!, 0) : null,
        nested.reduce((s, l) => s + l.sheetsPerUnit, 0)
      );
      return { totalVariancePct: v.pct, totalVarianceTone: v.tone };
    })(),
  };
}

/** A number as it is pasted into Odoo: up to three decimals, no trailing zeros. */
export function bookText(n: number): string {
  return String(round3(n));
}

/** The whole need as tab-separated text — one line per material, pastes into
 *  a sheet as columns. Code · material · thickness · sheet size · sheets. */
export function materialNeedText(need: MaterialNeed): string {
  const head = ["Code", "Material", "Thk mm", "Sheet", `Sheets for ${need.qty}`, "vs BOM"].join("\t");
  const rows = need.lines.map((l) =>
    [l.materialCode, l.material, l.thicknessMm, l.sheetSize, bookText(l.book) + (l.bookIsActual ? "" : " (BOM)"), varianceText(l.variancePct)].join("\t")
  );
  return [head, ...rows].join("\n");
}

/** "+18%" / "−7%" / "" — the variance as it is written beside a number. */
export function varianceText(pct: number | null): string {
  if (pct === null) return "";
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${Math.abs(pct)}%` : "0%";
}

/** Where a row's Odoo MO stands on the MATERIAL tab: "missing" when the tab
 *  files no line under it, "partial" when some of its lines carry no actual
 *  nesting yet (no sheets nested for the job, no actual rate), "ok" when every
 *  line does, "none" when the row has no MO to look for. */
export type MoMaterialState = "none" | "missing" | "partial" | "ok";

export function moMaterialState(lookup: NestingLookup, odooMo: string | null | undefined): MoMaterialState {
  const mo = (odooMo ?? "").trim();
  if (!mo) return "none";
  const lines = lookup[moKey(mo)] ?? [];
  if (lines.length === 0) return "missing";
  const nested = (l: NestingLine) => l.sheetsUsed !== null || (l.actualPerUnit !== null && l.actualPerUnit >= 0);
  return lines.every(nested) ? "ok" : "partial";
}

/** The row's tint and the words behind it — red, yellow, or green when all is nested. */
export const MO_MATERIAL_FLAG: Record<"missing" | "partial" | "ok", { cls: string; edge: string; text: string }> = {
  ok: { cls: "bg-ok-bg/70", edge: "inset 4px 0 0 var(--ok-fg)", text: "This MO is on the Material tab and every line of it is nested" },
  missing: { cls: "bg-bad-bg/70", edge: "inset 4px 0 0 var(--bad-fg)", text: "This MO is not on the Material tab — no nesting is filed under it" },
  partial: { cls: "bg-warn-bg/70", edge: "inset 4px 0 0 var(--warn-fg)", text: "This MO is on the Material tab, but some of its lines have no actual nested sheets yet" },
};
