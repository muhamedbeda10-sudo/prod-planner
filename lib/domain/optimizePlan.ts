import { round1 } from "@/lib/domain/shifts";

// ⚡ The optimizer behind the worklists' "Plan the machines" button — pure.
//
// It answers the planner's question: given what the weekly plan promises and
// the machines the department has, WHAT SHOULD EACH MACHINE RUN, AND IN WHAT
// ORDER, so the promises are kept and the work clears as soon as it can.
//
// The rule is the one a planner uses by hand, done consistently and to the
// hour: take the lines in the order they are DUE (the weekly plan's date
// first, then the flagged orders, then the longest job — long jobs left to
// the end are what make a week overrun), and give each one to the machine
// that can FINISH it first, not the one that is free first. A line's pieces
// split over several machines of the same centre when running them in
// parallel finishes the batch sooner. Routing is respected: a tank is cut,
// then bent, then finned, and the bender cannot start before the cutting of
// that batch is done, so the schedule walks the route in order.
//
// Time is measured in WORKING DAYS from today, each machine at its own pace
// (its hours a day less today's downtime), because that is the only unit that
// compares a laser at 15 h a day with the bending presses at 88.

/** A machine the plan may use. `availableH` is its hours on a working day; a
 *  machine with none (nobody set it) is not schedulable. */
export interface OptMachine {
  id: number;
  code: string;
  center: string;
  availableH: number;
}

/** One centre a line owes work at: what one piece costs there, and the pieces
 *  still to place. `pieces` defaults to the line's — it is lower only when part
 *  of the step is already running on a machine. */
export interface OptStep {
  center: string;
  /** Hours ONE piece costs at this centre — the estimate every machine of it
   *  is assumed to work at. */
  hoursPerPiece: number;
  /** The machines that have their OWN figure for this item, id → hours a
   *  piece. A 6 kW laser and a punch are not the same machine, and where the
   *  planner has said so the plan uses his number, not the estimate. */
  perMachine?: Record<number, number>;
  pieces?: number;
  /** The machines of the centre this work may go on under the machines'
   *  rules (lib/domain/machineRules); absent = every machine of the centre. */
  allowed?: readonly number[];
  /** The machines a rule puts first for this work — they win unless another
   *  allowed machine could start it more than PREFER_DAYS sooner. */
  preferred?: readonly number[];
}

export interface OptLine {
  key: string;
  /** Pieces still to place — the same pieces are owed at every step. */
  pieces: number;
  route: readonly OptStep[];
  /** Working days from today the stage must be finished in; null = no date,
   *  which goes after everything dated. */
  dueDay: number | null;
  /** The order is flagged — ⭐ priority on the tracker, or URGENT on the
   *  monthly plan — and wins among lines due the same day. */
  urgent?: boolean;
}

/** Work already running on a machine: it keeps its place, and the plan is
 *  built around it. */
export interface OptPin {
  key: string;
  center: string;
  machineId: number;
  pieces: number;
  hours: number;
}

/** The work a plan is built around, read off the board as it stands: every
 *  line running now — and, when the planner may plan only some lines (one
 *  line's keys on the shared floor), the waiting lines he may not. Each keeps
 *  its machine and its place; the plan queues behind it. */
export function boardPins(
  cards: readonly { machine: { id: number }; queue: readonly { key: string; item: string; step: string; remaining: number; hours: number | null; running: boolean }[] }[],
  mayPlan: (item: string) => boolean = () => true
): OptPin[] {
  const pins: OptPin[] = [];
  for (const c of cards) {
    for (const q of c.queue) {
      if (!q.running && mayPlan(q.item)) continue;
      pins.push({ key: q.key, center: q.step, machineId: c.machine.id, pieces: q.remaining, hours: q.hours ?? 0 });
    }
  }
  return pins;
}

export interface OptPlacement {
  key: string;
  /** The centre this batch is worked at — the machine's own. */
  center: string;
  machineId: number;
  pieces: number;
  /** Position among the placements on that machine, 1-based. */
  rank: number;
  startDay: number;
  endDay: number;
}

export interface OptSkip {
  key: string;
  center: string;
  /** "no machine": the centre has none with hours; "not allowed": it has,
   *  but the machines' rules allow none of them this work. */
  reason: "no machine" | "not allowed" | "nothing left";
}

export interface OptResult {
  placements: OptPlacement[];
  /** Steps that could not be planned — the centre has no machine with hours. */
  skipped: OptSkip[];
  /** Lines that got at least one placement. */
  linesPlaced: number;
  machinesUsed: number;
  /** Working days until the last piece clears. */
  spanDays: number;
  /** Lines that finish after their date, worst first. */
  late: { key: string; dueDay: number; endDay: number; byDays: number }[];
  /** Lines queued with no standard time — they cost the schedule nothing. */
  unpriced: number;
}

/** A split has to save at least this much of a day, and this much of the
 *  batch's own length, to be worth making. */
const MIN_GAIN = 0.05;
const MIN_GAIN_FRAC = 0.1;
/** A job shorter than half a machine-day stays whole — chasing an hour by
 *  cutting a small batch in two just gives the floor two setups. */
const WHOLE_UNDER_DAYS = 0.5;
/** Never cut one batch over more machines than this — a queue of slivers is
 *  worse to work than a slightly later finish. */
const MAX_SPLIT = 4;
/** A machine a rule prefers for the work goes first unless another allowed
 *  machine could start it more than this many working days sooner — the
 *  planner's preference, not a reason to let a batch wait a week. */
export const PREFER_DAYS = 0.5;

const lineHours = (l: OptLine) => l.route.reduce((s, r) => s + Math.max(0, r.hoursPerPiece) * (r.pieces ?? l.pieces), 0);

/** Split `pieces` in proportion to `weights`, keeping whole pieces and the
 *  exact total (largest remainder), never leaving a machine with none. */
function sharePieces(pieces: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0)) return weights.map((_, i) => (i === 0 ? pieces : 0));
  const exact = weights.map((w) => (pieces * w) / total);
  const out = exact.map((x) => Math.floor(x));
  let left = pieces - out.reduce((s, n) => s + n, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

export function optimizePlan(
  machines: readonly OptMachine[],
  lines: readonly OptLine[],
  pins: readonly OptPin[] = [],
  opts: { maxSplit?: number } = {}
): OptResult {
  const maxSplit = Math.max(1, opts.maxSplit ?? MAX_SPLIT);
  const usable = machines.filter((m) => m.availableH > 0);
  const byCenter = new Map<string, OptMachine[]>();
  for (const m of usable) (byCenter.get(m.center) ?? byCenter.set(m.center, []).get(m.center)!).push(m);

  // what is already running holds its machine, and the plan queues behind it
  const free = new Map<number, number>();
  const pinnedEnd = new Map<string, number>();
  for (const p of pins) {
    const m = usable.find((x) => x.id === p.machineId);
    if (!m) continue;
    const end = (free.get(m.id) ?? 0) + Math.max(0, p.hours) / m.availableH;
    free.set(m.id, end);
    const k = `${p.key}#${p.center}`;
    pinnedEnd.set(k, Math.max(pinnedEnd.get(k) ?? 0, end));
  }

  // due first, then the flagged orders, then the longest job, then the key so
  // the same board always plans the same way
  const queue = [...lines].sort(
    (a, b) =>
      (a.dueDay ?? Number.POSITIVE_INFINITY) - (b.dueDay ?? Number.POSITIVE_INFINITY) ||
      Number(!!b.urgent) - Number(!!a.urgent) ||
      lineHours(b) - lineHours(a) ||
      a.key.localeCompare(b.key)
  );

  const placements: OptPlacement[] = [];
  const skipped: OptSkip[] = [];
  const late: OptResult["late"] = [];
  const placedKeys = new Set<string>();
  let unpriced = 0;
  let span = 0;

  for (const l of queue) {
    if (!(l.pieces > 0) || l.route.length === 0) continue;
    if (lineHours(l) <= 0) unpriced += 1;
    // the route runs in order: nothing can be bent before it is cut
    let ready = 0;
    for (const step of l.route) {
      // Work of this step already running holds its machine and its place. It
      // does NOT hold up the rest of the step — the pieces still to place run
      // beside it on other machines — but the NEXT centre waits for all of it.
      const pinned = pinnedEnd.get(`${l.key}#${step.center}`);
      const pieces = step.pieces ?? l.pieces;
      if (pieces <= 0) {
        if (pinned !== undefined) ready = Math.max(ready, pinned);
        continue; // the whole step is on a machine already
      }
      const atCenter = byCenter.get(step.center) ?? [];
      const cands = step.allowed ? atCenter.filter((m) => step.allowed!.includes(m.id)) : atCenter.slice();
      if (cands.length === 0) {
        skipped.push({ key: l.key, center: step.center, reason: atCenter.length === 0 ? "no machine" : "not allowed" });
        continue;
      }
      // How fast each machine works THIS item: its hours a day over the hours
      // one piece costs it — the planner's own figure where he has set one,
      // the estimate otherwise. A machine with no figure at all (an unpriced
      // item) is infinitely fast: it costs the schedule nothing.
      const perDay = new Map(cands.map((m) => {
        const h = step.perMachine?.[m.id] ?? step.hoursPerPiece;
        return [m.id, h > 0 ? m.availableH / h : Number.POSITIVE_INFINITY];
      }));
      // when each machine could start this batch, soonest first, fastest first
      // — a machine the rules prefer counted as starting PREFER_DAYS sooner
      const starts = new Map(cands.map((m) => [m.id, Math.max(free.get(m.id) ?? 0, ready)]));
      const rankStart = (m: OptMachine) => starts.get(m.id)! - (step.preferred?.includes(m.id) ? PREFER_DAYS : 0);
      cands.sort((x, y) => rankStart(x) - rankStart(y) || perDay.get(y.id)! - perDay.get(x.id)! || x.id - y.id);

      const takes = (m: OptMachine, pcs: number) => {
        const rate = perDay.get(m.id)!;
        return Number.isFinite(rate) && rate > 0 ? pcs / rate : 0;
      };
      // one machine, or several in parallel finishing together — whichever
      // clears the batch earliest (water-filling over the least loaded)
      let bestEnd = starts.get(cands[0].id)! + takes(cands[0], pieces);
      const single = bestEnd;
      let bestK = 1;
      const worthSplitting = single - starts.get(cands[0].id)! >= WHOLE_UNDER_DAYS;
      for (let k = 2; worthSplitting && k <= Math.min(cands.length, maxSplit, pieces); k += 1) {
        const group = cands.slice(0, k);
        const rate = group.reduce((sum, m) => sum + perDay.get(m.id)!, 0);
        if (!Number.isFinite(rate) || rate <= 0) break;
        const weighted = group.reduce((sum, m) => sum + starts.get(m.id)! * perDay.get(m.id)!, 0);
        const end = (pieces + weighted) / rate;
        if (end < starts.get(group[k - 1].id)! - 1e-9) continue; // that machine cannot help before `end`
        if (end < bestEnd - Math.max(MIN_GAIN, MIN_GAIN_FRAC * (single - starts.get(cands[0].id)!))) {
          bestEnd = end;
          bestK = k;
        }
      }

      let group = cands.slice(0, bestK);
      let split = sharePieces(pieces, group.map((m) => Math.max(0, (bestEnd - starts.get(m.id)!) * perDay.get(m.id)!)));
      // a machine that ends up with no piece is not in the split
      while (group.length > 1 && split.some((n) => n <= 0)) {
        group = group.filter((_, i) => split[i] > 0);
        const rate = group.reduce((sum, m) => sum + perDay.get(m.id)!, 0);
        const weighted = group.reduce((sum, m) => sum + starts.get(m.id)! * perDay.get(m.id)!, 0);
        bestEnd = rate > 0 && Number.isFinite(rate) ? (pieces + weighted) / rate : bestEnd;
        split = sharePieces(pieces, group.map((m) => Math.max(0, (bestEnd - starts.get(m.id)!) * perDay.get(m.id)!)));
      }
      if (group.length === 1) {
        bestEnd = starts.get(group[0].id)! + takes(group[0], pieces);
        split = [pieces];
      }

      group.forEach((m, i) => {
        if (split[i] <= 0) return;
        placements.push({
          key: l.key,
          center: step.center,
          machineId: m.id,
          pieces: split[i],
          rank: 0,
          startDay: round1(starts.get(m.id)!),
          endDay: round1(bestEnd),
        });
        free.set(m.id, bestEnd);
      });
      placedKeys.add(l.key);
      // the next centre starts once every piece of this one is through
      ready = Math.max(ready, bestEnd, pinned ?? 0);
    }
    span = Math.max(span, ready);
    if (l.dueDay !== null && ready > l.dueDay + 1e-9) late.push({ key: l.key, dueDay: l.dueDay, endDay: round1(ready), byDays: round1(ready - l.dueDay) });
  }

  // each machine's queue in the order the schedule runs it
  const perMachine = new Map<number, OptPlacement[]>();
  for (const p of placements) (perMachine.get(p.machineId) ?? perMachine.set(p.machineId, []).get(p.machineId)!).push(p);
  for (const list of perMachine.values()) {
    list.sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay || a.key.localeCompare(b.key));
    list.forEach((p, i) => {
      p.rank = i + 1;
    });
  }

  late.sort((a, b) => b.byDays - a.byDays);
  return {
    placements,
    skipped,
    linesPlaced: placedKeys.size,
    machinesUsed: perMachine.size,
    spanDays: round1(span),
    late,
    unpriced,
  };
}
