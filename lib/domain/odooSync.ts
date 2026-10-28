// Odoo, read on a schedule — the pure half: when the runs are due, how an
// Odoo product code names one of the plant's components, whether a close-out
// row agrees with what Odoo says about its MO, and which open sub-assembly MO
// a row born from a closing should carry. No I/O.
//
// How the data arrives: a scheduled task on the owner's computer gets a
// one-time pass from the database (odoo_issue_ticket()), opens Odoo in the
// Claude desktop app's browser with the user's own login, loads the read-only
// pull (lib/domain/odooPull.ts, /odoo-pull.js — fetched from the repository,
// since the plant's network does not open the app's own domain) and starts it
// with the pass; the page reads the plan and writes what it read itself,
// through the "odoo-sync" Edge Function (supabase/functions) into
// odoo_pull_plan_t / odoo_ingest_t (migrations 20261027180000 and
// 20261028080000). Nothing is ever written to Odoo.

import { isCancelledStatus, isDoneStatus } from "./odoo";

export { ODOO_DIFFERS, odooDiffers } from "./odoo";

// ---- when ----

/** The sync's clock is the plant's in Saudi Arabia (UTC+3 all year, no
 *  daylight saving) — the hours the planner asked for. */
export const ODOO_SYNC_TZ = "Asia/Riyadh";
const RIYADH_OFFSET_H = 3;
/** The hours the scheduled task runs (local). */
export const ODOO_SYNC_HOURS = [9, 13] as const;
/** The working days it runs on: Sunday (0) to Thursday (4). */
export const ODOO_SYNC_WEEKDAYS = [0, 1, 2, 3, 4] as const;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ODOO_SYNC_TZ, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A moment on the sync's clock: its day, weekday (0 = Sunday), hour and minute. */
export function syncClock(at: Date): { dateISO: string; weekday: number; hour: number; minute: number } {
  const p = Object.fromEntries(PARTS.formatToParts(at).map((x) => [x.type, x.value]));
  return { dateISO: `${p.year}-${p.month}-${p.day}`, weekday: WEEKDAY[p.weekday] ?? -1, hour: Number(p.hour), minute: Number(p.minute) };
}

const workingDay = (weekday: number) => (ODOO_SYNC_WEEKDAYS as readonly number[]).includes(weekday);
const slotMoment = (dateISO: string, hour: number) => {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - RIYADH_OFFSET_H));
};

/** The last scheduled run's moment at or before this one, or null (none in
 *  the last week). */
export function lastOdooSlotAt(at: Date): Date | null {
  for (let d = 0; d < 8; d++) {
    const c = syncClock(new Date(at.getTime() - d * 86_400_000));
    if (!workingDay(c.weekday)) continue;
    for (const h of [...ODOO_SYNC_HOURS].reverse()) {
      const t = slotMoment(c.dateISO, h);
      if (t.getTime() <= at.getTime()) return t;
    }
  }
  return null;
}

/** The next scheduled run after this moment, as a Riyadh "YYYY-MM-DD HH:00". */
export function nextOdooSlotLabel(at: Date): string {
  for (let d = 0; d < 8; d++) {
    const c = syncClock(new Date(at.getTime() + d * 86_400_000));
    if (!workingDay(c.weekday)) continue;
    const h = ODOO_SYNC_HOURS.find((x) => d > 0 || slotMoment(c.dateISO, x).getTime() > at.getTime());
    if (h !== undefined) return `${c.dateISO} ${String(h).padStart(2, "0")}:00`;
  }
  return "";
}

/** The last scheduled run should have landed by now and did not — the
 *  computer was off, Odoo or the app asked for a login, or the run failed.
 *  A run is given `graceMin` to finish. */
export function isOdooSyncLate(lastOkAt: Date | null, at: Date, graceMin = 90): boolean {
  const slot = lastOdooSlotAt(at);
  if (!slot || at.getTime() - slot.getTime() < graceMin * 60_000) return false;
  return !lastOkAt || lastOkAt.getTime() < slot.getTime() - 30 * 60_000;
}

// ---- the plant's components in Odoo's product codes ----

/** The part code an FG code starts with → the component the app calls it.
 *  Fins (FN) are kept under their tank; the app records them with it. */
export const ODOO_PART_ITEM: Readonly<Record<string, string>> = {
  "FB-022": "TN", // tank
  "FB-051": "TC", // top cover
  "FB-058": "CF", // core frame
  "FB-024": "CB", // cable box
  "FB-027": "AR", // arrester bracket
  "FB-052": "MB", // monobloc box
  "FB-036": "FN", // fins — only directly under a tank
};

/** "[FB-022-14003E11M11] TN_XMR…" → "FB-022-14003E11M11"; "" when there is no code. */
export function productCodeOf(displayName: string | null | undefined): string {
  const m = /^\[([^\]]+)\]/.exec((displayName ?? "").trim());
  return m ? m[1].trim().toUpperCase() : "";
}

/** The component a product code is, or null when it is none of the tracked ones. */
export function itemOfCode(code: string): string | null {
  return ODOO_PART_ITEM[code.trim().toUpperCase().slice(0, 6)] ?? null;
}

/** A batch's own suffix: "SF01/MO/15295-002" has one, "SF01/MO/15295" not. */
export const hasBatchSuffix = (name: string) => /-\d{3}$/.test(name.trim());
/** The family a batch belongs to: "SF01/MO/15295-002" → "SF01/MO/15295". */
export const batchBase = (name: string) => name.trim().replace(/-\d{3}$/, "");
/** What Odoo renames an MO to when it first splits it. */
export const firstBatchName = (name: string) => `${batchBase(name)}-001`;

/** An MO name as the log and Odoo both write it — trimmed, upper case. */
export const normMo = (name: string | null | undefined) => (name ?? "").trim().toUpperCase();

// ---- Odoo's states ----

export const ODOO_STATE_LABEL: Readonly<Record<string, string>> = {
  draft: "Draft", confirmed: "Confirmed", progress: "In progress", to_close: "To close", done: "Done", cancel: "Cancelled",
};
export const odooStateLabel = (s: string) => ODOO_STATE_LABEL[s] ?? (s || "—");
/** Still to be worked or closed in Odoo. */
export const isOdooOpen = (s: string) => s !== "done" && s !== "cancel" && s !== "";

// ---- a close-out row against Odoo ----

export interface MoStateView {
  name: string;
  found: boolean;
  /** The MO's product code in Odoo ("FB-022-…"). */
  productCode: string;
  /** The name Odoo uses now, when it renamed the MO; else the same. */
  currentName: string;
  state: string;
  qty: number;
  qtyProduced: number;
  /** Odoo's own closing moment, when done. */
  doneAtISO: string | null;
  checkedAtISO: string;
}

/**
 * How a close-out row reads against Odoo:
 * - agree: both closed, or both still open;
 * - openInOdoo: Done here, still open in Odoo — the one the planner asked to be told about;
 * - closedInOdoo: open here, Odoo has closed it — tick it Done;
 * - cancelledInOdoo: Odoo cancelled the MO;
 * - otherPart: the MO makes another component than the row's (a top cover
 *   booked against a tank MO) — read off the two codes' part prefixes;
 * - notFound: no MO by that name (or its first batch's) in Odoo;
 * - unchecked: the sync has not read it yet;
 * - none: nothing to compare — no MO, or the row is cancelled here.
 * Never moves the row: the planner decides.
 */
export type OdooAgreement = "agree" | "openInOdoo" | "closedInOdoo" | "cancelledInOdoo" | "otherPart" | "notFound" | "unchecked" | "none";

/** "FB-022" out of "FB-022-14003E11M11"; "" when the code has no part prefix. */
export const partOfCode = (code: string | null | undefined) => /^([A-Z]{2}-\d{3})-/.exec((code ?? "").trim().toUpperCase())?.[1] ?? "";

export function odooAgreement(
  row: { odooMo: string; status: string; fgCode?: string },
  st: Pick<MoStateView, "found" | "state"> & { productCode?: string } | null | undefined,
): OdooAgreement {
  if (!normMo(row.odooMo) || isCancelledStatus(row.status)) return "none";
  if (!st) return "unchecked";
  if (!st.found) return "notFound";
  if (st.state === "cancel") return "cancelledInOdoo";
  const mine = partOfCode(row.fgCode), theirs = partOfCode(st.productCode);
  if (mine && theirs && mine !== theirs) return "otherPart";
  const doneHere = isDoneStatus(row.status);
  const doneThere = st.state === "done";
  if (doneHere && !doneThere) return "openInOdoo";
  if (!doneHere && doneThere) return "closedInOdoo";
  return "agree";
}


export const ODOO_AGREEMENT_TEXT: Readonly<Record<OdooAgreement, { label: string; tone: "ok" | "warn" | "bad" | "muted"; hint: string }>> = {
  agree: { label: "Odoo agrees", tone: "ok", hint: "Odoo says the same as this row." },
  openInOdoo: { label: "Still open in Odoo", tone: "bad", hint: "Marked Done here, but the MO is not closed in Odoo." },
  closedInOdoo: { label: "Closed in Odoo", tone: "ok", hint: "Odoo has closed this MO — it can be ticked Done here." },
  cancelledInOdoo: { label: "Cancelled in Odoo", tone: "bad", hint: "Odoo cancelled this MO." },
  otherPart: { label: "MO of another part", tone: "bad", hint: "This MO makes a different component in Odoo than the row's FG-CODE — check the MO number." },
  notFound: { label: "Not in Odoo", tone: "warn", hint: "Odoo has no MO by this number — check it." },
  unchecked: { label: "Not checked yet", tone: "muted", hint: "The next Odoo sync reads it." },
  none: { label: "", tone: "muted", hint: "" },
};

/** The moment a Done row's closing counts on: Odoo's own when Odoo closed
 *  it, else the moment it was ticked Done here. Null while not Done here. */
export function effectiveDoneAt(row: { status: string; doneAt: Date | null }, odooDoneAt: Date | null | undefined): Date | null {
  if (!isDoneStatus(row.status)) return null;
  return odooDoneAt ?? row.doneAt;
}

// ---- which open sub-assembly MO a row born from a closing carries ----

export interface ChildMoView {
  parentMo: string;
  name: string;
  item: string;
  productCode: string;
  qty: number;
  qtyProduced: number;
  uom: string;
  state: string;
  doneAtISO: string | null;
  linkHow: string;
  sharedWith: string[];
}

/**
 * The open MOs under the row's order and component that the row's pieces can
 * be booked against — the likeliest first: the row's own order before its
 * family's other batches (the floor books a tank against any open tank MO of
 * the same order), the row's own FG code before any other, then the MO whose
 * pieces still to make match the row's exactly, then the smallest that still
 * holds them all, then the rest by name. A suggestion only: the person picks.
 */
export function suggestChildMos(
  row: { qty: number; fgCode: string; item: string | null; parentMo?: string | null },
  children: readonly ChildMoView[],
  limit = 3,
): ChildMoView[] {
  const fg = row.fgCode.trim().toUpperCase();
  const own = normMo(row.parentMo);
  const left = (c: ChildMoView) => Math.max(0, c.qty - c.qtyProduced);
  // one entry per MO — a child shared by two batches of the order is one MO
  const byName = new Map<string, ChildMoView>();
  for (const c of children) {
    if (!isOdooOpen(c.state) || !(c.item === "" || !row.item || c.item === row.item)) continue;
    const prev = byName.get(c.name);
    if (!prev || (own && normMo(c.parentMo) === own && normMo(prev.parentMo) !== own)) byName.set(c.name, c);
  }
  const rank = (c: ChildMoView) => [
    own && normMo(c.parentMo) !== own ? 1 : 0,
    fg && c.productCode === fg ? 0 : 1,
    left(c) === row.qty ? 0 : left(c) >= row.qty ? 1 : 2,
    left(c) >= row.qty ? left(c) : -left(c),
  ];
  return [...byName.values()]
    .sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** What the last sync read about one close-out row. */
export interface RowOdooFacts {
  /** How the row reads against Odoo. */
  agreement: OdooAgreement;
  /** Odoo's word on the MO, when the sync has read it. */
  state: MoStateView | null;
  /** For a row with no MO: the likeliest open MOs, best first. */
  suggest: ChildMoView[];
}

export const NO_ODOO_FACTS: RowOdooFacts = { agreement: "none", state: null, suggest: [] };

// ---- a run's summary (written by odoo_ingest) ----

export interface OdooSyncSummary {
  /** Close-out log: MOs read, closed, still open, renamed, not found. */
  log: { checked: number; done: number; open: number; renamed: number; notFound: number };
  /** Sub-assembly MOs: orders rewritten this run, their MOs, orders unchanged since the last. */
  children: { orders: number; mos: number; unchanged: number };
  /** The store's SF01 on-hand: codes updated, unchanged, not found in Odoo;
   *  `skipped` when the read looked broken (most stocks gone to zero). */
  stock: { updated: number; unchanged: number; missing: number; skipped?: boolean };
  /** Odoo's BoMs: BoMs written (new or changed), their lines, the open codes
   *  tied to a BoM and those Odoo has none for. Absent on a run before BoMs. */
  boms?: { written: number; lines: number; roots: number; missing: number };
  /** What went wrong in a part that did not stop the rest. */
  issues: string[];
  ms: number;
}

/** One line for the settings card and the assistant. */
export function summaryText(s: OdooSyncSummary | null | undefined): string {
  if (!s) return "";
  const parts = [
    `${s.log.checked} MOs checked`,
    `${s.children.orders} order${s.children.orders === 1 ? "" : "s"} with new sub-assembly MOs (${s.children.unchanged} unchanged)`,
    s.stock.skipped ? "SF01 stock skipped" : `SF01 stock: ${s.stock.updated} updated`,
    ...(s.boms ? [`BoMs: ${s.boms.written} written for ${s.boms.roots} codes${s.boms.missing ? ` (${s.boms.missing} not in Odoo)` : ""}`] : []),
  ];
  return parts.join(" · ") + (s.issues.length ? ` · ${s.issues.length} issue${s.issues.length === 1 ? "" : "s"}` : "");
}

/** The API's own words, cut to what fits on a card. */
export function odooErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}
