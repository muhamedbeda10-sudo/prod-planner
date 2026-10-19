import { round1 } from "@/lib/domain/shifts";
import { LV_ITEM } from "@/lib/domain/lv";
import { MANUAL_BOM, MANUAL_ITEM, roundSheets } from "@/lib/domain/manualJob";

// The machine load board — pure. The worklist's open lines, each on the
// machine the planner put it on, in the order he ranked them, priced in
// standard hours against what the machine has today. The server gathers
// the lines, the machines, today's downtime and crew; this module lays
// them out so the page can say "B4-10 is on this now, then these, and it
// is loaded to 130% of its day".

export interface BoardMachine {
  id: number;
  code: string;
  name: string;
  center: string;
  hoursPerDay: number | null;
  active: boolean;
}

/** One step of a line's route: a work centre it owes work at, and the hours
 *  the remaining pieces cost THERE. */
export interface BoardStep {
  center: string;
  /** Standard hours the remaining pieces cost this centre; null = no class known. */
  hours: number | null;
}

/** One open worklist line, as the board needs it. */
export interface BoardLine {
  /** bom|mo|item — the assignment's key. */
  key: string;
  bom: string;
  mo: string;
  item: string;
  description: string;
  remaining: number; // pieces this dept still owes on the line
  /** Standard hours the remaining pieces cost this stage — all its centres
   *  together; null = no class known. */
  hours: number | null;
  deliveryISO: string | null;
  /** When THIS stage has to be finished (the delivery less its lead) — what a
   *  block on the timeline is late against. Null = no date. */
  dueISO?: string | null;
  /** The centres the piece passes here, in order, each with its hours. Outside
   *  fabrication that is the department's one centre; a tank owes cutting,
   *  then bending, then fins — and the board queues it at each. */
  route: readonly BoardStep[];
  /** The sheets the item is cut from ("<thk>|<material>|<size>"), when it is
   *  spread over machines by sheet — what still needs a machine is then
   *  counted sheet by sheet. */
  sheets?: readonly string[];
}

export interface Assignment {
  key: string;
  machineId: number;
  rank: number;
  /** Running on the machine now; several can be. Absent = not running. */
  running?: boolean;
  /** Pieces of the line on this machine; null/absent = whatever the other
   *  machines do not take. A line split over machines has one assignment each. */
  qty?: number | null;
  /** The sheet of the item this machine cuts; "" / absent = the whole item. */
  sheet?: string;
  /** Pieces' worth of that sheet already cut here. */
  sheetDone?: number;
}

export interface MachineQueueLine extends BoardLine {
  /** Position in the machine's queue: the running lines first, then the waiting ones. */
  rank: number;
  running: boolean;
  /** The line's whole remaining quantity; `remaining` is the share on this machine. */
  lineRemaining: number;
  /** Part of the line, not all of it — the rest sits elsewhere or waits unassigned. */
  split: boolean;
  /** The machine's work centre — the step of the route this queue line is. */
  center: string;
  /** The step of the route this machine stands in for (its own centre, or the
   *  route's first when the machine is off-route — a tube laser cutting). */
  step: string;
  /** Which step of the route this is, and how many there are: "bending, 2 of 3". */
  stepNo: number;
  stepCount: number;
  /** The sheet of the item this line is ("" = the whole item). */
  sheet: string;
  /** Pieces' worth of that sheet cut here so far; `remaining` is what is left of it. */
  sheetDone: number;
}

export interface MachineCard {
  machine: BoardMachine;
  /** The queue: the running lines first (in rank order), then the waiting ones. */
  queue: MachineQueueLine[];
  /** What the machine is on now — one line, or several worked together. */
  running: MachineQueueLine[];
  /** The waiting lines, in the order they will be run. */
  waiting: MachineQueueLine[];
  /** The first running line, for the one-line summaries. */
  now: MachineQueueLine | null;
  pcs: number;
  hours: number; // std-hours of the whole queue
  unpricedPcs: number; // pieces of lines with no class (hours undercounted)
  downtimeH: number;
  crewH: number; // man-hours the shift log put on this machine today
  /** Who the shift log put on it today. */
  crew: string[];
  /** Hours the machine has today: hours/day less downtime; null with no figure. */
  availableH: number | null;
  /** hours / availableH, null while either is unknown. */
  load: number | null;
  /** Working days the queue is worth at today's available hours. */
  days: number | null;
  /** The working day the queue is finished on, filled in by the server (it
   *  knows the calendar); null while the machine has no hours figure. */
  clearsISO?: string | null;
}

/** A line, or the part of one, that no machine has yet — at ONE centre of its
 *  route: a tank whose cutting is placed but whose bending is not shows here
 *  as its bending. */
export interface UnassignedLine extends BoardLine {
  /** The line's whole remaining quantity when only part of it is unassigned. */
  lineRemaining: number;
  partial: boolean;
  /** The centre the pieces still need. */
  center: string;
  stepNo: number;
  stepCount: number;
  /** The sheet still to place, when the item is spread by sheet. */
  sheet?: string;
}

/** Where a line sits, for the tables' pickers: its first machine (a running
 *  one first), the pieces there when split, and how many more machines hold
 *  a share of it. */
export interface LinePlacement {
  machineId: number;
  rank: number;
  running: boolean;
  /** Pieces on that machine. */
  qty: number;
  /** Only part of the line is on it. */
  split: boolean;
  /** Other machines sharing the SAME step of the route (a split). */
  others: number;
  /** The further centres of the route and where they are queued — a tank cut
   *  on B4-10 goes on to the bender and the fins line. */
  next?: { center: string; machineId: number; code: string; rank: number; running: boolean }[];
  /** Centres of the route with nothing placed yet. */
  missing?: string[];
}

export interface MachineBoard {
  cards: MachineCard[];
  /** Open lines (or the leftover part of split ones) on no machine yet, most urgent first. */
  unassigned: UnassignedLine[];
  totalHours: number;
  totalAvailableH: number | null;
}

/** Lines sorted the way the floor reads urgency: earliest delivery first,
 *  date-less last, then by BOM. */
export function urgencyOrder(a: BoardLine, b: BoardLine): number {
  if (a.deliveryISO && b.deliveryISO && a.deliveryISO !== b.deliveryISO) return a.deliveryISO < b.deliveryISO ? -1 : 1;
  if (a.deliveryISO && !b.deliveryISO) return -1;
  if (!a.deliveryISO && b.deliveryISO) return 1;
  return a.bom.localeCompare(b.bom) || a.mo.localeCompare(b.mo) || a.item.localeCompare(b.item);
}

export function buildMachineBoard(
  machines: readonly BoardMachine[],
  lines: readonly BoardLine[],
  assignments: readonly Assignment[],
  today: { downtimeH?: Record<number, number>; crewH?: Record<number, number>; crew?: Record<number, string[]> } = {},
  /** machine id → item → hours ONE piece costs THAT machine. The planner's own
   *  figure: where it is set it outranks the estimate for that machine's queue. */
  rates: Record<number, Record<string, number>> = {}
): MachineBoard {
  const open = new Map<string, BoardLine>();
  // a line with nothing left is off the board however it was assigned;
  // the same key twice (two tranches of one line) is one line
  for (const l of lines) {
    if (!(l.remaining > 0)) continue;
    const prev = open.get(l.key);
    if (!prev) open.set(l.key, { ...l, route: l.route.map((r) => ({ ...r })) });
    else {
      prev.remaining += l.remaining;
      prev.hours = prev.hours === null || l.hours === null ? null : prev.hours + l.hours;
      const steps = prev.route as BoardStep[];
      for (const r of l.route) {
        const at = steps.find((x) => x.center === r.center);
        if (!at) steps.push({ ...r });
        else at.hours = at.hours === null || r.hours === null ? null : at.hours + r.hours;
      }
      if (l.deliveryISO && (!prev.deliveryISO || l.deliveryISO < prev.deliveryISO)) prev.deliveryISO = l.deliveryISO;
      if (l.dueISO && (!prev.dueISO || l.dueISO < prev.dueISO)) prev.dueISO = l.dueISO;
    }
  }

  const centerOf = new Map(machines.map((m) => [m.id, m.center]));
  /** The step of the route a machine stands in for: its own centre when the
   *  route names it, else the route's first — a tube laser or the roll-blank
   *  laser is doing that line's cutting, on another machine. */
  const stepFor = (l: BoardLine, machineId: number): string => {
    const c = centerOf.get(machineId) ?? "";
    return l.route.some((r) => r.center === c) ? c : l.route[0]?.center ?? c;
  };
  const stepHours = (l: BoardLine, step: string): number | null => l.route.find((r) => r.center === step)?.hours ?? l.route[0]?.hours ?? null;

  // a sheet job is counted to the hundredth of a sheet (2.5): what is left
  // of it is rounded so it never drifts (2.3 − 1.1 is 1.2, not 1.1999…); a
  // plan line's count stays exactly as it was
  const count = (l: BoardLine, n: number) => (l.bom === MANUAL_BOM ? roundSheets(n) : n);

  const byMachine = new Map<number, MachineQueueLine[]>();
  // pieces of each line already given to a machine, PER STEP of the route: a
  // tank owes its 12 pieces to cutting AND to bending AND to fins, so each
  // step fills up on its own. Explicit quantities are allocated first, then a
  // row with no quantity takes what is left of that step, and anything beyond
  // that waits unassigned. An item spread over machines BY SHEET fills each
  // sheet on its own too: its 3 mm on one laser and its 5 mm on another are
  // both the same 12 pieces. A whole-item row covers every sheet.
  const given = new Map<string, number>(); // key#step → pieces given whole
  const givenSheet = new Map<string, number>(); // key#step#sheet → pieces of that sheet
  const sheetsAt = new Map<string, Set<string>>(); // key#step → sheets placed
  const seen = new Set<string>();
  // running lines first, then the waiting ones, each group in rank order
  const ordered = [...assignments].sort((x, y) => Number(!!y.running) - Number(!!x.running) || x.rank - y.rank);
  const explicit = ordered.filter((a) => a.qty !== null && a.qty !== undefined);
  const open_ = ordered.filter((a) => a.qty === null || a.qty === undefined);
  const maxSheet = (pool: string) => Math.max(0, ...[...(sheetsAt.get(pool) ?? [])].map((sh) => givenSheet.get(`${pool}#${sh}`) ?? 0));
  const pending: { a: Assignment; pcs: number; step: string }[] = [];
  for (const a of [...explicit, ...open_]) {
    const l = open.get(a.key);
    const sheet = a.sheet ?? "";
    const pairKey = `${a.key}#${a.machineId}#${sheet}`;
    if (!l || seen.has(pairKey)) continue;
    seen.add(pairKey);
    const step = stepFor(l, a.machineId);
    const pool = `${a.key}#${step}`;
    const left = Math.max(0, count(l, l.remaining - (given.get(pool) ?? 0) - (sheet ? givenSheet.get(`${pool}#${sheet}`) ?? 0 : maxSheet(pool))));
    // a plan line's share is whole pieces; a sheet job's may be part of a sheet
    const pcs = a.qty !== null && a.qty !== undefined ? Math.min(Math.max(0, l.bom === MANUAL_BOM ? roundSheets(a.qty) : Math.floor(a.qty)), left) : left;
    if (pcs <= 0) continue;
    if (sheet) {
      givenSheet.set(`${pool}#${sheet}`, (givenSheet.get(`${pool}#${sheet}`) ?? 0) + pcs);
      (sheetsAt.get(pool) ?? sheetsAt.set(pool, new Set()).get(pool)!).add(sheet);
    } else given.set(pool, (given.get(pool) ?? 0) + pcs);
    pending.push({ a, pcs, step });
  }
  // back in queue order (the allocation walk above put explicit rows first)
  pending.sort((x, y) => ordered.indexOf(x.a) - ordered.indexOf(y.a));
  for (const { a, pcs, step } of pending) {
    const l = open.get(a.key)!;
    const sheet = a.sheet ?? "";
    // a sheet's pieces already cut here leave its queue; the share stays
    // counted, so the sheet does not come back as waiting for a machine
    const sheetDone = sheet ? Math.min(pcs, Math.max(0, Math.floor(a.sheetDone ?? 0))) : 0;
    const left = count(l, pcs - sheetDone);
    if (left <= 0) continue;
    if (!byMachine.has(a.machineId)) byMachine.set(a.machineId, []);
    const share = left / l.remaining;
    const h = stepHours(l, step);
    const own = rates[a.machineId]?.[l.item];
    const stepNo = Math.max(0, l.route.findIndex((r) => r.center === step)) + 1;
    byMachine.get(a.machineId)!.push({
      ...l,
      remaining: left,
      hours: own !== undefined ? round1(own * left) : h === null ? null : round1(h * share),
      rank: 0, running: !!a.running,
      lineRemaining: l.remaining,
      split: !!sheet || pcs < l.remaining,
      center: centerOf.get(a.machineId) ?? step,
      step,
      stepNo,
      stepCount: l.route.length,
      sheet,
      sheetDone,
    });
  }

  // a retired machine still shows while something sits on it
  const shown = machines.filter((m) => m.active || (byMachine.get(m.id)?.length ?? 0) > 0);
  let totalHours = 0;
  let totalAvailableH: number | null = 0;
  const cards: MachineCard[] = shown.map((m) => {
    const queue = (byMachine.get(m.id) ?? []).map((l, i) => ({ ...l, rank: i + 1 }));
    const hours = round1(queue.reduce((s, l) => s + (l.hours ?? 0), 0));
    const downtimeH = today.downtimeH?.[m.id] ?? 0;
    const availableH = m.hoursPerDay === null ? null : round1(Math.max(0, m.hoursPerDay - downtimeH));
    totalHours += hours;
    if (availableH === null || !m.active) {
      if (m.active) totalAvailableH = null;
    } else if (totalAvailableH !== null) totalAvailableH += availableH;
    const running = queue.filter((q) => q.running);
    return {
      machine: m,
      queue,
      running,
      waiting: queue.filter((q) => !q.running),
      now: running[0] ?? null,
      pcs: roundSheets(queue.reduce((s, l) => s + l.remaining, 0)),
      hours,
      unpricedPcs: roundSheets(queue.filter((l) => l.hours === null).reduce((s, l) => s + l.remaining, 0)),
      downtimeH,
      crewH: today.crewH?.[m.id] ?? 0,
      crew: today.crew?.[m.id] ?? [],
      availableH,
      load: availableH === null ? null : availableH > 0 ? Math.round((hours / availableH) * 100) / 100 : hours > 0 ? Infinity : 0,
      days: availableH === null ? null : availableH > 0 ? round1(hours / availableH) : null,
    };
  });

  // what still needs a machine, one row per step of the route that is short
  const unassigned: UnassignedLine[] = [];
  for (const l of open.values()) {
    l.route.forEach((r, i) => {
      const pool = `${l.key}#${r.center}`;
      const whole = given.get(pool) ?? 0;
      const push = (rawLeft: number, sheet?: string) => {
        const leftPcs = count(l, rawLeft);
        if (leftPcs <= 0) return;
        unassigned.push({
          ...l,
          remaining: leftPcs,
          hours: r.hours === null ? null : round1((r.hours * leftPcs) / l.remaining),
          lineRemaining: l.remaining,
          partial: leftPcs < l.remaining,
          center: r.center,
          stepNo: i + 1,
          stepCount: l.route.length,
          ...(sheet ? { sheet } : {}),
        });
      };
      // spread by sheet: what each sheet still needs; the sheets nobody has
      // started on wait as they are
      const placed = sheetsAt.get(pool);
      if (placed && placed.size > 0) {
        const all = [...new Set([...(l.sheets ?? []), ...placed])];
        for (const sh of all) push(l.remaining - whole - (givenSheet.get(`${pool}#${sh}`) ?? 0), sh);
        return;
      }
      push(l.remaining - whole);
    });
  }
  unassigned.sort((a, b) => urgencyOrder(a, b) || a.stepNo - b.stepNo);
  return { cards, unassigned, totalHours: round1(totalHours), totalAvailableH: totalAvailableH === null ? null : round1(totalAvailableH) };
}

/** How long a queue takes to work off, in words: the hours themselves while
 *  it is under a day's work, the days once it is more. A planner asks "how
 *  long", not "what percentage of today". */
export function clearWords(hours: number, availableH: number | null): string {
  const h = round1(hours);
  if (availableH === null || availableH <= 0) return `${h} h`;
  const d = round1(hours / availableH);
  if (d < 1) return `${h} h`;
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** The tone a load reads in: fine to a full day, amber past it, red past a
 *  day and a half. */
export function loadTone(load: number | null): "ok" | "warn" | "bad" | null {
  if (load === null) return null;
  return load > 1.5 ? "bad" : load > 1 ? "warn" : "ok";
}

export const lineKey = (bom: string, mo: string, item: string) => `${bom}|${mo}|${item}`;

/** What a department's machines take. The fabrication machines carry SHEET
 *  JOBS — sheets carrying the parts of several projects, typed on the board —
 *  and the panels' punching on the shared punches; a transformer plan line
 *  goes on them inside a job, never on its own. Every other bay takes its
 *  worklist's lines as they are. */
export function boardTakesLine(dept: string, bom: string, item: string): boolean {
  if (dept !== "Cut") return true;
  return (bom === MANUAL_BOM && item === MANUAL_ITEM) || item === LV_ITEM;
}

/** Why the fabrication machines refuse a plan line of its own. */
export const BOARD_LINE_REFUSED = "The fabrication machines carry sheet jobs — put this work on a ✋ job (its sheets and the parts on them) and queue the job.";

/** A waiting row's own key: its line, the centre the pieces still need, and
 *  its sheet — an item spread by sheet waits as one row PER SHEET at the
 *  same centre, so the line and the centre alone repeat. */
export const unassignedKey = (u: Pick<UnassignedLine, "key" | "center" | "sheet">) => `${u.key}#${u.center}#${u.sheet ?? ""}`;
