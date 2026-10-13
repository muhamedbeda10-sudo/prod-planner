import { formatDate, formatDateTime } from "./format";

// A database row as a person reads it: its column names as words ("odooMo"
// → "Odoo MO", "fg_code" → "FG code"), its values as the app writes them
// everywhere else (a day "Mon 12 Oct", a moment "12 Oct 14:05", Yes / No),
// and nothing at all for an empty one. Pure — for the messages automations
// write and for the tables the assistant's answers show.

const ABBR: Readonly<Record<string, string>> = {
  mo: "MO", mos: "MOs", soi: "SOI", fg: "FG", bom: "BOM", boms: "BOMs", id: "ID", ids: "IDs", lv: "LV", qa: "QA", sql: "SQL",
  odoo: "Odoo", kva: "kVA", ok: "OK", url: "URL", osp: "OSP",
};

/** A column's name as words — a name already written for people (spaces,
 *  Arabic) stays as it is. */
export function humanizeKey(key: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) return key;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_.-]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((w, i) => {
      const l = w.toLowerCase();
      if (ABBR[l]) return ABBR[l];
      return i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l;
    })
    .join(" ");
}

/** A name that reads as a database column's (camelCase or snake_case) — what
 *  is worth turning into words in a table's head. */
export const looksLikeColumn = (s: string): boolean => /^[a-z]+(?:[A-Z][a-z0-9]*|_[a-z0-9]+)+$/.test(s.trim());

const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/;
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A date or a moment written the database's way, as the app writes it for
 *  people — or null when the text is not one. A day is stored at its UTC
 *  midnight, so that reads as the day alone. */
export function readableDate(s: string, now?: Date): string | null {
  const t = s.trim();
  if (ISO_DAY.test(t)) return formatDate(t.slice(0, 10), now);
  if (ISO_MOMENT.test(t)) return formatDateTime(t, now);
  return null;
}

/** A value as a person reads it — null for nothing (null, an empty text). */
export function readableValue(v: unknown, now?: Date): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : readableDate(v.toISOString(), now);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(Number.isInteger(v) ? v : Math.round(v * 100) / 100) : null;
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return s ? readableDate(s, now) ?? s : null;
  }
  if (typeof v === "object") {
    const o = v as { toNumber?: () => number };
    if (typeof o.toNumber === "function") return readableValue(o.toNumber(), now);
    if (Array.isArray(v)) {
      const parts = v.map((x) => readableValue(x, now)).filter((x): x is string => x !== null);
      return parts.length ? parts.join(", ") : null;
    }
    return JSON.stringify(v);
  }
  return String(v);
}
