// The app's ONE way of writing dates and numbers on screen. Exports keep ISO
// (2026-10-04) — a spreadsheet sorts and filters those — and everything a
// person reads goes through here, so a date or a quantity looks the same on
// every page.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The factory's clock — the same zone factoryDayISO reads days in. */
const FACTORY_TZ = "Africa/Cairo";
const FACTORY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: FACTORY_TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short",
});

interface Parts { y: number; m: number; d: number; wd: number; hh: string; mm: string }

function factoryParts(at: Date): Parts {
  const p = Object.fromEntries(FACTORY_PARTS.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day), wd: DAYS.indexOf(p.weekday), hh: p.hour, mm: p.minute };
}

/** A calendar day ("2026-10-04", or a Date at that day's UTC midnight — how
 *  the ledger stores days) as its parts, read without any zone shift. */
function dayParts(day: string | Date): Parts | null {
  const d = typeof day === "string" ? new Date(`${day.slice(0, 10)}T00:00:00Z`) : day;
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), hh: "00", mm: "00" };
}

const thisYear = (now: Date) => factoryParts(now).y;

/** A day: "Sun 4 Oct" in the current year, "Sat 4 Oct 2025" otherwise.
 *  An empty or malformed value reads "—". */
export function formatDate(day: string | Date | null | undefined, now: Date = new Date()): string {
  if (!day) return "—";
  const p = dayParts(day);
  if (!p) return typeof day === "string" ? day : "—";
  const base = `${DAYS[p.wd]} ${p.d} ${MONTHS[p.m]}`;
  return p.y === thisYear(now) ? base : `${base} ${p.y}`;
}

/** A moment on the factory clock: "4 Oct 08:58" in the current year,
 *  "4 Oct 2025 08:58" otherwise. */
export function formatDateTime(at: string | Date | null | undefined, now: Date = new Date()): string {
  if (!at) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return typeof at === "string" ? at : "—";
  const p = factoryParts(d);
  const day = p.y === thisYear(now) ? `${p.d} ${MONTHS[p.m]}` : `${p.d} ${MONTHS[p.m]} ${p.y}`;
  return `${day} ${p.hh}:${p.mm}`;
}

/** A day with no weekday, for tight chart axes: "4 Oct" (year added when it
 *  is not the current one). */
export function formatDayShort(day: string | Date | null | undefined, now: Date = new Date()): string {
  if (!day) return "—";
  const p = dayParts(day);
  if (!p) return typeof day === "string" ? day : "—";
  return p.y === thisYear(now) ? `${p.d} ${MONTHS[p.m]}` : `${p.d} ${MONTHS[p.m]} ${p.y}`;
}

// ---- numbers ----

/** How many decimals each kind of figure is written with — fixed per field,
 *  so a column's figures line up on the decimal point. */
export const FIELD_DP = {
  count: 0, // pieces, units, rows
  weight: 2, // kg
  factor: 4, // per-unit factors (sheets per unit, actual per unit) — the nesting sheet writes 0.2207
  sheets: 3, // sheets for a job — fractions of a sheet: 1.287
  percent: 0,
  qty: 3, // consumables quantities (kg, L, m may be fractional)
} as const;
export type FieldKind = keyof typeof FIELD_DP;

/** A number at a fixed number of decimals with thousands separators:
 *  formatNumber(1234.5, 2) → "1,234.50". Null / NaN read "—". */
export function formatNumber(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** A figure of a known kind (see FIELD_DP). */
export function formatField(v: number | null | undefined, kind: FieldKind): string {
  return formatNumber(v, FIELD_DP[kind]);
}

/** A quantity of a consumable: as many decimals as it needs, up to three —
 *  12 stays "12", 0.5 L stays "0.5". */
export function formatQty(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: FIELD_DP.qty });
}

/** A duration as a person reads it: "0.8s", "12s", "2m 05s". */
export function durationText(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 9.95) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  return `${m}m ${String(whole - m * 60).padStart(2, "0")}s`;
}
