// What the assistant can do, as tiles on top of an empty chat (and behind the
// composer's ✨ button in a chat already going): a report, a chart, an Excel
// file, a what-if, a plan to a deadline, the morning briefing, what looks
// wrong, why an efficiency moved, a handwritten sheet scanned, an automation.
// A tile with fields opens a short form — the period, the department, the
// form of the answer — and the question is written from what was picked, in
// the plant's Arabic, so the answer comes back in it too. A tile without
// fields asks straight away; "scan" opens the camera instead (the chat does it).

import { oneLine } from "./aiExplain";
import { parseISODate } from "./dates";

export type AiQuickId = "report" | "chart" | "excel" | "whatif" | "deadline" | "briefing" | "problems" | "why" | "scan" | "automation";

/** A field of a tile's form — the shape the chat's form dialog takes. */
export interface AiQuickField {
  name: string;
  label: string;
  type: "text" | "date" | "select";
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  options?: Opt[];
}

export interface AiQuickAction {
  id: AiQuickId;
  label: string;
  /** One line under the label on the tile. */
  hint: string;
  /** The form's fields; none: the question goes as soon as the tile is clicked. */
  fields: AiQuickField[];
  /** The form's button. */
  confirmLabel?: string;
  /** Shown only to whoever may make automations. */
  automationsOnly?: boolean;
}

type Values = Record<string, string | undefined>;

/** A choice of a form: its value, its label on screen, and how the question says it. */
interface Opt {
  value: string;
  label: string;
  ar: string;
}
const opt = (value: string, label: string, ar = ""): Opt => ({ value, label, ar });
/** How the question says the choice picked — "" for none of the list's. */
const arOf = (list: readonly Opt[], value: string | undefined) => list.find((o) => o.value === value)?.ar ?? "";

const PERIODS = [
  opt("today", "Today", "النهارده"),
  opt("yesterday", "Yesterday", "إمبارح"),
  opt("week", "This week", "الأسبوع ده"),
  opt("last7", "Last 7 days", "آخر 7 أيام"),
  opt("month", "This month", "الشهر ده"),
  opt("lastMonth", "Last month", "الشهر اللي فات"),
];

const DEPTS = [
  opt("all", "All departments"),
  opt("Fabrication", "Fabrication"),
  opt("Welding", "Welding"),
  opt("Leak test", "Leak test"),
  opt("Painting & Shot Blast", "Painting & Shot Blast"),
  opt("Punching", "Punching (LV)"),
  opt("Bending", "Bending (LV)"),
];

const LINES = [opt("screen", "The line on screen"), opt("TR", "Transformers", "لخط المحولات (TR)"), opt("LV", "LV Panels", "لخط لوحات الـ LV"), opt("both", "Both lines", "للخطين TR وLV، كل خط بمقياسه")];

const period = (defaultValue = "month"): AiQuickField => ({ name: "period", label: "Period", type: "select", defaultValue, options: PERIODS });
const fromTo: AiQuickField[] = [
  { name: "from", label: "From (optional)", type: "date", hint: "A date here takes the place of the period above." },
  { name: "to", label: "To (optional)", type: "date" },
];
const dept: AiQuickField = { name: "dept", label: "Department", type: "select", defaultValue: "all", options: DEPTS };
const line: AiQuickField = { name: "line", label: "Line", type: "select", defaultValue: "screen", options: LINES };
const notes = (placeholder: string): AiQuickField => ({ name: "notes", label: "Anything else (optional)", type: "text", placeholder });

const REPORT_TOPICS = [
  opt("output", "Output and efficiency", "الإنتاج والكفاءة"),
  opt("plan", "Progress against the monthly plan", "الإنجاز مقابل الخطة الشهرية"),
  opt("late", "Late and at-risk orders", "الأوردرات المتأخرة والمعرّضة للتأخير"),
  opt("stops", "Machine stops and downtime", "توقفات الماكينات والوقت الضايع"),
  opt("material", "Material and nesting", "الخامات والـ nesting"),
  opt("consumables", "Consumables against their limits", "المستهلكات مقابل حدودها"),
  opt("odoo", "Odoo close-outs", "إقفالات الأودو"),
  opt("quality", "Leak test and quality", "الـ leak test والجودة"),
  opt("people", "Attendance and man-hours", "الحضور وساعات العمالة"),
];
const REPORT_FORMATS = [
  opt("summary", "Summary, table and chart", "الشكل: الخلاصة في أول سطرين، بعدها جدول بالأرقام ورسم بياني لو بيوضّح، وفي الآخر أهم 3 اقتراحات."),
  opt("excel", "Excel file", "الشكل: ملف Excel بالتفاصيل كلها، وفي الرد ملخص قصير بأهم الأرقام."),
  opt("print", "Ready to print (PDF)", "الشكل: تقرير جاهز للطباعة — عناوين واضحة، جداول، ورسم بياني — عشان أطبعه PDF."),
  opt("charts", "Charts first", "الشكل: رسوم بيانية أساسًا، مع سطر تحت كل رسم بيقول بيوضّح إيه."),
];
const COMPARE = [opt("none", "No comparison"), opt("previous", "The period before", "وقارنه بالفترة اللي قبلها بنفس الطول."), opt("plan", "The plan", "وقارنه بالخطة."), opt("lastMonth", "The same days last month", "وقارنه بنفس الأيام من الشهر اللي فات.")];

const CHART_METRICS = [
  opt("output", "Output by department", "الإنتاج حسب القسم"),
  opt("efficiency", "Efficiency by department", "الكفاءة حسب القسم"),
  opt("plan", "Planned against achieved", "المخطط مقابل المنفّذ"),
  opt("stops", "Machine stops by cause", "توقفات الماكينات حسب السبب"),
  opt("component", "Output by component", "الإنتاج حسب المكوّن"),
  opt("hours", "Booked against earned hours", "الساعات المسجّلة مقابل الساعات المعيارية المكتسبة"),
  opt("leak", "Leak-test results", "نتايج الـ leak test"),
  opt("consumables", "Consumables against limits", "المستهلكات مقابل حدودها"),
];
const CHART_KINDS = [
  opt("auto", "Let the assistant pick"),
  opt("bar", "Bars", "أعمدة (bar)"),
  opt("line", "Line over time", "خط على الزمن (line)"),
  opt("pie", "Pie (parts of a whole)", "دايرة (pie)"),
  opt("pareto", "Pareto (causes ranked)", "باريتو (pareto)"),
  opt("heatmap", "Heatmap", "خريطة حرارية (heatmap)"),
  opt("gauge", "Gauge against target", "عدّاد مقابل الهدف (gauge)"),
  opt("control", "Control chart", "control chart"),
];
const GROUPS = [opt("day", "Day", "باليوم"), opt("week", "Week", "بالأسبوع"), opt("dept", "Department", "بالقسم"), opt("machine", "Machine", "بالماكينة"), opt("component", "Component", "بالمكوّن")];

const SHEETS = [
  opt("plan", "Plan Tracker (with its filters)", "الـ Plan Tracker بالفلاتر اللي على الشاشة"),
  opt("daily", "Daily log", "الـ Daily log"),
  opt("production", "Production by day", "الإنتاج يوم بيوم"),
  opt("orders", "Orders registry", "سجل الأوردرات"),
  opt("odoo", "ODOO log", "الـ ODOO log"),
  opt("material", "Material", "شيت الـ Material"),
  opt("consumables", "Consumables log", "سجل صرف المستهلكات"),
  opt("attendance", "Shift attendance", "حضور الورديات"),
  opt("stops", "Machine stops", "توقفات الماكينات"),
];
const SPLITS = [opt("none", "One sheet"), opt("dept", "A sheet per department", "شيت لكل قسم"), opt("thickness", "A sheet per thickness", "شيت لكل تخانة"), opt("material", "A sheet per material", "شيت لكل خامة"), opt("component", "A sheet per component", "شيت لكل مكوّن")];

const HORIZONS = [opt("week", "This week", "الأسبوع ده"), opt("month", "This month", "الشهر ده"), opt("next30", "The next 30 days", "الـ 30 يوم الجايين")];

const CADENCES = [opt("new", "Whenever something new shows up", "تتشيّك كل شوية وتبعت أول ما يظهر جديد"), opt("morning", "Every working morning", "كل يوم شغل الصبح"), opt("weekly", "Every week (Sunday)", "كل أسبوع يوم الحد الصبح")];

export const AI_QUICK_ACTIONS: readonly AiQuickAction[] = [
  {
    id: "report",
    label: "Build a report",
    hint: "Any topic and period — summary, Excel or PDF",
    confirmLabel: "Build the report",
    fields: [
      { name: "topic", label: "About", type: "select", defaultValue: "output", options: REPORT_TOPICS },
      period(),
      ...fromTo,
      dept,
      line,
      { name: "compare", label: "Compare with", type: "select", defaultValue: "previous", options: COMPARE },
      { name: "format", label: "As", type: "select", defaultValue: "summary", options: REPORT_FORMATS },
      notes("e.g. only the 630 kVA tanks, by shift"),
    ],
  },
  {
    id: "chart",
    label: "Draw a chart",
    hint: "Output, efficiency, stops or the plan, drawn",
    confirmLabel: "Draw it",
    fields: [
      { name: "metric", label: "What", type: "select", defaultValue: "output", options: CHART_METRICS },
      { name: "kind", label: "Chart", type: "select", defaultValue: "auto", options: CHART_KINDS },
      { name: "group", label: "Split by", type: "select", defaultValue: "day", options: GROUPS },
      period("last7"),
      ...fromTo,
      dept,
    ],
  },
  {
    id: "excel",
    label: "Excel file",
    hint: "Any sheet of the app, filtered and split",
    confirmLabel: "Make the file",
    fields: [
      { name: "sheet", label: "Sheet", type: "select", defaultValue: "plan", options: SHEETS },
      period(),
      ...fromTo,
      { name: "split", label: "Layout", type: "select", defaultValue: "none", options: SPLITS },
      notes("e.g. a Total row for the quantities, only rows with a machine"),
    ],
  },
  {
    id: "whatif",
    label: "What if…",
    hint: "Simulate a change, see the deliveries",
    confirmLabel: "Simulate",
    fields: [
      { name: "change", label: "The change", type: "text", required: true, placeholder: "e.g. one more welder and we work Fridays" },
      { name: "horizon", label: "Over", type: "select", defaultValue: "month", options: HORIZONS },
    ],
  },
  {
    id: "deadline",
    label: "Plan to a deadline",
    hint: "What it takes to deliver orders by a date",
    confirmLabel: "Make the plan",
    fields: [
      { name: "orders", label: "Which orders (optional)", type: "text", placeholder: "e.g. SOI 1234, the 1000 kVA tanks — empty: the late ones" },
      { name: "by", label: "Deliver by", type: "date", required: true },
    ],
  },
  { id: "briefing", label: "Morning briefing", hint: "Yesterday vs the plan, risks, today's top 3", fields: [] },
  { id: "problems", label: "What looks wrong", hint: "Data gaps and stuck work, with the fix", fields: [] },
  {
    id: "why",
    label: "Why did it change?",
    hint: "The causes behind an efficiency move",
    confirmLabel: "Find out",
    fields: [{ ...dept, defaultValue: "Welding" }, period("week")],
  },
  { id: "scan", label: "Scan a paper sheet", hint: "Photo of a paper form → records to approve", fields: [] },
  {
    id: "automation",
    label: "New automation",
    hint: "Watch for something, message people",
    confirmLabel: "Prepare it",
    automationsOnly: true,
    fields: [
      { name: "what", label: "Watch for", type: "text", required: true, placeholder: "e.g. MOs closed in Odoo with no material" },
      { name: "cadence", label: "When", type: "select", defaultValue: "new", options: CADENCES },
      { name: "to", label: "Send to (optional)", type: "text", placeholder: "Names — empty: you" },
    ],
  },
];

/** The tiles a person sees: the automation only for whoever may make one. */
export function quickActionsFor(o: { automations: boolean }): AiQuickAction[] {
  return AI_QUICK_ACTIONS.filter((a) => !a.automationsOnly || o.automations);
}

/** A real calendar day typed as YYYY-MM-DD — "" otherwise. */
const isoDay = (v: string | undefined) => (v && parseISODate(v) ? v.trim() : "");
const clean = (v: string | undefined, max = 300) => oneLine(v ?? "", max);

/** "من 2026-10-01 لـ 2026-10-26", or the period picked (this month by default). Dates in the wrong order are put right. */
export function periodText(v: Values): string {
  let from = isoDay(v.from);
  let to = isoDay(v.to);
  if (from && to && from > to) [from, to] = [to, from];
  if (from && to) return `من ${from} لـ ${to}`;
  if (from) return `من ${from} لحد النهارده`;
  if (to) return `لحد ${to}`;
  return arOf(PERIODS, v.period) || arOf(PERIODS, "month");
}

const deptText = (v: Values) => (v.dept && v.dept !== "all" ? `لقسم ${clean(v.dept, 60)}` : "لكل الأقسام");
const lineText = (v: Values) => arOf(LINES, v.line);
const notesText = (v: Values) => (clean(v.notes) ? `\nملاحظات: ${clean(v.notes)}` : "");
const join = (...parts: string[]) => parts.filter(Boolean).join(" ");

/** The question a tile asks, written from what its form picked. Null for
 *  "scan" (the camera opens instead) and for a form missing what it needs. */
export function composeQuickQuestion(id: AiQuickId, v: Values = {}): string | null {
  switch (id) {
    case "report": {
      const topic = arOf(REPORT_TOPICS, v.topic) || arOf(REPORT_TOPICS, "output");
      const head = join(`اعملي تقرير عن ${topic}`, periodText(v), deptText(v), lineText(v)) + ".";
      return [join(head, arOf(COMPARE, v.compare)), arOf(REPORT_FORMATS, v.format) || arOf(REPORT_FORMATS, "summary")].join("\n") + notesText(v);
    }
    case "chart": {
      const metric = arOf(CHART_METRICS, v.metric) || arOf(CHART_METRICS, "output");
      const kind = arOf(CHART_KINDS, v.kind);
      return join(`ارسملي ${metric}`, arOf(GROUPS, v.group), periodText(v), deptText(v)) + `.\n${kind ? `نوع الرسم: ${kind}.` : "اختار نوع الرسم الأنسب."} واكتب سطر بيقول الرسم بيوضّح إيه وأهم ملاحظة عليه.`;
    }
    case "excel": {
      const sheet = arOf(SHEETS, v.sheet) || arOf(SHEETS, "plan");
      const split = arOf(SPLITS, v.split);
      return join(`اعملي ملف Excel لـ ${sheet}`, periodText(v)) + `.${split ? ` ${split} في نفس الملف.` : ""}` + notesText(v);
    }
    case "whatif": {
      const change = clean(v.change);
      if (!change) return null;
      return `لو ${change}، إيه اللي هيتغير في ${arOf(HORIZONS, v.horizon) || arOf(HORIZONS, "month")}؟\nشغّل محاكاة وقارنها بالوضع الحالي: التسليمات، الحمل على كل مركز، والأوردرات اللي هتلحق أو هتتأخر.`;
    }
    case "deadline": {
      if (!isoDay(v.by)) return null;
      const orders = clean(v.orders) || "الأوردرات المتأخرة";
      return `عايز أسلّم ${orders} قبل ${v.by}.\nاعملي خطة: المطلوب من كل قسم يوم بيوم، الماكينات، العمالة أو الإضافي اللازم، والمخاطر اللي ممكن تأخرنا.`;
    }
    case "briefing":
      return "اعملي مراجعة بداية اليوم: اللي اتعمل إمبارح مقابل الخطة، المتأخر والمعرّض للخطر، الماكينات الواقفة، الغياب، وأهم 3 أولويات النهارده بالأسباب.";
    case "problems":
      return "إيه اللي غلط أو ناقص دلوقتي في الداتا أو في الشغل؟ راجع تنبيهات المراقبة والشغل الواقف، ورتّبهم بالأهمية مع طريقة إصلاح كل واحد.";
    case "why": {
      const d = v.dept && v.dept !== "all" ? `قسم ${clean(v.dept, 60)}` : "الأقسام";
      return `ليه كفاءة وإنتاج ${d} اتغيروا ${periodText(v)}؟\nحلّل الأسباب: الساعات، الإنتاج، التوقفات، الغياب، ونوع الشغل — وقارن بالفترة اللي قبلها واقترح إزاي نحسّن.`;
    }
    case "automation": {
      const what = clean(v.what);
      if (!what) return null;
      const to = clean(v.to, 160) || "ليا أنا";
      return `اعملي automation: ${what}.\nالتوقيت: ${arOf(CADENCES, v.cadence) || arOf(CADENCES, "new")}. ابعت النتيجة لـ ${to}.`;
    }
    case "scan":
      return null;
  }
}
