// How an answer's Markdown table and callouts read — pure, for the renderer
// (components/AiMarkdown.tsx) and its tests:
//
//   a column is names (an MO, a BOM, a code — never grouped), years and
//   dates (a bare year stays as it is) or amounts (grouped), read off its
//   head; a figure of four digits or more gets its thousands separated by
//   that kind; a long table folds past TABLE_FOLD_AT rows; a blockquote
//   opening with ⚠️ / ✅ / ❌ / 💡 is a callout in that tone; a heading is a
//   section of a kind (Summary, Causes, Suggestions …) that gets its icon.

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

/** The units a figure in a cell may carry, as the model writes them. */
export const FIGURE_UNITS = "pcs|pc|h|hrs|kg|mm|d|days?|يوم|أيام|قطعة|ساعة|كجم";

const FIGURE = new RegExp(`^(\\s*[-−+]?)(\\d{4,})((?:\\.\\d+)?)(\\s*(?:%|${FIGURE_UNITS})?\\.?\\s*)$`, "u");

/** A plain figure of four digits or more, as the model may write it
 *  ("12340", "12340.5", "-12340 pcs"), with its thousands separated — by
 *  the kind of column it sits in; null when it is left as it is. */
export function groupedFigure(text: string, kind: ColumnKind = "unknown"): string | null {
  if (kind === "id") return null;
  const m = FIGURE.exec(text);
  if (!m) return null;
  const [, sign, digits, decimals, unit] = m;
  const bare = !decimals && !unit.trim();
  if (kind !== "amount" && bare && /^(19|20)\d\d$/.test(digits)) return null;
  if (kind === "unknown" && bare && digits.length === 4) return null;
  return `${sign}${Number(digits).toLocaleString("en-US")}${decimals}${unit}`;
}

export type CalloutTone = "warn" | "ok" | "bad" | "info";

/** The marks a callout opens with, and their tone. */
const MARKS: readonly [string, CalloutTone][] = [["⚠️", "warn"], ["⚠", "warn"], ["✅", "ok"], ["❌", "bad"], ["🚫", "bad"], ["💡", "info"], ["ℹ️", "info"], ["ℹ", "info"]];
const MARK = new RegExp(`^\\s*(?:${MARKS.map(([m]) => m).join("|")})\\s*`, "u");

/** The tone a callout opens with — null for a plain quote. */
export function calloutOf(text: string): CalloutTone | null {
  const t = text.trimStart();
  return MARKS.find(([m]) => t.startsWith(m))?.[1] ?? null;
}

/** The leading callout mark off a text (the icon stands for it). */
export const withoutCalloutMark = (text: string) => text.replace(MARK, "");

/** What a section of an answer is about, read off its heading — the icon
 *  and the tone the chat gives it. */
export type SectionKind = "summary" | "details" | "causes" | "suggestions" | "risks" | "next" | "status" | "schedule" | "material" | "quality" | "figures" | "notes" | "other";

/** The words that name each kind, in English and in Arabic — the first
 *  kind whose words the heading holds wins, so the narrower come first. */
const SECTION_WORDS: readonly [SectionKind, RegExp][] = [
  ["summary", /\bsummary\b|\boverview\b|\bin short\b|\bverdict\b|\bconclusion\b|الخلاصة|ملخص|باختصار|النتيجة|نظرة عامة/i],
  ["next", /\bnext steps?\b|\bwhat to do\b|\bactions?\b|خطوات|المطلوب|هنعمل|نعمل إيه|إجراءات/i],
  ["suggestions", /\bsuggest|\brecommend|\badvice\b|\bfix(es)?\b|اقتراح|توصي|نصيح|الحل|حلول/i],
  ["causes", /\bcauses?\b|\bwhy\b|\breasons?\b|\broot\b|\banalysis\b|السبب|أسباب|(?:^|\s)ليه|تحليل/i],
  ["risks", /\brisks?\b|\bwarnings?\b|\bwatch\b|\bissues?\b|\bproblems?\b|\blate\b|\bdelay|مخاطر|تحذير|مشاكل|مشكلة|متأخر|تأخير/i],
  ["schedule", /\bschedule\b|\btimeline\b|\bdates?\b|\bplan\b|\bweek|\bdue\b|الجدول|مواعيد|خطة|التواريخ|الأسبوع/i],
  ["material", /\bmaterials?\b|\bstock\b|\bsheets?\b|\bconsumables?\b|خامات|المواد|الماتريال|المخزون|الصاج|المستهلكات/i],
  ["quality", /\bquality\b|\bleak\b|\brejects?\b|\bscrap\b|\bdefects?\b|جودة|التسريب|المرفوض|الهالك|عيوب/i],
  ["status", /\bstatus\b|\bprogress\b|\bwhere\b|\bstate\b|\bload\b|\bcapacity\b|الحالة|الوضع|التقدم|موقف|الحمل|الطاقة/i],
  ["figures", /\bfigures?\b|\bnumbers?\b|\bkpis?\b|\bmetrics?\b|\boutput\b|\btotals?\b|\befficiency\b|أرقام|المؤشرات|الإنتاج|الإجمالي|الكفاءة/i],
  ["details", /\bdetails?\b|\bbreakdown\b|\blist\b|\borders?\b|تفاصيل|القائمة|الأوردرات/i],
  ["notes", /\bnotes?\b|\bassumptions?\b|\bcaveats?\b|\bnot checked\b|ملاحظ|افتراضات/i],
];

/** A heading's leading emoji (and the space after it) — the chat's icon
 *  stands for it, so a heading never carries two. */
const LEADING_EMOJI = /^\s*(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]|[0-9#*]\u{FE0F}?\u{20E3})+\s*/u;

/** The heading's text without a leading emoji. */
export const withoutLeadingEmoji = (text: string) => text.replace(LEADING_EMOJI, "");

/** The kind of section a heading opens — "other" when none of the words fit. */
export function sectionOf(heading: string): SectionKind {
  const t = withoutLeadingEmoji(heading).trim();
  return SECTION_WORDS.find(([, words]) => words.test(t))?.[0] ?? "other";
}
