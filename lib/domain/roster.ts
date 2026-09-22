// The shift roster's filter — everyone, a line, or one section — and what
// it selects. Pure, shared by the page (server) and the roster (client): a
// helper exported from a "use client" file cannot be called on the server.

import { ROSTER_DEPT_LINE, type RosterDept } from "./shifts";
import { isWorkerSection, sectionDept, type WorkerSection } from "./tanks";

export type RosterFilter = "" | "line:TR" | "line:LV" | WorkerSection;

/** Read the filter off the URL; anything unknown is "everyone". */
export function parseRosterFilter(raw: string | undefined): RosterFilter {
  const v = raw ?? "";
  if (v === "line:TR" || v === "line:LV") return v;
  return isWorkerSection(v) ? v : "";
}

/** The departments a filter covers — the history strip and the capacity read these. */
export function rosterDepts(filter: RosterFilter): RosterDept[] {
  const all = Object.keys(ROSTER_DEPT_LINE) as RosterDept[];
  if (filter === "") return all;
  if (filter === "line:TR" || filter === "line:LV") return all.filter((d) => ROSTER_DEPT_LINE[d] === filter.slice(5));
  return [sectionDept(filter) as RosterDept];
}

/** Whether one roster line (a worker under a department, with his sections there) is in the filter. */
export function rosterLineMatches(l: { dept: RosterDept; sections: readonly string[] }, filter: RosterFilter): boolean {
  if (filter === "") return true;
  if (filter === "line:TR" || filter === "line:LV") return ROSTER_DEPT_LINE[l.dept] === filter.slice(5);
  return l.sections.includes(filter);
}
