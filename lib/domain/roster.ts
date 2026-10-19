// The shift roster's filter — everyone, a line, or one section — and what
// it selects. Pure, shared by the page (server) and the roster (client): a
// helper exported from a "use client" file cannot be called on the server.

import { ROSTER_DEPT_LINE, isRosterDept, type RosterDept } from "./shifts";
import { WORKER_SECTIONS, sectionLabel } from "./tanks";

type RosterSectionRow = Extract<(typeof WORKER_SECTIONS)[number], { dept: RosterDept }>;

/** The sections the roster lists — those whose department keeps a shift log.
 *  Leak testing and quality are sections for the tank dropdowns only: their
 *  days are not recorded on the shift log, so they are not offered here. */
export const ROSTER_SECTIONS = WORKER_SECTIONS.filter((s): s is RosterSectionRow => isRosterDept(s.dept));
export type RosterSection = RosterSectionRow["code"];

export function isRosterSection(x: string): x is RosterSection {
  return ROSTER_SECTIONS.some((s) => s.code === x);
}

export type RosterFilter = "" | "line:TR" | "line:LV" | RosterSection;

/** Read the filter off the URL; anything unknown is "everyone". */
export function parseRosterFilter(raw: string | undefined): RosterFilter {
  const v = raw ?? "";
  if (v === "line:TR" || v === "line:LV") return v;
  return isRosterSection(v) ? v : "";
}

/** The departments a filter covers — the history strip and the capacity read these. */
export function rosterDepts(filter: RosterFilter): RosterDept[] {
  const all = Object.keys(ROSTER_DEPT_LINE) as RosterDept[];
  if (filter === "") return all;
  if (filter === "line:TR" || filter === "line:LV") return all.filter((d) => ROSTER_DEPT_LINE[d] === filter.slice(5));
  return [ROSTER_SECTIONS.find((s) => s.code === filter)!.dept];
}

/** Whether one roster line (a worker under a department, with his sections there) is in the filter. */
export function rosterLineMatches(l: { dept: RosterDept; sections: readonly string[] }, filter: RosterFilter): boolean {
  if (filter === "") return true;
  if (filter === "line:TR" || filter === "line:LV") return ROSTER_DEPT_LINE[l.dept] === filter.slice(5);
  return l.sections.includes(filter);
}

/** How the filter reads on screen. */
export function rosterFilterLabel(filter: RosterFilter): string {
  if (filter === "") return "Everyone";
  if (filter === "line:TR") return "Transformers";
  if (filter === "line:LV") return "LV panels";
  return sectionLabel(filter);
}
