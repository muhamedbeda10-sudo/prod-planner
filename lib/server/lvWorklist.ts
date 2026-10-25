import "server-only";
import { getLvTracker, type LvTrackerRow } from "./lvTracker";
import { lvStageOf, lvWaiting, lvWorklistBucket, type LvStage } from "@/lib/domain/lv";

// An LV stage's worklist. The transformer worklists are cut from the WEEKLY
// schedule, which promises each component a date; the panels have no weekly
// plan, so a stage's list is the monthly plan read against the ledger: every
// open panel order the stage before has fed and this stage has not finished,
// urgent first, the plan's order otherwise.

export interface LvWorklistRow extends LvTrackerRow {
  /** Panels this stage still owes: what the stage before finished, less
   *  what this one has. */
  waiting: number;
  /** Panels done at this stage. */
  done: number;
}

export interface LvWorklist {
  stage: LvStage;
  /** Orders with something to do at this stage. */
  rows: LvWorklistRow[];
  /** Orders waiting on the stage before — it has not fed them yet, or this
   *  stage has done everything it handed over so far. */
  upstream: LvWorklistRow[];
  /** Orders finished at this stage, still open. */
  finished: LvWorklistRow[];
  /** Orders with no quantity yet that nothing has reached — no plan to work from. */
  unplanned: LvWorklistRow[];
  /** ⏸ open orders the planner paused — out of every list above, named once. */
  held: LvWorklistRow[];
}

export async function getLvWorklist(stage: LvStage): Promise<LvWorklist> {
  const open = (await getLvTracker()).filter((r) => r.status === "open");
  const all = open.filter((r) => !r.hold.onHold);
  const row = (r: LvTrackerRow): LvWorklistRow => ({ ...r, waiting: lvWaiting(r.state, stage), done: lvStageOf(r.state, stage) });

  const buckets = { rows: [] as LvWorklistRow[], upstream: [] as LvWorklistRow[], finished: [] as LvWorklistRow[], unplanned: [] as LvWorklistRow[] };
  const held: LvWorklistRow[] = open.filter((r) => r.hold.onHold).map(row);
  for (const r of all) buckets[lvWorklistBucket(r.state, stage)].push(row(r));
  const byUrgency = (a: LvWorklistRow, b: LvWorklistRow) => Number(b.urgent) - Number(a.urgent) || Number(b.priority) - Number(a.priority);
  buckets.rows.sort(byUrgency);
  return { stage, ...buckets, held };
}
