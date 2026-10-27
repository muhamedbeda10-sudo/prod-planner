// What the assistant can do, as tiles on top of an empty chat (and behind the
// composer's ✨ button in a chat already going): a report, a chart, an Excel
// file, a what-if, a plan to a deadline, the morning briefing, what looks
// wrong, why an efficiency moved, the planner's controls (what to run next,
// the load against capacity, the bottleneck, a rush order, why an order is
// late, whether it can be released, input/output, a planning idea explained),
// a handwritten sheet scanned, an automation.
// A tile with fields opens a short form — the period, the department, the
// form of the answer — and the question is written from what was picked, in
// the plant's Arabic, so the answer comes back in it too. A tile without
// fields asks straight away; "scan" opens the camera instead (the chat does it).

import { oneLine } from "./aiExplain";
import { parseISODate } from "./dates";

export type AiQuickId =
  | "report" | "chart" | "excel" | "whatif" | "deadline" | "briefing" | "problems" | "why"
  | "dispatch" | "load" | "bottleneck" | "rush" | "late" | "release" | "io" | "learn"
  | "scan" | "automation";

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
  { name: "from", label: "From (optional)", type: "date" },
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

const STATIONS = [opt("weld", "Welding", "قسم اللحام (Welding)"), opt("cut", "Fabrication", "قسم الـ Fabrication (التقطيع والتشكيل)"), opt("finish", "Painting & Shot Blast", "قسم الدهان والـ shot blast")];
const RULES = [
  opt("CR", "Critical ratio (recommended)", "النسبة الحرجة (critical ratio)"),
  opt("EDD", "Earliest due date", "أقرب ميعاد تسليم (EDD)"),
  opt("SLACK", "Least slack", "أقل وقت فائض (slack)"),
  opt("SPT", "Shortest job first", "أقصر شغل الأول (SPT)"),
];
const WEEKS_AHEAD = [opt("2", "2 weeks", "الأسبوعين الجايين"), opt("4", "4 weeks", "الـ 4 أسابيع الجايين"), opt("8", "8 weeks", "الـ 8 أسابيع الجايين")];
const WEEKS_BACK = [opt("4", "Last 4 weeks", "آخر 4 أسابيع"), opt("8", "Last 8 weeks", "آخر 8 أسابيع")];
const IDEAS = [
  opt("cr", "Critical ratio and dispatch rules", "النسبة الحرجة (critical ratio) وقواعد ترتيب الشغل"),
  opt("load", "Load against capacity (CRP)", "الحمل مقابل الطاقة (CRP) ونسب الحمل"),
  opt("io", "Input/output control", "التحكم في الداخل والخارج (input/output control)"),
  opt("dbr", "The bottleneck and drum-buffer-rope", "الاختناق ونظرية القيود والطبلة والحاجز والحبل (DBR)"),
  opt("lead", "Lead time and queues", "زمن التصنيع وعناصره، وليه الانتظار هو الأكبر"),
  opt("release", "Releasing orders to the floor", "إطلاق الأوامر للأرضية (order release) وشروطه"),
  opt("split", "Overlapping and lot splitting", "التداخل بين العمليات (overlapping) وتقسيم الدفعة (lot splitting)"),
  opt("schedule", "Backward and forward scheduling", "الجدولة العكسية والأمامية"),
];

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
  {
    id: "dispatch",
    label: "What to run next",
    hint: "A department's priority list, by critical ratio",
    confirmLabel: "Build the list",
    fields: [
      { name: "station", label: "Department", type: "select", defaultValue: "weld", options: STATIONS },
      { name: "rule", label: "Order by", type: "select", defaultValue: "CR", options: RULES },
    ],
  },
  {
    id: "load",
    label: "Load vs capacity",
    hint: "Overloaded weeks per department, and the fix",
    confirmLabel: "Check the load",
    fields: [{ name: "weeks", label: "Over", type: "select", defaultValue: "4", options: WEEKS_AHEAD }],
  },
  { id: "bottleneck", label: "Find the bottleneck", hint: "The department that sets the pace, with the evidence", fields: [] },
  {
    id: "rush",
    label: "Can we take this order?",
    hint: "A new order against the plan — its date, who it pushes",
    confirmLabel: "Check it",
    fields: [
      { name: "kva", label: "Rating (kVA)", type: "text", required: true, placeholder: "e.g. 1000" },
      { name: "qty", label: "Quantity", type: "text", required: true, placeholder: "e.g. 20" },
      { name: "by", label: "Wanted by", type: "date", required: true },
    ],
  },
  {
    id: "late",
    label: "Why is this order late?",
    hint: "Where it waits, its priority, and what to do",
    confirmLabel: "Trace it",
    fields: [{ name: "mo", label: "Order (MO)", type: "text", required: true, placeholder: "e.g. MO/12345" }],
  },
  {
    id: "release",
    label: "Ready to release?",
    hint: "Nesting, material and capacity before the floor",
    confirmLabel: "Check it",
    fields: [{ name: "mo", label: "Order (MO)", type: "text", required: true, placeholder: "e.g. MO/12345" }],
  },
  {
    id: "io",
    label: "Input / output",
    hint: "Upstream or inside — where a department loses",
    confirmLabel: "Read it",
    fields: [
      { name: "station", label: "Department", type: "select", defaultValue: "weld", options: STATIONS },
      { name: "weeks", label: "Over", type: "select", defaultValue: "4", options: WEEKS_BACK },
    ],
  },
  {
    id: "learn",
    label: "Explain a planning idea",
    hint: "In plain words, with our plant's numbers",
    confirmLabel: "Explain",
    fields: [{ name: "idea", label: "Idea", type: "select", defaultValue: "cr", options: IDEAS }],
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
    case "dispatch": {
      const station = arOf(STATIONS, v.station) || arOf(STATIONS, "weld");
      const rule = arOf(RULES, v.rule) || arOf(RULES, "CR");
      return `${station} يشتغل على إيه دلوقتي؟ رتّبلي قائمة الأولويات بـ ${rule}.\nوضّح لكل أوردر الحسبة وحالته (متأخر / ورا / في الميعاد / قدام)، الأوردرات اللي لازم تتقدّم، واللي شغّال على ماكينة ومينفعش يتقطع.`;
    }
    case "load":
      return `الحمل على كل قسم مقابل طاقته في ${arOf(WEEKS_AHEAD, v.weeks) || arOf(WEEKS_AHEAD, "4")}، أسبوع بأسبوع.\nفين الأسابيع اللي فيها حمل زيادة، والحسبة، وإيه الحلول بالترتيب (نقل الشغل، طاقة إضافية، تقليل الحمل)، ومين محتاج يوافق؟`;
    case "bottleneck":
      return "مين الاختناق (bottleneck) في المصنع دلوقتي؟ وريني الأدلة بالأرقام (أيام الشغل المفتوح، الطابور قدامه، الحمل، التوقفات)، وإزاي نستغله ونخلي باقي الأقسام تمشي على سرعته.";
    case "rush": {
      const kva = clean(v.kva, 20);
      const qty = clean(v.qty, 10);
      if (!kva || !/^\d+$/.test(qty) || Number(qty) < 1 || !isoDay(v.by)) return null;
      return `ينفع ناخد أوردر جديد ${qty} محول ${kva} kVA ونسلّمه قبل ${v.by}؟\nوريني التاريخ المتوقع لو دخل بترتيب ميعاده ولو اتقدّم لأول الطابور، والأوردرات اللي هتتأخر بسببه، ومين لازم يوافق.`;
    }
    case "late": {
      const mo = clean(v.mo, 60);
      if (!mo) return null;
      return `ليه الأوردر ${mo} متأخر أو معرّض للتأخير؟\nتتبّعه قسم بقسم: فين واقف، النسبة الحرجة بتاعته، الحمل والطابور في القسم ده، والأسباب المسجلة — وإيه اللي نعمله دلوقتي.`;
    }
    case "release": {
      const mo = clean(v.mo, 60);
      if (!mo) return null;
      return `ينفع نطلق الأوردر ${mo} للأرضية دلوقتي؟\nراجع شروط الإطلاق: الـ hold، الكمية، الأزمنة المعيارية، الـ nesting، الخامة، والحمل على الـ Fabrication — وقولّي جاهز ولا لأ، وإيه اللي ناقص.`;
    }
    case "io": {
      const station = arOf(STATIONS, v.station) || arOf(STATIONS, "weld");
      return `اعملي تقرير الداخل والخارج (input/output) لـ ${station} عن ${arOf(WEEKS_BACK, v.weeks) || arOf(WEEKS_BACK, "4")}.\nالمشكلة جاية من القسم اللي قبله ولا من جوه القسم؟ والطابور قدامه بيزيد ولا بيقل؟`;
    }
    case "learn":
      return `اشرحلي ${arOf(IDEAS, v.idea) || arOf(IDEAS, "cr")} بكلام بسيط، بمثال بأرقام من أقسام المصنع عندنا، وفي الآخر إزاي بنستخدمه في البرنامج وإيه اللي المفروض أعمله دلوقتي.`;
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
