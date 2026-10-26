import "server-only";
import { getMaterialDashboard } from "@/lib/server/fabAnalytics";
import { MATERIAL_DEFAULT_DAYS, MATERIAL_HISTORY_DAYS, changePct, kgToT, materialQuery, materialRequest, share } from "@/lib/domain/materialDashboard";
import { hrefWithLine, type ProductLine } from "@/lib/domain/lines";
import type { ReadTool } from "./types";

// The Material dashboard (Dashboards → Material) for the assistant: the same
// loader, the same request reading and the same figures as the page, so the
// two cannot disagree — with what each figure covers beside it.

interface Input {
  line?: ProductLine;
  view?: "consumption" | "nesting";
  from?: string;
  to?: string;
  allTime?: boolean;
  materialName?: string;
  thicknessMm?: number;
  sheetSize?: string;
  part?: string;
  mo?: string;
  soi?: string;
}

const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const t = kgToT;

/** The page's address for the same scope, and the request it reads — the sheet tool reads it too. */
export function materialDashboardScope(i: Input, todayISO: string) {
  const sp: Record<string, string> = {};
  if (i.view) sp.view = i.view;
  if (i.allTime) sp.all = "1";
  else {
    if (i.from) sp.from = i.from;
    if (i.to) sp.to = i.to;
    if (i.from && !i.to) sp.to = todayISO;
  }
  if (i.materialName) sp.material = i.materialName;
  if (i.thicknessMm !== undefined) sp.thickness = String(i.thicknessMm);
  if (i.sheetSize) sp.size = i.sheetSize;
  if (i.part) sp.part = i.part;
  if (i.mo) sp.mo = i.mo;
  if (i.soi) sp.soi = i.soi;
  return materialRequest(sp, todayISO);
}

export const getMaterialDashboardTool: ReadTool<Input> = {
  kind: "read",
  name: "get_material_dashboard",
  title: "Reading the material dashboard",
  description:
    "The Material dashboard (Dashboards → Material) for one line (TR or LV): what the BOM needs (units × BOM sheets per unit), what the nesting took (actual nesting, compared with the BOM on the SAME nested lines), the weighted utilization, the CALCULATED consumption of a period — ODOO rows moved to Done in the period (Cairo day), MO matched to the material sheet, closed qty × sheets per unit (actual nesting rate, else the BOM's, flagged as an estimate) × one sheet's weight — and the estimated scrap on the tonnes whose utilization is known. " +
    "Consumption here is NOT a measured store issue nor the sheets actually cut (those are the machines' sheets on the Floor; the store's balance is Material → Physical). The nesting figures are the current sheet (Now) whatever the period. " +
    `Every figure comes with its coverage: closings linked by MO (rows and units — a blank MO never links, the weight of an unlinked closing is unknown), lines with a known weight (the sheet's own, else size × thickness × density) and utilization, the share consumed at an actual rate, and the sheet copies read (the living sheet, else the newest month that carries the MO — never both). Never present a partial figure as the plant's whole, nor an unknown as zero or 100%. ` +
    `Period: from/to (YYYY-MM-DD, at most ${MATERIAL_HISTORY_DAYS} days back; the last ${MATERIAL_DEFAULT_DAYS} days if none), or allTime. Filters: materialName, thicknessMm, sheetSize, part (code or name), mo, soi. view picks the detail rows: consumption (lines consumed in the period, default) or nesting (every line).`,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      line: { type: "string", enum: ["TR", "LV"], description: "The product line; defaults to the chat's line." },
      view: { type: "string", enum: ["consumption", "nesting"], description: "Which detail rows: consumed in the period (default) or the whole current sheet." },
      from: { type: "string", format: "date", description: "First day of the consumption period (YYYY-MM-DD)." },
      to: { type: "string", format: "date", description: "Last day (YYYY-MM-DD); today when left out." },
      allTime: { type: "boolean", description: "Every closing on record instead of a period." },
      materialName: { type: "string", minLength: 1, maxLength: 80, description: "One material, as the sheet writes it (HR Sheet, Galvanized steel …)." },
      thicknessMm: { type: "number", minimum: 0.1, maximum: 200, description: "One thickness, in mm." },
      sheetSize: { type: "string", minLength: 1, maxLength: 40, description: "One sheet size, as the sheet writes it (1220*2440 …)." },
      part: { type: "string", minLength: 1, maxLength: 80, description: "One part: its code (FB-022) or name (TANK)." },
      mo: { type: "string", minLength: 1, maxLength: 80, description: "One MO." },
      soi: { type: "string", minLength: 1, maxLength: 80, description: "One SOI." },
    },
  },
  // the dashboard's own screen
  tabs: ["analytics"],
  cacheable: true,
  parse(raw) {
    const i = raw as Input;
    if (i.allTime && (i.from || i.to)) return "Give a period (from/to) or allTime, not both.";
    if (i.from && i.to && i.from > i.to) return "from must not be after to.";
    return i;
  },
  status: (i) => `Reading the material dashboard${i?.line ? ` (${i.line})` : ""}`,
  async run(i, ctx) {
    const line: ProductLine = i.line ?? ctx.line ?? "TR";
    const req = materialDashboardScope(i, ctx.todayISO);
    const a = await getMaterialDashboard(req, line, { maxRows: 25 });
    const n = a.nesting, c = a.consumption, p = a.prevConsumption, l = a.link;
    const q = materialQuery(req, {}, ctx.todayISO);
    return {
      ok: true,
      text: JSON.stringify({
        line, view: req.view,
        period: req.fromISO ? { from: req.fromISO, to: req.toISO, previous: req.prev } : "all time",
        filters: req.filters,
        nestingNow: {
          bomPlanned: { tonnes: t(n.planned.kg), sheets: n.planned.sheets, sheetsOfUnknownWeight: n.planned.unknownWeightSheets, lines: n.planned.lines, mos: n.planned.mos },
          nested: { tonnes: t(n.nested.kg), sheets: n.nested.sheets, sheetsOfUnknownWeight: n.nested.unknownWeightSheets, lines: n.nested.lines, ofLines: n.nested.linesTotal, mos: n.nested.mos },
          varianceOnNestedLines: { tonnes: t(n.variance.kg), sheets: n.variance.sheets, bomTonnesOfThoseLines: t(n.variance.bomKg), lines: n.variance.lines, note: "Nested − BOM on the same lines only; >0 = the nesting took more." },
          weightedUtilization: r2(n.utilization),
          utilizationCoverage: { knownTonnes: t(n.utilizationKg), ofNestedTonnes: t(n.nested.kg), share: r2(share(n.utilizationKg, n.nested.kg)) },
          scrapOnKnownCoverage: { tonnes: t(n.scrapKg), netTonnes: t(n.netKg), tonnesWithUnknownUtilization: t(n.unknownUtilKg) },
        },
        consumptionInPeriod: {
          tonnes: t(c.kg), sheets: c.sheets, sheetsOfUnknownWeight: c.unknownWeightSheets, closings: c.closings, unitsClosed: c.units, mos: c.mos, closingDays: c.days,
          estimatedFromBom: { sheets: c.bomRateSheets, tonnes: t(c.bomRateKg) },
          scrapOnKnownCoverage: c.utilizationKg > 0 ? { tonnes: t(c.scrapKg), coveredTonnes: t(c.utilizationKg), netTonnes: t(c.netKg), share: r2(share(c.utilizationKg, c.kg)) } : "unknown — no consumed line has a utilization",
          changeVsPreviousPeriodPct: { tonnes: changePct(c.kg, p?.kg), scrap: p && p.utilizationKg > 0 ? changePct(c.scrapKg, p.scrapKg) : null, note: "null = no base (no period before, or zero)." },
        },
        closingLinkCoverage: {
          rows: l.rows, units: l.qty, linkedRows: l.linkedRows, linkedUnits: l.linkedQty, blankMoRows: l.blankRows, blankMoUnits: l.blankQty, offSheetRows: l.offSheetRows, offSheetUnits: l.offSheetQty,
          offSheetMos: l.offSheetMos, mosClosedPastTheirUnits: l.overClosedMos,
          note: "Shares of rows and of units, not of weight: an unlinked closing has no rate, so its weight is unknown. Counted for the line, before the filters.",
        },
        dataCoverage: a.coverage,
        sheetVersions: a.versions,
        actions: a.actions.map((x) => `${x.tone}: ${x.text}`),
        breakdownByThickness: a.breakdown.map((b) => ({ key: b.key, bomT: t(b.bom.kg), nestedT: t(b.nested.kg), consumedT: t(b.consumed.kg), consumedSheets: b.consumed.sheets, scrapT: t(b.scrapKg) })),
        actualVsBomByPart: a.parts.slice(0, 15),
        mostOverTheBom: a.overruns,
        detail: { rows: a.rows, rowsTotal: a.rowsTotal, totals: a.totals, note: "closedQty is the MO's, on each of its lines; totals count each MO once. Ask make_excel (material_dashboard) for every row." },
        updated: { sheet: a.sheetUpdatedISO, odooLog: a.odooUpdatedISO },
      }),
      links: [{ label: "Material dashboard", href: hrefWithLine(`/dashboards/material${q ? `?${q}` : ""}`, line) }],
    };
  },
};

export const MATERIAL_DASHBOARD_TOOLS = [getMaterialDashboardTool] as const;
