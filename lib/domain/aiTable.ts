// How an answer's Markdown table and callouts read — pure, for the renderer
// (components/AiMarkdown.tsx) and its tests:
//
//   a column is names (an MO, a BOM, a code — never grouped), years and
//   dates (a bare year stays as it is) or amounts (grouped), read off its
//   head; a figure of four digits or more gets its thousands separated by
//   that kind; a long table folds past TABLE_FOLD_AT rows; a blockquote
//   opening with ⚠️ / ✅ / ❌ is a callout in that tone.

/** How many rows a table shows before it folds. */
export const TABLE_FOLD_AT = 15;

/** What a column holds, read off its head. With no head to go by
 *  ("unknown"), a bare year is left alone and a figure of five digits or
 *  more is grouped — a four-digit one may be an MO. */
export type ColumnKind = "id" | "year" | "amount" | "unknown";
export function columnKind(head: string): ColumnKind {
  const h = head.trim();
  if (!h) return "unknown";
  if (/\b(mo|mos|bom|boms|soi|id|ids|code|codes|serial|serials|badge|ref|kva|fg)\b|\bno\.?$|رقم|كود|سيريال/i.test(h)) return "id";
  if (/\b(year|date|day|month|week)\b|سنة|تاريخ|يوم|شهر|أسبوع/i.test(h)) return "year";
  return "amount";
}

/** A plain figure of four digits or more, as the model may write it
 *  ("12340", "12340.5", "-12340 pcs"), with its thousands separated — by
 *  the kind of column it sits in; null when it is left as it is. */
export function groupedFigure(text: string, kind: ColumnKind = "unknown"): string | null {
  if (kind === "id") return null;
  const m = /^(\s*[-−+]?)(\d{4,})((?:\.\d+)?)(\s*(?:%|pcs|pc|h|hrs|kg|mm|days?|يوم|أيام|قطعة|ساعة|كجم)?\.?\s*)$/u.exec(text);
  if (!m) return null;
  const [, sign, digits, decimals, unit] = m;
  const bare = !decimals && !unit.trim();
  if (kind !== "amount" && bare && /^(19|20)\d\d$/.test(digits)) return null;
  if (kind === "unknown" && bare && digits.length === 4) return null;
  return `${sign}${Number(digits).toLocaleString("en-US")}${decimals}${unit}`;
}

export type CalloutTone = "warn" | "ok" | "bad";

/** The tone a callout opens with, and the line without the mark. */
export function calloutOf(text: string): { tone: CalloutTone; text: string } | null {
  const t = text.trimStart();
  if (t.startsWith("⚠️") || t.startsWith("⚠")) return { tone: "warn", text: t.replace(/^⚠️?\s*/, "") };
  if (t.startsWith("✅")) return { tone: "ok", text: t.replace(/^✅\s*/, "") };
  if (t.startsWith("❌") || t.startsWith("🚫")) return { tone: "bad", text: t.replace(/^[❌🚫]\s*/u, "") };
  return null;
}

/** The leading callout mark off a text (the icon stands for it). */
export const withoutCalloutMark = (text: string) => text.replace(/^\s*(?:⚠️|⚠|✅|❌|🚫)\s*/u, "");
