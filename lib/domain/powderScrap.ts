// POWDER SCRAP — the powder-coating powder the painting lines throw away,
// weighed in kg, set against the powder the store handed out to them. Pure
// and tested; the reads are lib/server/powderScrap.ts.
//
//   withdrawn ... the consumables hand-outs, to a painting section, of items
//                 named "…powder…" (any case) — catalogue items or typed ones
//   scrap ....... the kg recorded here for that section
//   scrap rate .. scrap ÷ withdrawn, over a calendar month
//   net used .... withdrawn − scrap
//
// Only hand-outs counted in kg can be set against kg of scrap: a powder item
// whose catalogue unit is something else (a box, a bag) is listed apart and
// left out of the rate rather than added in as if it were kilos. A typed
// item has no unit and is taken as kg.

import { cleanText } from "./consumables";
import { sectionLabel } from "./tanks";
import { monthBounds, shiftMonth } from "./consumableMonthly";

/** The sections that paint with powder — the scrap is theirs. */
export const POWDER_DEPARTMENTS = ["PaintingTX", "PaintingLV"] as const;
export type PowderDepartment = (typeof POWDER_DEPARTMENTS)[number];

export const SCRAP_LIMITS = {
  /** More than 50 t of scrap in one weighing is a typo. */
  kgMax: 50_000,
  kgDecimals: 3,
  notes: 300,
  /** How far back a weighing may be dated. */
  daysBack: 366,
} as const;

export function isPowderDepartment(x: string): x is PowderDepartment {
  return (POWDER_DEPARTMENTS as readonly string[]).includes(x);
}

/** A powder item, by its name: "Powder RAL 7035", "Epoxy powder grey" … */
export function isPowderItem(name: string): boolean {
  return /powder/i.test(name);
}

const KG_UNITS = new Set(["KG", "KGS", "KILO", "KILOS", "KILOGRAM", "KILOGRAMS"]);
/** Whether a hand-out's quantity is kilos: a catalogue unit that says so, or
 *  a typed item (no unit). */
export function isKgUnit(uom: string | null): boolean {
  if (uom === null) return true;
  return KG_UNITS.has(uom.replace(/[\s.]/g, "").toUpperCase());
}

// ---------------------------------------------------------------- the form

export interface ScrapFields {
  dayISO: string;
  department: PowderDepartment;
  kg: number;
  notes: string | null;
}

/** Read and check the scrap form. The day is the weighing's — today or
 *  earlier, at most a year back. */
export function readScrapForm(get: (name: string) => unknown, todayISO: string, earliestISO: string): { fields?: ScrapFields; error?: string } {
  const day = cleanText(get("day"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    return { error: "Pick the day the scrap was weighed." };
  }
  if (day > todayISO) return { error: "The day cannot be in the future." };
  if (day < earliestISO) return { error: "That day is more than a year back." };

  const department = cleanText(get("department"));
  if (!isPowderDepartment(department)) return { error: "Pick the painting section." };

  const raw = cleanText(get("kg"));
  if (raw === "") return { error: "Enter the scrap in kg." };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(raw)) return { error: "The kg must be a number." };
  if ((raw.split(".")[1] ?? "").length > SCRAP_LIMITS.kgDecimals) return { error: `The kg take at most ${SCRAP_LIMITS.kgDecimals} decimals.` };
  const kg = Number(raw);
  if (!Number.isFinite(kg) || kg <= 0) return { error: "The kg must be more than zero." };
  if (kg > SCRAP_LIMITS.kgMax) return { error: `The kg cannot exceed ${SCRAP_LIMITS.kgMax.toLocaleString("en-US")}.` };

  const notes = cleanText(get("notes"));
  if (notes.length > SCRAP_LIMITS.notes) return { error: `The notes are too long (at most ${SCRAP_LIMITS.notes} characters).` };

  return { fields: { dayISO: day, department, kg, notes: notes || null } };
}

/** A weighing as a revision keeps it. */
export interface ScrapSnapshot {
  dayISO: string;
  department: string;
  kg: number;
  notes: string | null;
}

export function sameScrap(a: ScrapSnapshot, b: ScrapSnapshot): boolean {
  return a.dayISO === b.dayISO && a.department === b.department && a.kg === b.kg && (a.notes ?? null) === (b.notes ?? null);
}

export function parseScrapSnapshot(raw: unknown): ScrapSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const kg = Number(s.kg);
  if (typeof s.dayISO !== "string" || typeof s.department !== "string" || !Number.isFinite(kg)) return null;
  return { dayISO: s.dayISO, department: s.department, kg, notes: typeof s.notes === "string" && s.notes ? s.notes : null };
}

/** "12.5 kg · Transformer Painting · 28/09/2026 · “filter change”". */
export function describeScrap(s: ScrapSnapshot | null): string {
  if (!s) return "—";
  const [y, m, d] = s.dayISO.split("-");
  return [`${s.kg} kg`, sectionLabel(s.department), `${d}/${m}/${y}`, s.notes ? `“${s.notes}”` : null].filter(Boolean).join(" · ");
}

export function scrapChanges(before: ScrapSnapshot | null, after: ScrapSnapshot | null): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  if (before.dayISO !== after.dayISO) out.push(`Day: ${before.dayISO} → ${after.dayISO}`);
  if (before.department !== after.department) out.push(`Section: ${sectionLabel(before.department)} → ${sectionLabel(after.department)}`);
  if (before.kg !== after.kg) out.push(`Kg: ${before.kg} → ${after.kg}`);
  if ((before.notes ?? "") !== (after.notes ?? "")) out.push(`Notes: ${before.notes ? `“${before.notes}”` : "—"} → ${after.notes ? `“${after.notes}”` : "—"}`);
  return out;
}

// ---------------------------------------------------------------- the month

/** A powder hand-out as the report reads it. */
export interface PowderWithdrawal {
  dayISO: string;
  department: string;
  item: string;
  /** The catalogue unit; null for a typed item. */
  uom: string | null;
  qty: number;
}

export interface ScrapEntry {
  dayISO: string;
  department: string;
  kg: number;
}

export interface PowderFigures {
  withdrawn: number;
  scrap: number;
  /** withdrawn − scrap; negative when more was scrapped than handed out
   *  (powder from an earlier month's stock). */
  net: number;
  /** scrap ÷ withdrawn; null when nothing was handed out, or no scrap was
   *  weighed — no weighing is not a 0% scrap rate. */
  rate: number | null;
}

export interface PowderDeptRow extends PowderFigures {
  department: PowderDepartment;
  label: string;
  prev: PowderFigures;
  /** One point per trend month. */
  trend: ({ month: string } & PowderFigures)[];
}

export interface PowderReport {
  month: string;
  prevMonth: string;
  trendMonths: string[];
  departments: PowderDeptRow[];
  /** Both sections together. */
  total: PowderFigures & { prev: PowderFigures; trend: ({ month: string } & PowderFigures)[] };
  /** The month's powder hand-outs by item, per section — what was drawn. */
  items: { item: string; uom: string; department: PowderDepartment; qty: number; handOuts: number }[];
  /** Powder hand-outs this month that are not in kg — left out of the rate. */
  notKg: { item: string; uom: string; qty: number }[];
  /** Powder handed out this month to departments other than the painting
   *  sections — not set against their scrap. */
  elsewhere: { department: string; label: string; qty: number }[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function figures(withdrawn: number, scrap: number, weighed = true): PowderFigures {
  const w = r3(withdrawn);
  const s = r3(scrap);
  return { withdrawn: w, scrap: s, net: r3(w - s), rate: w > 0 && weighed ? s / w : null };
}

/** The days the report reads: the trend's first month to the month's end. */
export function powderSpan(month: string, trendMonths = 6): { from: string; to: string } {
  return { from: monthBounds(shiftMonth(month, -(trendMonths - 1))).from, to: monthBounds(month).to };
}

/**
 * The month's powder report: per painting section and together, withdrawn
 * against scrap, the month before, and the trend. `withdrawals` are every
 * hand-out of a powder item in the span (any department, any unit) — the
 * report sorts out which count.
 */
export function buildPowderReport(month: string, withdrawals: readonly PowderWithdrawal[], scraps: readonly ScrapEntry[], trendMonths = 6): PowderReport {
  const months = Array.from({ length: trendMonths }, (_, i) => shiftMonth(month, i - (trendMonths - 1)));
  const prevMonth = shiftMonth(month, -1);
  const monthOf = (dayISO: string) => dayISO.slice(0, 7);

  // month → department → kg
  const w = new Map<string, number>();
  const s = new Map<string, number>();
  const key = (m: string, d: string) => `${m}|${d}`;
  const add = (map: Map<string, number>, k: string, q: number) => map.set(k, (map.get(k) ?? 0) + q);

  const items = new Map<string, { item: string; uom: string; department: PowderDepartment; qty: number; handOuts: number }>();
  const notKg = new Map<string, { item: string; uom: string; qty: number }>();
  const elsewhere = new Map<string, number>();

  for (const x of withdrawals) {
    const m = monthOf(x.dayISO);
    const inMonth = m === month;
    if (!isKgUnit(x.uom)) {
      if (inMonth) {
        const k = `${x.item.toLowerCase()}|${x.uom}`;
        const cur = notKg.get(k) ?? { item: x.item, uom: x.uom ?? "", qty: 0 };
        cur.qty = r3(cur.qty + x.qty);
        notKg.set(k, cur);
      }
      continue;
    }
    if (!isPowderDepartment(x.department)) {
      if (inMonth) elsewhere.set(x.department, r3((elsewhere.get(x.department) ?? 0) + x.qty));
      continue;
    }
    add(w, key(m, x.department), x.qty);
    if (inMonth) {
      const k = `${x.item.toLowerCase()}|${x.department}`;
      const cur = items.get(k) ?? { item: x.item, uom: x.uom ?? "kg", department: x.department, qty: 0, handOuts: 0 };
      cur.qty = r3(cur.qty + x.qty);
      cur.handOuts += 1;
      items.set(k, cur);
    }
  }
  for (const x of scraps) if (isPowderDepartment(x.department)) add(s, key(monthOf(x.dayISO), x.department), x.kg);

  // a section-month with no weighing has no rate (s holds a key per weighing)
  const at = (m: string, d: string) => figures(w.get(key(m, d)) ?? 0, s.get(key(m, d)) ?? 0, s.has(key(m, d)));
  const both = (m: string) => figures(
    POWDER_DEPARTMENTS.reduce((n, d) => n + (w.get(key(m, d)) ?? 0), 0),
    POWDER_DEPARTMENTS.reduce((n, d) => n + (s.get(key(m, d)) ?? 0), 0),
    POWDER_DEPARTMENTS.some((d) => s.has(key(m, d))),
  );

  return {
    month,
    prevMonth,
    trendMonths: months,
    departments: POWDER_DEPARTMENTS.map((d) => ({
      department: d, label: sectionLabel(d), ...at(month, d), prev: at(prevMonth, d),
      trend: months.map((m) => ({ month: m, ...at(m, d) })),
    })),
    total: { ...both(month), prev: both(prevMonth), trend: months.map((m) => ({ month: m, ...both(m) })) },
    items: [...items.values()].sort((a, b) => b.qty - a.qty || a.item.localeCompare(b.item)),
    notKg: [...notKg.values()].sort((a, b) => a.item.localeCompare(b.item)),
    elsewhere: [...elsewhere.entries()].map(([department, qty]) => ({ department, label: sectionLabel(department), qty })).sort((a, b) => b.qty - a.qty),
  };
}
