// "What's new" — what changed in the app, newest first, so nobody has to
// stumble on a new button. Add an entry at the TOP with every change people
// will notice; the button in the bar counts the entries a person has not
// opened the list on yet.

export interface WhatsNewEntry {
  /** Unique and never reused — the newest one a person has seen is kept on their account. */
  id: string;
  dateISO: string;
  title: string;
  /** Where it lives in the app, e.g. "Worklist → Cut → machines". */
  where: string;
  body: string;
  href?: string;
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-12-account-menu",
    dateISO: "2026-10-12",
    title: "Your photo in the bar — and everything about your account behind it",
    where: "The bar → the round button at its end",
    body: "Your name, sign-out, dark mode and this ✨ What's new list now sit behind one round button at the end of the bar. Click it and choose Add your photo — the picture is cropped to a circle for you; until then the button shows your initials. The line switch beside it is now a small TR / LV.",
  },
  {
    id: "2026-10-12-cascade-heads-editable",
    dateISO: "2026-10-12",
    title: "A group's head row is edited like the rows under it",
    where: "Material · ODOO log · Plan Tracker · LV tracker",
    body: "Material: an SOI's head row takes MTR #, SOI, MO, BOM, units, utilization and quantity typed straight into it, written to every line of the SOI; its ⋯ menu edits or deletes all its lines at once. An SOI of a single line shows that line alone. ODOO: a merged line keeps notes like a row and has its own ⋯ menu — edit SOI, product, MO and status for all its rows, or delete them. Plan Tracker and LV tracker: a merged BOM row closes its finished MOs and reopens closed ones, and on the Plan Tracker flags them all as priority.",
    href: "/material",
  },
  {
    id: "2026-10-12-order-page-links",
    dateISO: "2026-10-12",
    title: "Open an order's page from the ODOO and Material tabs",
    where: "ODOO → BOM · Material → BOM · the order's page",
    body: "The BOM on an ODOO row and on a Material line is now a link to that order's page — its stages, components, Odoo closings and every record. The page's records now show the newest first, say which MO each record belongs to, and drop the plan column; the long captions under its cards are gone.",
    href: "/odoo",
  },
  {
    id: "2026-10-12-odoo-order-material",
    dateISO: "2026-10-12",
    title: "ODOO log: a row closed under another MO of its order is no longer red",
    where: "ODOO → the log's colours",
    body: "Odoo often closes a part under a different MO of the order than the one the Material tab names — the Top Cover of S01328-35 is nested under SF01/MO/20227 and closed under SF01/MO/20218. Such a row used to stay red although its material was recorded; it now takes its colour from its order's lines of the same part, the same lines the 🧱 popup shows. Another order's lines never colour it.",
    href: "/odoo",
  },
  {
    id: "2026-10-12-floor-sheet-line",
    dateISO: "2026-10-12",
    title: "Floor: each sheet of an item is named, and goes on a machine as that sheet",
    where: "Floor → Cut → ▸ to place · a machine's block and queue",
    body: "Picking one sheet of an item from a machine's ＋ Put a line on it… list — its 5 mm, say, while its 3 mm is on another laser — put the WHOLE item on that machine. It now goes on as that sheet only, as the → button in the \"to place\" list always did; a whole item already placed this way stays whole until it is taken off and the sheet placed again. The Floor now also names the sheet of each line — 3 mm MS 1220×2440 — waiting in both lists, on a machine's block and in its queue, so two sheets of one item, or two lasers on the same item, no longer look alike.",
    href: "/simulate?view=floor&dept=Cut",
  },
  {
    id: "2026-10-11-phones-tablets",
    dateISO: "2026-10-11",
    title: "Tidier on phones and tablets — and less text everywhere",
    where: "Every page · the AI assistant",
    body: "Nothing runs off the side of a phone any more: the bar keeps its buttons on screen (dark/light mode moved into the ☰ menu), cards and charts fit the width, and the line under each page title is hidden on a phone. The AI chat keeps its chats in a drawer on phones and tablets, with a bigger box to type in. The long explanations on the AI settings, Users & Permissions, Settings and the dashboards' cards were cut to the labels — hover one to read more.",
  },
  {
    id: "2026-10-11-odoo-compare",
    dateISO: "2026-10-11",
    title: "ODOO dashboard: choose what to compare with",
    where: "ODOO → Dashboard → Compare with",
    body: "The ▲▼ changes on the dashboard can now compare the period with the days just before it (as before), the same days last month, last week or last year — e.g. 1–11 Oct against 1–11 Sep — or with nothing.",
    href: "/odoo?view=dashboard",
  },
  {
    id: "2026-10-11-odoo-backorder-mo",
    dateISO: "2026-10-11",
    title: "ODOO log: a backorder MO (…-002) reads its parent's material",
    where: "ODOO → the log's colours · 🧱 material",
    body: "An Odoo MO closed as a backorder — SF01/MO/15337-002 — used to show red although the nesting was filed on the Material tab under SF01/MO/15337. It now reads the lines of the MO it came from (or of a sibling backorder), so the colour and the 🧱 figures follow the job.",
    href: "/odoo",
  },
  {
    id: "2026-10-10-ai-assistant",
    dateISO: "2026-10-10",
    title: "AI assistant — ask about the plant in your own words",
    where: "The 🤖 button in the bar (for the people the owner opens it to)",
    body: "Ask in Arabic or English — late orders, yesterday's output, the load on a machine, what is waiting in Odoo — and Claude answers from the app's live data, read-only, with tables, charts, headline figures and suggestions. Your chats are kept on the side to come back to. The owner decides who may use it and each person's monthly limit (AI assistant settings, or Users & Permissions).",
    href: "/ai",
  },
  {
    id: "2026-10-08-nested-zero",
    dateISO: "2026-10-08",
    title: "A nested 0 counts as 0 — only a blank is \"not nested\"",
    where: "ODOO → 🧱 material · Material tab",
    body: "A line whose actual nested sheets are written as 0 is now booked as 0 everywhere; only an empty box means \"not nested yet\" and falls back to the BOM figure. The 🧱 button on an ODOO row used to show the BOM total when the actual came to 0 — it now shows the real figure to book.",
    href: "/odoo",
  },
  {
    id: "2026-10-08-odoo-mo-material",
    dateISO: "2026-10-08",
    title: "ODOO log: rows coloured by their MO on the Material tab",
    where: "ODOO → the log",
    body: "A row whose Odoo MO has no nesting filed under it on the Material tab is tinted red; one whose MO is there but has lines with no actual nested sheets yet is tinted yellow; one whose every line is nested is tinted green. A merged line reads its MO the same way, and clicking a merged line opens the material behind its total.",
    href: "/odoo",
  },
  {
    id: "2026-10-08-run-move",
    dateISO: "2026-10-08",
    title: "Move a nest run to another laser · record it in sheets",
    where: "Cut worklist → ✎ Edit run · the run's line on the card",
    body: "Editing a run now has its laser: pick another and the run moves there, at the back of its queue — even with some of its sheets already cut. On the card, a run's ✓ box is a sheets counter (Sheets [ ] / left), so nobody types pieces into it.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-run-details",
    dateISO: "2026-10-07",
    title: "Nest run details in one click",
    where: "Cut worklist → a run on a machine card",
    body: "A run on a machine now reads at a glance — its sheet, sheets cut of all with a bar, time left and the jobs on it. Click it for everything: sheets and pieces cut, the cutting time, sheet by sheet (cut, next, waiting, each with its minutes) and every job with its pieces cut and left. Every open job also shows in the run's job list now, not only the ones on today's worklist, and the search finds parts by name (Tank) and by MO.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-run-any-job",
    dateISO: "2026-10-07",
    title: "Any open job on a nest run — one sheet in place of another",
    where: "Cut worklist → 🧩 Nest run",
    body: "The job list now shows every open job: the ones whose nesting uses the run's sheet first, then the rest marked \"other sheet\". A job cut from a sheet in place of its own (a 4 mm instead of its 3 mm) says which of its sheets it stands in for — picked for you when it has only one — so the item still counts as cut on every sheet.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-run-edit",
    dateISO: "2026-10-07",
    title: "Edit a nest run",
    where: "Cut worklist → ✎ on the run's card line · 📋 Runs → ✎ Edit",
    body: "A run opens again in its form. Before any of its sheets is cut, everything changes — the sheet, how many, the time, the jobs on it. Once sheets are cut, what was cut stays: the number of sheets (never below those cut), the time and the note still change.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-run-time",
    dateISO: "2026-10-07",
    title: "Nest runs: cutting time, and jobs picked by BOM",
    where: "Cut worklist → 🧩 Nest run",
    body: "A run now takes its cutting time: identical sheets need one sheet's minutes, different sheets each their own — the machine's load is worked out from it. Jobs are picked from a searchable table by BOM ref, item, the plan's Required for the BOM, material and the nesting's No. of sheets (the orders of a BOM go together). The cutting worklist's Machine column is gone — lines go on the lasers from the board.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-nest-runs",
    dateISO: "2026-10-07",
    title: "Nest runs — one sheet, parts of several jobs",
    where: "Cut worklist → machines board → 🧩 Nest run · 📋 Runs",
    body: "Put sheets of one material and thickness on a laser as one run — e.g. 5 sheets of 3 mm MS — and say what the nesting put on them: the parts of each job with their pieces (the list offers only the open lines whose nesting uses that sheet, with a check against the sheets the nesting expects). The technician records the run by the sheets finished; each job's pieces follow, and once all of an item's sheets are cut it shows under ✅ ready to record.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-ready-cut",
    dateISO: "2026-10-07",
    title: "Whole pieces recorded in one click",
    where: "Cut worklist → machines board → ✅ Cut on every sheet",
    body: "When an item is cut by sheet on several machines, the board watches every sheet: once all of them are cut for some pieces, it lists them as whole and one click records them as cut. Every sheet's ✓ is also kept in a log — which thickness each machine cut, for which item — to plan the machines from later.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-sheet-split",
    dateISO: "2026-10-07",
    title: "One item on several machines — each on its own sheet",
    where: "Cut worklist → the machine picker",
    body: "Picking a cutting machine for an item cut from more than one sheet asks which sheet that machine cuts (from the BOM's nesting on the Material tab) and how many pieces. Pick another machine for the next sheet: the same item runs on several machines at once, the same or different quantities. ✓ on a sheet's card line counts that sheet's cutting.",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-machine-sheets",
    dateISO: "2026-10-07",
    title: "Sheets and thickness on every machine line",
    where: "Worklist → machines board · 🖨 machine sheets",
    body: "Each line on a machine now shows the sheet it is cut from — thickness, material and sheet size — and, on the cutting machines, how many sheets its pieces take (from the Material tab's nesting; * = BOM rate, not nested yet). The printed sheet carries it too, with the sheets the whole queue needs per thickness.",
    href: "/worklist/machines?dept=Cut",
  },
  {
    id: "2026-10-07-manual-jobs",
    dateISO: "2026-10-07",
    title: "Jobs from outside the plan, on any machine",
    where: "Worklist → machines board → ✋ Add job · 📋 Manual jobs",
    body: "A repair, a sample, a spare part — anything not in the plan can be put on a machine with its pieces and sheet. It queues and prints like a plan line, ✓ records what was done on the job itself, and every job is kept in the Manual jobs list to come back to (put it on a machine again, or ↺ open it for more pieces).",
    href: "/worklist/cut",
  },
  {
    id: "2026-10-07-meter-boxes",
    dateISO: "2026-10-07",
    title: "Meter boxes in the LV plan",
    where: "LV Panels → Orders (import) · Plan Tracker",
    body: "The meter boxes' monthly sheet imports beside the panels' — pick Plan: Meter boxes on the import. Each plan is revised on its own, so one never takes the other's orders off the month. The LV tracker has a Plan filter to see panels or meter boxes alone.",
    href: "/tracker",
  },
  {
    id: "2026-10-06-consumables-summary",
    dateISO: "2026-10-06",
    title: "Consumables summary in a popup",
    where: "Consumables → Summary",
    body: "The handout summary — totals, by item and by department — opens from a button, so the log keeps the whole page.",
    href: "/consumables",
  },
  {
    id: "2026-10-06-physical-material",
    dateISO: "2026-10-06",
    title: "Physical Material tab",
    where: "Physical Material",
    body: "The store's counted stock per material code, editable in place — code, name and unit included.",
    href: "/physical",
  },
  {
    id: "2026-10-06-screens-per-account",
    dateISO: "2026-10-06",
    title: "Screens per account · Shifts always on",
    where: "Users & Permissions · Shifts",
    body: "The owner can hide tabs a person does not need. Shifts (attendance and the shift log) now always shows, machine planning or not.",
    href: "/shifts",
  },
];

/** How many entries are newer than the one a person last saw. Nothing seen
 *  yet counts the latest few, not the whole history. */
export function unseenCount(seenId: string | null | undefined, entries: readonly WhatsNewEntry[] = WHATS_NEW): number {
  if (!seenId) return Math.min(3, entries.length);
  const i = entries.findIndex((e) => e.id === seenId);
  return i < 0 ? Math.min(3, entries.length) : i;
}
