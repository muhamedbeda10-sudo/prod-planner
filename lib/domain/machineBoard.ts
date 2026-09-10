import { round1 } from "@/lib/domain/shifts";

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

/** One open worklist line, as the board needs it. */
export interface BoardLine {
  /** bom|mo|item — the assignment's key. */
  key: string;
  bom: string;
  mo: string;
  item: string;
  description: string;
  remaining: number; // pieces this dept still owes on the line
  /** Standard hours the remaining pieces cost this stage; null = no class known. */
  hours: number | null;
  deliveryISO: string | null;
}

export interface Assignment {
  key: string;
  machineId: number;
  rank: number;
  /** Running on the machine now; several can be. Absent = not running. */
  running?: boolean;
}

export interface MachineQueueLine extends BoardLine {
  /** Position in the machine's queue: the running lines first, then the waiting ones. */
  rank: number;
  running: boolean;
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
}

export interface MachineBoard {
  cards: MachineCard[];
  /** Open lines on no machine yet, most urgent first. */
  unassigned: BoardLine[];
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
  today: { downtimeH?: Record<number, number>; crewH?: Record<number, number>; crew?: Record<number, string[]> } = {}
): MachineBoard {
  const open = new Map<string, BoardLine>();
  // a line with nothing left is off the board however it was assigned;
  // the same key twice (two tranches of one line) is one line
  for (const l of lines) {
    if (!(l.remaining > 0)) continue;
    const prev = open.get(l.key);
    if (!prev) open.set(l.key, { ...l });
    else {
      prev.remaining += l.remaining;
      prev.hours = prev.hours === null || l.hours === null ? null : prev.hours + l.hours;
      if (l.deliveryISO && (!prev.deliveryISO || l.deliveryISO < prev.deliveryISO)) prev.deliveryISO = l.deliveryISO;
    }
  }

  const byMachine = new Map<number, MachineQueueLine[]>();
  const placed = new Set<string>();
  // running lines first, then the waiting ones, each group in rank order
  const ordered = [...assignments].sort((x, y) => Number(!!y.running) - Number(!!x.running) || x.rank - y.rank);
  for (const a of ordered) {
    const l = open.get(a.key);
    if (!l || placed.has(a.key)) continue;
    placed.add(a.key);
    if (!byMachine.has(a.machineId)) byMachine.set(a.machineId, []);
    byMachine.get(a.machineId)!.push({ ...l, rank: 0, running: !!a.running });
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
      pcs: queue.reduce((s, l) => s + l.remaining, 0),
      hours,
      unpricedPcs: queue.filter((l) => l.hours === null).reduce((s, l) => s + l.remaining, 0),
      downtimeH,
      crewH: today.crewH?.[m.id] ?? 0,
      crew: today.crew?.[m.id] ?? [],
      availableH,
      load: availableH === null ? null : availableH > 0 ? Math.round((hours / availableH) * 100) / 100 : hours > 0 ? Infinity : 0,
      days: availableH === null ? null : availableH > 0 ? round1(hours / availableH) : null,
    };
  });

  const unassigned = [...open.values()].filter((l) => !placed.has(l.key)).sort(urgencyOrder);
  return { cards, unassigned, totalHours: round1(totalHours), totalAvailableH: totalAvailableH === null ? null : round1(totalAvailableH) };
}

/** The tone a load reads in: fine to a full day, amber past it, red past a
 *  day and a half. */
export function loadTone(load: number | null): "ok" | "warn" | "bad" | null {
  if (load === null) return null;
  return load > 1.5 ? "bad" : load > 1 ? "warn" : "ok";
}

export const lineKey = (bom: string, mo: string, item: string) => `${bom}|${mo}|${item}`;
