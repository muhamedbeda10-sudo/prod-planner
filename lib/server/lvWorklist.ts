import "server-only";
import { getLvTracker, type LvTrackerRow } from "./lvTracker";
import { LV_STAGES, lvWaiting, type LvStage } from "@/lib/domain/lv";

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
  /** Orders the stage before has not fed yet — nothing to do here until it does. */
  upstream: LvWorklistRow[];
  /** Orders finished at this stage, still open. */
  finished: LvWorklistRow[];
}

export async function getLvWorklist(stage: LvStage): Promise<LvWorklist> {
  const all = (await getLvTracker()).filter((r) => r.status === "open");
  const idx = LV_STAGES.indexOf(stage);
  const prev = idx === 0 ? null : LV_STAGES[idx - 1];
  const doneAt = (r: LvTrackerRow) => (stage === "Punching" ? r.state.punch : stage === "Bending" ? r.state.bend : stage === "Welding" ? r.state.weld : r.state.paint);
  const fed = (r: LvTrackerRow) => (prev === null ? r.state.required : prev === "Punching" ? r.state.punch : prev === "Bending" ? r.state.bend : r.state.weld);

  const rows: LvWorklistRow[] = [];
  const upstream: LvWorklistRow[] = [];
  const finished: LvWorklistRow[] = [];
  for (const r of all) {
    const w: LvWorklistRow = { ...r, waiting: lvWaiting(r.state, stage), done: doneAt(r) };
    if (w.waiting > 0) rows.push(w);
    else if (r.state.required > 0 && doneAt(r) >= r.state.required) finished.push(w);
    else if (fed(r) === 0) upstream.push(w);
  }
  const byUrgency = (a: LvWorklistRow, b: LvWorklistRow) => Number(b.urgent) - Number(a.urgent) || Number(b.priority) - Number(a.priority);
  rows.sort(byUrgency);
  return { stage, rows, upstream, finished };
}
