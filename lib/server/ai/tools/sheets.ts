import "server-only";
import { floorRequest } from "@/lib/domain/floorKpis";
import { outputByTypeRows } from "@/lib/domain/outputByType";
import { loadProductionAll } from "@/lib/server/dashboards";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getCatalogue, getCurrentStandings } from "@/lib/server/consumableLimits";
import { getMonthlyReport } from "@/lib/server/consumableMonthly";
import { getConsumableEdits, getConsumablesDashboard, getConsumablesData, getConsumablesDecisions } from "@/lib/server/consumables";
import { getDowntimeDay } from "@/lib/server/downtime";
import { getRecentHandover } from "@/lib/server/handover";
import { ledgerItemWhere, withLine } from "@/lib/server/line";
import { getLvTrace } from "@/lib/server/lvTrace";
import { getLvTracker } from "@/lib/server/lvTracker";
import { getMasterTracker } from "@/lib/server/masterTracker";
import { getMaterialData } from "@/lib/server/material";
import { getOdooDashboard, getOdooData } from "@/lib/server/odoo";
import { getPhysicalStock } from "@/lib/server/physicalStock";
import { getPowderReport } from "@/lib/server/powderScrap";
import { getShiftRoster } from "@/lib/server/shifts";
import { getSoiLookup } from "@/lib/server/soi";
import { getTrace } from "@/lib/server/trace";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import {
  consumableEditRows, consumableLimitRows, consumablesDecisionRows, consumablesLogRows, consumablesMonthlyRows, consumablesSummaryRows, dailyLogRows, downtimeRows,
  lvTraceRows, lvTrackerRows, masterTrackerRows, materialRows, odooDailyRows, odooLogRows, physicalRows, powderRows, registryRows, rosterRows,
  traceRows, type SheetRow,
} from "@/lib/server/sheets";
import { blockedTableIn, blockedTablesFor } from "@/lib/domain/ai";
import { AI_FILE_LIMITS } from "@/lib/domain/aiFiles";
import { pastMonthOf } from "@/lib/domain/consumableMonthly";
import { consumablesPeriod } from "@/lib/domain/consumables";
import { readDecisionFilters } from "@/lib/domain/consumablesDecisions";
import { filterLogRows, logRowsOf } from "@/lib/domain/dailyLogView";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryToday } from "@/lib/domain/dates";
import type { ProductLine } from "@/lib/domain/lines";
import { aiFileHref, aiPrintHref } from "@/lib/domain/links";
import { parseOdooScope } from "@/lib/domain/odoo";
import { resolvePeriod } from "@/lib/domain/odooStats";
import { filterOrderRows, orderRowOf } from "@/lib/domain/registryView";
import { parseRosterFilter, rosterDepts, rosterLineMatches, type RosterFilter } from "@/lib/domain/roster";
import { filterLvTracker, filterMasterTracker, trackerStagesOf, type TrackerFilters } from "@/lib/domain/trackerSummary";
import { WEEKLY_STAGES, filterWeeklyDays, weeklyMetricOf, weeklyPlanRows, weeklyStagesOf } from "@/lib/domain/weeklyPlanView";
import { runAiRows } from "../reader";
import { roomProblem, storeMadeWorkbook } from "../files";
import { TRACKER_FILTER_SCHEMA, trackerFiltersFor } from "./planning";
import type { ReadResult, ReadTool, ToolCtx } from "./types";

// The assistant's spreadsheets. The screens no longer carry an Export button
// (the Floor's worklists aside): the person asks, and the assistant builds
// the same sheet the button did — from the screen's own loader and filters,
// through the same row builder (lib/server/sheets.ts), with the screen's own
// headers — or, for anything no screen lists, from one SELECT. The workbook
// is kept as the person's file in their chat, to download or print.

/** The most rows one sheet carries — far more than any screen lists. */
export const MAX_SHEET_ROWS = 50_000;
const MAX_ROWS_TEXT = MAX_SHEET_ROWS.toLocaleString("en-US");

/** The daily log's own history the data guard judges an entry against, as
 *  the screen loads it (app/handover/page.tsx). */
const GUARD_HISTORY = 2000;

const STAGE_VALUES = WEEKLY_STAGES.map((o) => o.value);

type Param = Exclude<keyof Input, "sheet" | "name">;

/** Each sheet: the screen it comes from (its tab), whether it is the admin's,
 *  what it is, and the inputs it takes — any other is refused, never ignored. */
const SHEETS = {
  plan_tracker: { tab: "tracker", params: ["line", "filters"], about: "the monthly Plan Tracker (TR or LV), one row per order — filters as on the screen; deptStage narrows the TR columns" },
  weekly_plan: { tab: "tracker", params: ["plan", "q", "hideDone", "stages"], about: "a weekly delivery plan (transformers): a row per delivery day, project and component — plan number, search, hideDone, stages" },
  daily_log: { tab: "handover", params: ["line", "from", "to", "q", "dept", "item", "flaggedOnly"], about: "the Daily log (the ledger the tracker adds up): a row per entry with the data guard's checks — from/to (default the last 3 days), search on BOM, dept, item, flaggedOnly" },
  orders_registry: { tab: "orders", admin: true, params: ["line", "q", "urgent", "source"], about: "the Orders Registry (admins): a row per order of a line — search, urgent, source" },
  trace: { tab: "tracker", params: ["line", "mo", "bom"], about: "one order's (mo) or one code's (bom) trace: every ledger row behind it" },
  odoo_log: { tab: "odoo", params: ["from", "to"], about: "the ODOO close-out log, with the office sheet's headers — from/to, or every day" },
  odoo_daily: { tab: "odoo", params: ["from", "to", "basis"], about: "the ODOO dashboard by day: closed (or logged) quantity per product series — from/to (default the last 30 days), basis" },
  material: { tab: "material", params: ["line"], about: "the Material (nesting) sheet of a line, with the workbook's own columns" },
  physical_stock: { tab: "physical", params: [], about: "Physical Material: the store's count against Odoo's stock, code by code" },
  consumables_log: { tab: "consumables", params: ["from", "to"], about: "the consumables hand-out log — from/to (default today)" },
  consumables_limits: { tab: "consumables", params: [], about: "the consumables catalogue, its limits and where each stands now" },
  consumables_edits: { tab: "consumables", admin: true, params: ["from", "to"], about: "every change made to a recorded hand-out (admins) — from/to" },
  consumables_summary: { tab: "consumables", params: ["from", "to"], about: "what went out over a period, item by item — from/to" },
  consumables_dashboard: { tab: "consumables", params: ["view"], about: "the Consumables dashboard's detail table: a row per item and department against its limit at the period's end — view, the dashboard's address query as on the screen (from, to, dept, item, link, status)" },
  consumables_monthly: { tab: "consumables", params: ["month"], about: "the consumables monthly review: a row per item and per limit, with the trend — month" },
  powder_scrap: { tab: "consumables", params: ["month"], about: "a month of powder scrap: the sections' totals, then each weighing — month" },
  shift_attendance: { tab: "shifts", params: ["day", "section"], about: "a day's attendance as saved: a row per worker — day, section" },
  machine_stops: { tab: "shifts", params: ["day", "section"], about: "a day's machine stops (an open one counted up to now) — day, section" },
  output_by_type: { tab: "shifts", params: ["from", "to"], about: "the Production dashboard's What did we make, item by item?: each line's pieces per stage in the period by item and type (transformers by component and KVA class, panels by plan and panel type) against the month's plan — from/to (default the last 7 days)" },
  query: { tab: null, params: ["sql"], about: "anything else: the rows of ONE read-only SELECT (sql), as query_database reads them" },
} as const satisfies Record<string, { tab: string | null; admin?: true; params: readonly Param[]; about: string }>;
type SheetKind = keyof typeof SHEETS;

interface Input {
  sheet: SheetKind;
  name?: string;
  line?: ProductLine;
  filters?: TrackerFilters;
  plan?: number;
  q?: string;
  hideDone?: boolean;
  stages?: string;
  from?: string;
  to?: string;
  dept?: string;
  item?: string;
  flaggedOnly?: boolean;
  urgent?: "yes" | "no";
  source?: string;
  mo?: string;
  bom?: string;
  month?: string;
  day?: string;
  section?: string;
  basis?: "closed" | "logged";
  view?: string;
  sql?: string;
}

/** A sheet made: its rows and the file's name, or why there is none. */
type Made = { rows: SheetRow[]; name: string; sheet: string; scope: string } | { error: string };

const str = (maxLength: number, description: string) => ({ type: "string" as const, minLength: 1, maxLength, description });
const DAY = { type: "string" as const, format: "date" as const };

export const makeSheetTool: ReadTool<Input> = {
  kind: "read",
  name: "make_excel",
  title: "Making the Excel file",
  liveOnly: true,
  description:
    "Make an Excel file (.xlsx) for the person to download or print — the screens have no Export button any more, so this is how anyone gets a sheet of the app's data. Call it whenever they ask for an Excel, a sheet, an export, a download, a file, or a printout of a list. Each `sheet` builds EXACTLY the sheet the screen's old Export button made — its loader, its filters, its columns and headers, so the file drops back into the office's workbooks — and takes only its own inputs: " +
    Object.entries(SHEETS).map(([k, v]) => `${k}: ${v.about}`).join("; ") +
    `. Use \`query\` only when no screen sheet fits (any columns, joins, totals): one SELECT, double-quoted names, the same read-only rules as query_database, up to ${MAX_ROWS_TEXT} rows. The result gives the file's download and print links: ALWAYS put both in your answer as Markdown links, e.g. [Download plan-tracker.xlsx](${aiFileHref(12)}) · [Print](${aiPrintHref(12)}), and say in one line what it holds (rows, scope). Never paste the rows into the answer — the file carries them.`,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sheet"],
    properties: {
      sheet: { type: "string", enum: Object.keys(SHEETS) },
      name: str(100, "The file's name, without .xlsx — short and saying what it holds (\"late-orders-october\"). Defaults to the screen's own."),
      line: { type: "string", enum: ["TR", "LV"], description: "The product line, for plan_tracker, daily_log, orders_registry, trace (a code's) and material. Defaults to the chat's line." },
      filters: TRACKER_FILTER_SCHEMA,
      plan: { type: "integer", minimum: 1, description: "weekly_plan: the plan number; defaults to the newest." },
      q: str(160, "A search: weekly_plan (project, SOI, description), daily_log (BOM), orders_registry (MO, BOM, SOI, FG code, KVA, product). The plan tracker's search is filters.q."),
      hideDone: { type: "boolean", description: "weekly_plan: leave out the rows the measured stage has finished." },
      stages: str(60, `weekly_plan: the stage columns, comma-separated from ${STAGE_VALUES.join(",")}; all of them by default.`),
      from: { ...DAY, description: "The first day (YYYY-MM-DD) of daily_log, odoo_log, odoo_daily, consumables_log, consumables_edits, consumables_summary; a period given by its first day alone runs to today." },
      to: { ...DAY, description: "The last day (YYYY-MM-DD), the same sheets." },
      dept: str(40, "daily_log: one department, as the ledger names it (Cut, Welding, Painting, ShotBlast, Delivered, or an LV stage)."),
      item: str(40, "daily_log: one component (TN, TC, CF, CB, …)."),
      flaggedOnly: { type: "boolean", description: "daily_log: only the entries the data guard flagged." },
      urgent: { type: "string", enum: ["yes", "no"], description: "orders_registry: urgent orders only, or none of them." },
      source: str(80, "orders_registry: the import the order came from, exactly as listed."),
      mo: str(80, "trace: the order's MO."),
      bom: str(80, "trace: the code (BOM), when no MO is given."),
      month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "powder_scrap, consumables_monthly: the month (YYYY-MM); defaults to this one." },
      day: { ...DAY, description: "shift_attendance, machine_stops: the day; defaults to today." },
      section: str(40, "shift_attendance, machine_stops: line:TR, line:LV or a roster section, as the Shifts screen's filter."),
      basis: { type: "string", enum: ["closed", "logged"], description: "odoo_daily: count by the day closed (default) or the day logged." },
      view: { type: "string", maxLength: 600, description: "consumables_dashboard: the dashboard's address query, exactly as on the screen — e.g. \"from=2026-10-01&to=2026-10-26&dept=WeldingTX&status=over\" (dept, item c<id> or t:<typed name>, link linked|unlinked, status over|near|within|none); empty for today with no filter." },
      sql: str(20000, "query: one SELECT statement — no semicolons, no writes."),
    },
  },
  parse(raw) {
    const i = raw as unknown as Input;
    const takes: readonly string[] = SHEETS[i.sheet].params;
    const foreign = Object.keys(i).filter((k) => k !== "sheet" && k !== "name" && !takes.includes(k));
    if (foreign.length > 0) return `${i.sheet} does not take ${foreign.join(", ")} — it takes ${takes.length ? takes.join(", ") : "nothing but its name"}.`;
    if (i.sheet === "query" && !i.sql) return "A query sheet needs its SELECT (sql).";
    if (i.sheet === "trace" && !i.mo && !i.bom) return "A trace needs the order's MO or the code (bom).";
    if (i.from && i.to && i.from > i.to) return "from must not be after to.";
    if (i.to && !i.from && (i.sheet === "odoo_log" || i.sheet === "odoo_daily")) return "Give the first day (from) too — a period with no start is every day.";
    if (i.stages?.split(",").some((s) => !(STAGE_VALUES as readonly string[]).includes(s.trim()))) return `Stages are ${STAGE_VALUES.join(", ")}.`;
    return i;
  },
  status: (i) => `Making the Excel file — ${i.sheet.replace(/_/g, " ")}`,
  async run(i, ctx) {
    const spec: { tab: string | null; admin?: true } = SHEETS[i.sheet];
    if (spec.tab && ctx.hidden.has(spec.tab)) return { ok: false, text: "That screen is not opened for this person, so its sheet cannot be made for them." };
    if (spec.admin && !ctx.user.isAdmin) return { ok: false, text: "That sheet is the admin's alone." };
    // the room first: a sheet is not read to be refused
    const full = await roomProblem(ctx.user.id, 0, ctx.now);
    if (full) return { ok: false, text: full };
    const made = await rowsOf(i, ctx);
    if ("error" in made) return { ok: false, text: made.error };
    return keep(i, made, ctx);
  },
};

async function keep(i: Input, made: Exclude<Made, { error: string }>, ctx: ToolCtx): Promise<ReadResult> {
  if (made.rows.length === 0) return { ok: true, text: JSON.stringify({ rows: 0, scope: made.scope, note: "Nothing matches, so no file was made — say so, and offer a wider scope." }) };
  if (made.rows.length > MAX_SHEET_ROWS) return { ok: false, text: `That is ${made.rows.length.toLocaleString("en-US")} rows — at most ${MAX_ROWS_TEXT} in one file. Narrow it (a shorter period, a filter) or make it in parts.` };
  const stored = await storeMadeWorkbook(ctx, i.name ?? made.name, [{ name: made.sheet, rows: made.rows }]);
  if (!stored.ok) return { ok: false, text: stored.error };
  const download = aiFileHref(stored.file.id);
  const print = aiPrintHref(stored.file.id);
  return {
    ok: true,
    text: JSON.stringify({
      file: stored.file.name, scope: made.scope, rows: made.rows.length, columns: Object.keys(made.rows[0]), preview: made.rows.slice(0, 3), download, print,
      note: `Put both links in your answer: [Download ${stored.file.name}](${download}) · [Print](${print}). The file is kept for the person for ${AI_FILE_LIMITS.keepDays} days.`,
    }),
    links: [{ label: `Download ${stored.file.name}`, href: download }, { label: "Print it", href: print }],
  };
}

function viewerOf(ctx: ToolCtx) {
  return { id: ctx.user.id, isAdmin: ctx.user.isAdmin, canRecord: hasPerm(ctx.user, "consumables.edit") };
}

/** The month asked for — this one by default, never one still to come. */
function monthOf(i: Input, ctx: ToolCtx): string | { error: string } {
  if (i.month === undefined) return ctx.todayISO.slice(0, 7);
  return pastMonthOf(i.month, ctx.todayISO) ?? { error: `${i.month} is not a month already begun.` };
}

/** The Shifts screen's day and section — today and every section by default. */
function shiftScope(i: Input, today: string): { day: string; filter: RosterFilter } | { error: string } {
  const day = i.day ?? today;
  if (day > today) return { error: "That day has not come yet." };
  const filter = parseRosterFilter(i.section);
  return i.section && !filter ? { error: `${i.section} is not a section of the Shifts screen.` } : { day, filter };
}

const stamp = (from: string, to: string) => (from === to ? from : `${from}_to_${to}`);

async function rowsOf(i: Input, ctx: ToolCtx): Promise<Made> {
  const line: ProductLine = i.line ?? ctx.line ?? "TR";
  const today = ctx.todayISO;
  if (i.from && i.from > today) return { error: "That period has not started." };
  switch (i.sheet) {
    case "plan_tracker": {
      const f = trackerFiltersFor(line, i.filters ?? {});
      if (typeof f === "string") return { error: f };
      if (line === "LV") {
        const rows = filterLvTracker(await withLine("LV", () => getLvTracker()), f);
        return { rows: lvTrackerRows(rows), name: "lv-plan-tracker", sheet: "Plan Tracker", scope: `LV Plan Tracker, ${rows.length} orders` };
      }
      const stages = trackerStagesOf(f.deptStage);
      const rows = filterMasterTracker(await withLine("TR", () => getMasterTracker()), f);
      return { rows: masterTrackerRows(rows, stages, f.month ?? ""), name: `plan-tracker${stages.length ? `-${stages.join("-").toLowerCase()}` : ""}`, sheet: "Plan Tracker", scope: `Transformer Plan Tracker, ${rows.length} orders` };
    }
    case "weekly_plan": {
      const data = await withLine("TR", () => getWeeklyPlanTracker(i.plan ?? null));
      if (data.planNo === null) return { error: "There is no weekly plan yet." };
      if (i.plan && data.planNo !== i.plan) return { error: `There is no weekly plan ${i.plan}. The plans: ${data.planNos.join(", ")}.` };
      const stages = weeklyStagesOf((i.stages ?? "").replace(/\s+/g, ""));
      const days = filterWeeklyDays(data.days, { q: i.q, hideDone: i.hideDone }, weeklyMetricOf(stages, !!i.stages));
      return { rows: weeklyPlanRows(days, stages), name: `weekly-plan-${data.planNo}`, sheet: `Plan ${data.planNo}`, scope: `Weekly plan ${data.planNo}` };
    }
    case "daily_log": {
      const to = i.to ?? today;
      const from = i.from ?? addDaysISO(to, -2);
      const [entries, recent, soi] = await Promise.all([
        prisma.handoverEntry.findMany({
          where: { ...ledgerItemWhere(line), date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take: MAX_SHEET_ROWS + 1,
        }),
        withLine(line, () => getRecentHandover(GUARD_HISTORY)),
        getSoiLookup(),
      ]);
      // the whole period or nothing: the filters below need every entry of it,
      // so a period past the limit is refused, not cut
      if (entries.length > MAX_SHEET_ROWS) return { error: `The Daily log holds more than ${MAX_ROWS_TEXT} entries from ${from} to ${to} — take a shorter period.` };
      // the data guard judges each entry against the history the screen loads,
      // and the rest of the period
      const seen = new Set(entries.map((e) => e.id));
      const guarded = logRowsOf([...entries, ...recent.filter((e) => !seen.has(e.id))]);
      const rows = filterLogRows(guarded, { q: i.q, dept: i.dept, item: i.item, flaggedOnly: i.flaggedOnly, from, to });
      return { rows: dailyLogRows(rows, soi), name: `daily-log-${line === "LV" ? "lv-" : ""}${stamp(from, to)}`, sheet: "Daily log", scope: `${line === "LV" ? "LV" : "Transformer"} Daily log ${from} – ${to}` };
    }
    case "orders_registry": {
      const orders = await prisma.masterOrder.findMany({ where: { line }, orderBy: [{ createdAt: "desc" }, { mo: "asc" }] });
      const rows = filterOrderRows(orders.map(orderRowOf), { q: i.q, urgent: i.urgent, source: i.source });
      return { rows: registryRows(rows, line), name: `orders-${line.toLowerCase()}`, sheet: "Orders", scope: `${line} Orders Registry, ${rows.length} orders` };
    }
    case "trace": {
      // an order traces on its own line, whatever the chat is on
      const own = i.mo ? (await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { line: true } }))?.line : null;
      const at: ProductLine = own === "LV" || own === "TR" ? own : line;
      const key = (i.mo ?? i.bom)!;
      const scope = { mo: i.mo, bom: i.mo ? undefined : i.bom };
      if (at === "LV") {
        const t = await withLine("LV", () => getLvTrace(scope));
        if (!t.exists) return { error: `No LV panel order or log row carries ${key}.` };
        return { rows: lvTraceRows(t), name: `trace-${key}`, sheet: "Trace", scope: `Trace of ${t.key}` };
      }
      const t = await withLine("TR", () => getTrace(scope));
      if (!t.exists) return { error: `No order or log row carries ${key}.` };
      return { rows: traceRows(t), name: `trace-${key}`, sheet: "Trace", scope: `Trace of ${t.key}` };
    }
    case "odoo_log": {
      // from a day on its own runs to today, as the other sheets read it
      const raw = i.from ? `${i.from}..${i.to ?? today}` : "all";
      const { entries } = await getOdooData(parseOdooScope(raw, today));
      return { rows: odooLogRows(entries), name: `odoo-${raw.replace("..", "_to_")}`, sheet: "Sheet1", scope: raw === "all" ? "ODOO log, every day" : `ODOO log ${raw.replace("..", " – ")}` };
    }
    case "odoo_daily": {
      const period = resolvePeriod(i.from ? { range: "custom", from: i.from, to: i.to ?? today } : {}, factoryToday(ctx.now));
      const basis = i.basis ?? "closed";
      // no comparison: the sheet carries the period's own days
      const d = await getOdooDashboard(period, basis, null, "none");
      return { rows: odooDailyRows(d), name: `odoo-by-day-${period.fromISO ?? "all"}-${period.toISO}`, sheet: "By day", scope: `ODOO by ${basis} day, ${period.fromISO ?? "the start"} – ${period.toISO}` };
    }
    case "material": {
      const { lines } = await withLine(line, () => getMaterialData(""));
      return { rows: materialRows(lines, line), name: `material-sheet${line === "LV" ? "-lv" : ""}`, sheet: "Material", scope: `${line} Material sheet` };
    }
    case "physical_stock": {
      const { items } = await getPhysicalStock();
      return { rows: physicalRows(items), name: `physical-material-${today}`, sheet: "Physical", scope: "Physical Material" };
    }
    case "consumables_log": {
      const p = consumablesPeriod({ from: i.from, to: i.to }, today);
      // the log's rows are the same for every viewer; only an admin's screen
      // also reads each hand-out's edit history, which the sheet never shows
      const data = await getConsumablesData(p.from, p.to, { ...viewerOf(ctx), isAdmin: false });
      return { rows: consumablesLogRows(data.entries), name: `consumables-${p.stamp}`, sheet: "Consumables", scope: `Consumables log ${p.label}` };
    }
    case "consumables_limits": {
      const [items, standings] = await Promise.all([getCatalogue(), getCurrentStandings(today)]);
      return { rows: consumableLimitRows(items, standings), name: `consumables-limits-${today}`, sheet: "Limits", scope: "Consumables catalogue and limits, as they stand now" };
    }
    case "consumables_edits": {
      const p = consumablesPeriod({ from: i.from, to: i.to }, today);
      return { rows: consumableEditRows(await getConsumableEdits(p.from, p.to)), name: `consumables-edits-${p.stamp}`, sheet: "Edits", scope: `Consumables edits ${p.label}` };
    }
    case "consumables_summary": {
      const p = consumablesPeriod({ from: i.from, to: i.to }, today);
      const stats = await getConsumablesDashboard(p.from, p.to);
      return { rows: consumablesSummaryRows(stats.items), name: `consumables-summary-${p.stamp}`, sheet: "Items", scope: `Consumables by item ${p.label}` };
    }
    case "consumables_dashboard": {
      // the screen's own address, read by the screen's own rules
      const sp = Object.fromEntries(new URLSearchParams(i.view ?? ""));
      const p = consumablesPeriod({ from: sp.from, to: sp.to }, today);
      const d = await getConsumablesDecisions(p.from, p.to, today, readDecisionFilters(sp));
      return { rows: consumablesDecisionRows(d.rows), name: `consumables-dashboard-${p.stamp}`, sheet: "By item and department", scope: `Consumables by item and department ${p.label}` };
    }
    case "consumables_monthly": {
      const month = monthOf(i, ctx);
      if (typeof month !== "string") return month;
      return { rows: consumablesMonthlyRows(await getMonthlyReport(month)), name: `consumables-monthly-${month}`, sheet: month, scope: `Consumables monthly review ${month}` };
    }
    case "powder_scrap": {
      const month = monthOf(i, ctx);
      if (typeof month !== "string") return month;
      return { rows: powderRows(await getPowderReport(month, viewerOf(ctx)), month), name: `powder-scrap-${month}`, sheet: month, scope: `Powder scrap ${month}` };
    }
    case "shift_attendance": {
      const at = shiftScope(i, today);
      if ("error" in at) return at;
      const data = await getShiftRoster(at.day);
      return { rows: rosterRows({ ...data, lines: data.lines.filter((l) => rosterLineMatches(l, at.filter)) }), name: `attendance-${at.day}`, sheet: "Attendance", scope: `Attendance ${at.day}` };
    }
    case "machine_stops": {
      const at = shiftScope(i, today);
      if ("error" in at) return at;
      const depts: readonly string[] = rosterDepts(at.filter);
      const data = await getDowntimeDay(at.day);
      return { rows: downtimeRows({ ...data, rows: data.rows.filter((r) => depts.includes(r.dept)) }, ctx.now), name: `machine-stops-${at.day}`, sheet: "Stops", scope: `Machine stops ${at.day}` };
    }
    case "output_by_type": {
      // the dashboard's own period rule and loaders: every department, both lines
      const req = floorRequest({ from: i.from, to: i.to }, today);
      const { tr, lv } = await loadProductionAll(req, "all", ctx.now);
      return { rows: outputByTypeRows(tr.byType, lv.byType), name: `output-by-type-${tr.fromISO}_${tr.toISO}`, sheet: "By item", scope: `Output by item and type, ${tr.fromISO} – ${tr.toISO}` };
    }
    case "query": {
      const closed = blockedTableIn(i.sql!, blockedTablesFor(ctx.hidden));
      if (closed) return { error: `"${closed}" belongs to a screen that is not opened for this person, so it cannot be read for them.` };
      const r = await runAiRows(i.sql!, MAX_SHEET_ROWS);
      if (!r.ok) return { error: r.error };
      if (r.truncated) return { error: `The query returns more than ${MAX_ROWS_TEXT} rows — narrow it.` };
      return { rows: r.rows.map(cellsOf), name: "query", sheet: "Sheet1", scope: `${r.rows.length} rows of a query` };
    }
  }
}

/** A row as the reader hands it (already JSON-safe) as sheet cells: a number
 *  stays a number, a yes/no reads so, anything else is text. */
function cellsOf(row: Record<string, unknown>): SheetRow {
  const cell = (v: unknown): string | number => {
    if (typeof v === "number" || typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "yes" : "no";
    return v === null ? "" : JSON.stringify(v);
  };
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]));
}
