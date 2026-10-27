// What an answer carries besides its words — pure, for the chat, the inbox
// and the printout alike:
//
//   followups   the next questions the assistant offers, as a fenced block
//               in the language "followups" holding a JSON list of short
//               strings; the chat draws them as buttons under the answer
//               and never as text. A report or a printout drops them.
//   scope       the line "Scope: …" the assistant closes a numerical answer
//               with (the line, the period, when the data was read) — drawn
//               as a quiet strip wherever the answer is read, never as prose.
//   depth       how hard one question is worked: the model and its effort
//               and the calls it may take, chosen by the person per question
//               (Quick / Standard / Deep) — the chat itself is on Auto.

import { AI_CALLS_RANGE, aiModel, type AiEffort } from "./ai";
import { BY_STRENGTH } from "./aiLearn";
import { evidenceAnchor } from "./aiEvidence";

export const AI_FOLLOWUPS_MAX = 3;
const FOLLOWUP_MAX_CHARS = 160;

const FOLLOWUPS_FENCE = /```(?:followups|follow-ups|follow_ups)[ \t]*\r?\n([\s\S]*?)```[ \t]*(?:\r?\n|$)/gi;
/** A fence still being written: the opening without its close. */
const FOLLOWUPS_OPEN = /```(?:followups|follow-ups|follow_ups)[ \t]*(?:\r?\n[\s\S]*)?$/i;

/** The follow-up questions in an answer — the LAST block wins, each a short
 *  line, at most AI_FOLLOWUPS_MAX, duplicates dropped. Anything that is not
 *  a list of strings is ignored, never trusted to be well formed. */
export function followupsOf(text: string): string[] {
  let last: string | null = null;
  for (const m of text.matchAll(FOLLOWUPS_FENCE)) last = m[1];
  if (last === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.trim());
  } catch {
    // one question a line is taken too — a model may skip the brackets
    parsed = last.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  }
  const list = Array.isArray(parsed) ? parsed : [];
  const out: string[] = [];
  for (const q of list) {
    if (typeof q !== "string") continue;
    const s = q.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!s || s.length > FOLLOWUP_MAX_CHARS || out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= AI_FOLLOWUPS_MAX) break;
  }
  return out;
}

/** The answer without its follow-up block(s) — what is printed, sent as a
 *  report, copied or rated. While it streams, a block still being written is
 *  cut off at its opening so the JSON never flashes as text. */
export function withoutFollowups(text: string, streaming = false): string {
  let out = text.replace(FOLLOWUPS_FENCE, "");
  if (streaming) out = out.replace(FOLLOWUPS_OPEN, "");
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

const SCOPE_LINE = /^(?:\*\*)?(?:Scope|النطاق|نطاق)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/iu;

/** The scope an answer closes with — "Scope: TR · 1–26 Oct · read 14:32"
 *  (in Arabic "النطاق: …") — read off one line of it; null for any other
 *  line. The renderer draws such a line as a strip wherever the answer is
 *  read: the chat, the inbox, the printout. */
export function scopeLineOf(line: string): string | null {
  const m = SCOPE_LINE.exec(line.trim());
  if (!m) return null;
  const scope = m[1].trim();
  return scope && scope.length <= 200 ? scope : null;
}

// ------------------------------------------------------------- sharing

/** A chat's name in the list, at most. */
export const AI_CONVERSATION_TITLE_MAX = 80;

/** The most chats one click deletes or pins. */
export const AI_CHATS_BULK_MAX = 200;

/** The chats a bulk delete or pin names: whole positive ids, each once, at
 *  most AI_CHATS_BULK_MAX — anything else from the browser is dropped. */
export function chatIdsOf(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const out = new Set<number>();
  for (const id of ids) {
    if (typeof id === "number" && Number.isInteger(id) && id > 0) out.add(id);
    if (out.size >= AI_CHATS_BULK_MAX) break;
  }
  return [...out];
}

const SOURCE_LINK = new RegExp(`\\s*\\(?\\[[^\\]]*\\]\\(#${evidenceAnchor("")}[^)]*\\)\\)?`, "g");

/** The source links an answer carries ("([Source](#ai-source-…))") — they
 *  open the chat's own source cards, which no other screen has — taken out:
 *  what a shared answer or the chat's plain text carries. */
export function withoutSourceLinks(markdown: string): string {
  return markdown.replace(SOURCE_LINK, "");
}

/** An answer as plain text for the team chat: no chart or follow-up
 *  blocks, no source links, the Markdown marks off, a table as lines. */
export function chatTextOf(markdown: string): string {
  return withoutSourceLinks(withoutFollowups(markdown))
    .replace(/```[a-z-]*\s*\n[\s\S]*?```/gi, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$\n?/gm, "")
    .replace(/^[ \t]*\|[ \t]*/gm, "").replace(/[ \t]*\|[ \t]*$/gm, "").replace(/[ \t]*\|[ \t]*/g, " · ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ------------------------------------------------------------------ depth

export const AI_DEPTHS = ["quick", "standard", "deep"] as const;
export type AiDepth = (typeof AI_DEPTHS)[number];
export const DEFAULT_AI_DEPTH: AiDepth = "standard";

export const AI_DEPTH_META: Record<AiDepth, { label: string; hint: string }> = {
  quick: { label: "Quick", hint: "A fast look-up on the cheapest model (Haiku), low effort — a figure, a list, a status." },
  standard: { label: "Standard", hint: "The model the question needs (Haiku for a look-up, Sonnet for a change, Opus for analysis or a file), medium effort — most questions." },
  deep: { label: "Deep", hint: "The strongest model (Opus), high effort, with more look-ups — analysis, plans, reviews, what-ifs." },
};

export function isAiDepth(v: unknown): v is AiDepth {
  return typeof v === "string" && (AI_DEPTHS as readonly string[]).includes(v);
}

/** How hard each depth thinks — the person picks it beside the box, so the
 *  owner sets no effort for the chat. */
export const AI_DEPTH_EFFORT: Record<AiDepth, AiEffort> = { quick: "low", standard: "medium", deep: "high" };

/** The model, effort and calls for one question at a depth. The chat is on
 *  Auto: Standard takes the model routed for the question (routeModel),
 *  Quick the cheapest and Deep the strongest, with half again the calls.
 *  Each question takes its own model — a chat moved up for one hard question
 *  comes back down for the next look-up. */
export function depthPlan(depth: AiDepth, o: { routed: string; maxCalls: number }): { model: string; effort: AiEffort; maxCalls: number } {
  const pick = depth === "quick" ? BY_STRENGTH[0] : depth === "deep" ? BY_STRENGTH[BY_STRENGTH.length - 1] : o.routed;
  const maxCalls = depth === "deep" ? Math.min(AI_CALLS_RANGE.max, Math.ceil(o.maxCalls * 1.5)) : o.maxCalls;
  return { model: aiModel(pick).id, effort: AI_DEPTH_EFFORT[depth], maxCalls };
}

// --------------------------------------------------------- page suggestions

/** The questions offered on an empty chat, by the screen open beside it —
 *  a question the person is likely to have there, in both languages the
 *  plant writes. The default set is for any other screen. */
export const AI_PAGE_SUGGESTIONS: Record<string, string[]> = {
  dashboard: [
    "إيه اللي هيأخر الخطة؟",
    "أنهي مركز محتاج عمالة لنهاية الشهر؟",
    "Where does the work wait between the stages, and which queue is the biggest?",
    "قارن التزام TR وLV بالخطة، كل خط بمقياسه",
    "اعملي مراجعة بداية اليوم للخطين واقترح أهم 3 أولويات بالأسباب",
  ],
  tracker: [
    "لخصلي الخطة الشهرية حسب الفلاتر الظاهرة، بالإنجاز والمتبقي ومصادر الأرقام",
    "Which lines of the weekly plan are behind, and at which stage?",
    "إيه أكتر الأوردرات اللي هتتأخر عن الـ delivery وليه؟",
    "What do we need to deliver the late orders on time? Give me the steps.",
    "لو زودنا عامل في اللحام واشتغلنا الجمعة، إيه اللي هيتغير في التسليمات؟",
  ],
  handover: [
    "لخصلي إنتاج النهارده بالقسم مقارنة بإمبارح",
    "Which days this week have no output recorded for a department?",
    "قارن إنتاج آخر 7 أيام بالفترة اللي قبلها ووضح فرص التحسين",
  ],
  "worklist.cut": ["إيه الـ sheet jobs اللي واقفة في التقطيع وليه؟", "Which lines on the fabrication worklist have no machine yet?", "وزّع شغل النهارده على الليزرات واعرضلي الخطة"],
  "worklist.welding": ["إيه اللي متأخر في اللحام النهارده؟", "How is welding's coverage against the oven dates this week?", "مين أكتر عامل لحام إنتاجًا الأسبوع ده؟"],
  "worklist.leak-test": ["إيه التانكات اللي سقطت في الـ leak test الأسبوع ده وأسبابها؟", "Which tanks are waiting for a repair?", "ارسملي نتايج الـ leak test يوم بيوم كـ control chart"],
  "worklist.painting": ["إيه اللي واقف في الدهان النهارده؟", "Which orders are painted but not delivered?", "كام قطعة اتدهنت الأسبوع ده مقارنة بالخطة؟"],
  "worklist.machines": ["وزّن حمل الماكينات النهارده", "Which machine is overloaded this week, and what can move?", "إيه الماكينات اللي واقفة دلوقتي ومن إمتى؟"],
  "worklist.punching": ["إيه اللي واقف في الـ punching النهارده؟", "Which LV panels are behind at punching?"],
  "worklist.bending": ["إيه اللي واقف في الـ bending النهارده؟", "Which LV panels are behind at bending?"],
  material: ["Which open orders still have no nesting on the Material tab?", "إيه الأوردرات اللي ناقصها خامة وبتأثر على خطة الأسبوع؟", "كام الـ scrap المتوقع في الـ nesting الحالي؟"],
  odoo: ["إيه الـ MOs اللي مستنية تتقفل في الأودو؟", "Which Odoo close-outs disagree with the Daily log?", "لخصلي إقفالات الشهر بالمكوّن"],
  shifts: [
    "ليه كفاءة اللحام قلت؟",
    "قارن أداء TR وLV بالساعات المعيارية آخر 7 أيام",
    "كام تانك 630 kVA اتلحم الشهر ده مقابل الخطة؟",
    "How many USS and LSS panels were painted this month against the plan?",
    "Which machine stops cost the most hours this week, by cause — and which machines are stopped now?",
    "إيه الأيام اللي فيها إنتاج من غير ساعات عمالة أو العكس؟",
    "مين غايب النهارده في كل قسم؟",
  ],
  consumables: ["إيه الأصناف اللي قربت تخلص أو عدّت الحد؟", "What did painting draw this month against its limit?", "كام البودرة اللي اتهدرت الشهر ده؟"],
  physical: ["إيه الخامات اللي رصيدها الفعلي أقل من المطلوب للخطة؟", "Which sheets are short for this week's jobs?"],
  barcode: ["فين التانك ده دلوقتي وإيه اللي حصله؟", "Which tanks were sent back this week, and why?"],
  calendar: ["إيه الأجازات الجاية وتأثيرها على الخطة؟", "How many working days are left this month?"],
  orders: ["إيه الأوردرات اللي اتضافت الشهر ده ومش في أي خطة؟", "Which orders have no delivery date?"],
  "standard-times": ["إيه المكونات اللي ملهاش standard time؟", "Which centre's capacity is set below its recent output?"],
  machines: ["إيه القواعد الحالية لتوزيع الشغل على الماكينات؟", "Which machine has no rate for a product it runs?"],
};

export const AI_DEFAULT_SUGGESTIONS: string[] = [
  "لخصلي الخطة الشهرية حسب الفلاتر الظاهرة، بالإنجاز والمتبقي ومصادر الأرقام",
  "اعملي مراجعة بداية اليوم للخط المختار واقترح أهم 3 أولويات بالأسباب",
  "راجع جاهزية توقعات المحولات ووضح البيانات الناقصة قبل ما نعتمد عليها",
  "إيه الـ MOs اللي مستنية تتقفل في الأودو؟",
  "قارن إنتاج آخر 7 أيام بالفترة اللي قبلها ووضح فرص التحسين",
  "Which open orders still have no nesting on the Material tab?",
];

/** Whether a screen has questions of its own on an empty chat. */
export const hasPageSuggestions = (tabId: string | null): boolean => !!tabId && (AI_PAGE_SUGGESTIONS[tabId]?.length ?? 0) > 0;

/** The suggestions for a screen, then the defaults it does not repeat — up to `max`. */
export function suggestionsFor(tabId: string | null, max = 6): string[] {
  const own = (tabId && AI_PAGE_SUGGESTIONS[tabId]) || [];
  const out = [...own];
  for (const q of AI_DEFAULT_SUGGESTIONS) {
    if (out.length >= max) break;
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, max);
}
