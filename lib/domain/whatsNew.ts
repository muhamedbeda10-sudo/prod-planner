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
