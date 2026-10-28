import { ITEMS, type Item } from "@/lib/domain/constants";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import type { LvTrackerRow } from "@/lib/server/lvTracker";
import type { TrackerFilters } from "@/lib/domain/trackerSummary";

// Synthetic factory, not a copy of live orders. Expected answers below are
// fixed reference figures, never calculated by the function being evaluated.
const hold = (onHold = false) => ({ onHold, holdNote: onHold ? "Waiting for engineering" : null, holdSinceISO: onHold ? "2026-10-20" : null, holdBy: onHold ? "Planner" : null });
function transformer(mo: string, required: number, complete: number, overrides: Partial<MasterTrackerRow> = {}): MasterTrackerRow {
  return {
    mo, bom: `BOM-${mo}`, soi: `SOI-${mo}`, customer: "SEC", urgent: false, kva: "1000", rating: null,
    fins: null, crcSize: null, colorRal: null, sfm: null, required, complete, remaining: required - complete,
    welded: complete, achievement: complete / required, status: "open", hold: hold(), priority: false,
    months: ["October 2026"], pendingQty: null,
    items: Object.fromEntries(ITEMS.map((it) => [it, { cut: complete, weld: complete, paint: complete, shp: complete, delivered: 0, osp: 0, excluded: false, eligible: !["AR", "MB"].includes(it) }])) as MasterTrackerRow["items"],
    ...overrides,
  };
}
const first = transformer("MO-A", 10, 5, { urgent: true, months: ["September 2026", "October 2026"] });
first.items.CF = { ...first.items.CF, cut: 8, weld: 6, shp: 4, paint: 0, osp: 2 };
first.items.TC = { ...first.items.TC, cut: 10, weld: 7 };
first.items.TN = { ...first.items.TN, cut: 10, weld: 8 };
first.items.CB = { ...first.items.CB, excluded: true };
export const TRANSFORMERS: MasterTrackerRow[] = [
  first,
  transformer("MO-B", 20, 20, { status: "closed", months: ["September 2026"] }),
  transformer("MO-C", 30, 0, { hold: hold(true) }),
  transformer("MO-E", 5, 0, { months: [] }),
];
const outside = transformer("MO-OUTSIDE", 10, 10, { months: ["November 2026"] });
for (const item of ITEMS) outside.items[item] = { ...outside.items[item], cut: 0, weld: 0, paint: 0, shp: 0, osp: 10 };
export const OUTSOURCED = [outside];

function panel(mo: string, required: number, paint: number, overrides: Partial<LvTrackerRow> = {}): LvTrackerRow {
  return { mo, bom: `PANEL-${mo}`, soi: null, customer: "SEC", urgent: false, product: "LSS", family: "",
    fgCode: `FG-${mo}`, secItem: "SEC-PNL", ospEncloser: 0, remarks: null, materialsRemarks: null,
    state: { required, punch: required, bend: required, weld: required, paint, delivered: 0 },
    complete: paint, remaining: required - paint, achievement: paint / required,
    status: "open", hold: hold(), priority: false, months: ["October 2026"], odooClosed: null, ...overrides };
}
export const PANELS: LvTrackerRow[] = [
  panel("LV-A", 10, 4, { product: "USS", urgent: true, state: { required: 10, punch: 10, bend: 8, weld: 6, paint: 4, delivered: 0 } }),
  panel("LV-B", 20, 20, { family: "MB", status: "closed", months: ["September 2026"] }),
  panel("LV-C", 30, 0, { hold: hold(true), state: { required: 30, punch: 0, bend: 0, weld: 0, paint: 0, delivered: 0 } }),
];

export interface PlanningCase {
  id: string; question: string; line: "TR" | "LV"; filters: TrackerFilters; outsourced?: boolean;
  expected: { orders: number; required: number; complete: number; remaining: number };
  cards?: { it: Item; need: number; done: number }[];
}
export const PLANNING_CASES: PlanningCase[] = [
  { id: "tr-all", question: "لخص كل أوامر المحولات: كام أمر والمطلوب والمكتمل والمتبقي؟", line: "TR", filters: { status: "all" }, expected: { orders: 4, required: 65, complete: 25, remaining: 40 }, cards: [{ it: "CF", need: 63, done: 24 }, { it: "CB", need: 55, done: 20 }, { it: "AR", need: 0, done: 0 }] },
  { id: "lv-default", question: "لخص أوامر لوحات LV المفتوحة في التراكر: عدد الأوامر والمطلوب والمدهون والمتبقي؟", line: "LV", filters: {}, expected: { orders: 2, required: 40, complete: 4, remaining: 36 } },
  { id: "tr-outsourced", question: "لخص أوامر المحولات المصنّعة بالكامل بره: المطلوب والمكتمل والمتبقي؟", line: "TR", outsourced: true, filters: {}, expected: { orders: 1, required: 10, complete: 10, remaining: 0 }, cards: [{ it: "CF", need: 0, done: 0 }, { it: "TN", need: 0, done: 0 }] },
  { id: "tr-october", question: "لخص خطة October 2026 للمحولات فقط.", line: "TR", filters: { month: "October 2026" }, expected: { orders: 2, required: 40, complete: 5, remaining: 35 } },
  { id: "tr-carryover", question: "لخص خطة September 2026 مع الأمر المرحّل بين شهرين من غير ما تعدّه مرتين.", line: "TR", filters: { month: "September 2026", status: "all" }, expected: { orders: 2, required: 30, complete: 25, remaining: 5 } },
  { id: "tr-search", question: "لخص MO-A فقط في المحولات.", line: "TR", filters: { q: "MO-A" }, expected: { orders: 1, required: 10, complete: 5, remaining: 5 } },
  { id: "tr-open", question: "لخص أوامر المحولات المفتوحة فقط.", line: "TR", filters: { status: "open" }, expected: { orders: 3, required: 45, complete: 5, remaining: 40 } },
  { id: "tr-held", question: "إيه إجمالي المحولات المتوقفة على Hold؟", line: "TR", filters: { status: "hold" }, expected: { orders: 1, required: 30, complete: 0, remaining: 30 } },
  { id: "tr-notstarted", question: "لخص المحولات اللي شغلها لسه ما بدأش.", line: "TR", filters: { progress: "notstarted" }, expected: { orders: 2, required: 35, complete: 0, remaining: 35 } },
  { id: "tr-finished", question: "لخص أوامر المحولات المكتملة تصنيعًا.", line: "TR", filters: { progress: "complete", status: "all" }, expected: { orders: 1, required: 20, complete: 20, remaining: 0 } },
  { id: "tr-urgent-weld", question: "لخص أوامر المحولات العاجلة، وكروت قسم اللحام.", line: "TR", filters: { urgent: "yes", deptStage: "Welding" }, expected: { orders: 1, required: 10, complete: 5, remaining: 5 }, cards: [{ it: "CF", need: 8, done: 6 }, { it: "TC", need: 10, done: 7 }] },
  { id: "tr-no-month", question: "كام أمر محولات مش مربوط بأي شهر خطة؟", line: "TR", filters: { month: "—" }, expected: { orders: 1, required: 5, complete: 0, remaining: 5 } },
  { id: "empty", question: "لخص الأوامر المطابقة لبحث NO-MATCH، ومتخمنش أرقام لو مفيش نتائج.", line: "TR", filters: { q: "NO-MATCH" }, expected: { orders: 0, required: 0, complete: 0, remaining: 0 } },
  { id: "lv-all", question: "لخص كل لوحات LV، المفتوحة والمقفولة مع بعض.", line: "LV", filters: { status: "all" }, expected: { orders: 3, required: 60, complete: 24, remaining: 36 } },
  { id: "lv-product", question: "لخص لوحات USS المفتوحة فقط.", line: "LV", filters: { product: "USS" }, expected: { orders: 1, required: 10, complete: 4, remaining: 6 } },
  { id: "lv-meter-boxes", question: "لخص كل أوامر Meter boxes بما فيها المقفولة.", line: "LV", filters: { family: "MB", status: "all" }, expected: { orders: 1, required: 20, complete: 20, remaining: 0 } },
  { id: "lv-partial", question: "لخص لوحات LV اللي تصنيعها بدأ ولسه مخلصش.", line: "LV", filters: { progress: "partial" }, expected: { orders: 1, required: 10, complete: 4, remaining: 6 } },
  { id: "lv-noturgent", question: "لخص أوامر LV المفتوحة غير العاجلة.", line: "LV", filters: { urgent: "no" }, expected: { orders: 1, required: 30, complete: 0, remaining: 30 } },
];
