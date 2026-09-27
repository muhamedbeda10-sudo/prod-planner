// Productivity off the shift log: the man-hours a department recorded
// against the pieces the daily log says it made on the same days. Pure, so
// the arithmetic is tested without a database.
//
// Two readings per department:
//   man-hours per piece — plain, works for every department, panels included
//   efficiency          — the std-hours the output is worth ÷ the man-hours
//                         worked, by the KVA class for a transformer and by
//                         the timings sheet's LV tab for a panel. 100% = the crew works exactly at
//                         the standard; below it the standard is too tight
//                         or time went elsewhere.
// A single day is noisy — output is often recorded a day late — so the
// figure over the last recorded days is the one to read.

import type { RosterDept } from "./shifts";

export interface OutputSource { depts: readonly string[]; line: "TR" | "LV" }

/** Where a roster department's output sits in the daily log: the ledger
 *  departments it counts, per product line. The blasters pass every painted
 *  piece, not only the core — and the one shot-blast crew blasts the LV
 *  panels too, before they are painted. */
export const OUTPUT_SOURCE: Record<RosterDept, readonly OutputSource[]> = {
  Cut: [{ depts: ["Cut"], line: "TR" }],
  Welding: [{ depts: ["Welding"], line: "TR" }],
  ShotBlast: [{ depts: ["ShotBlast", "Painting"], line: "TR" }, { depts: ["Painting"], line: "LV" }],
  Painting: [{ depts: ["Painting"], line: "TR" }],
  Punching: [{ depts: ["Punching"], line: "LV" }],
  Bending: [{ depts: ["Bending"], line: "LV" }],
  WeldingLV: [{ depts: ["Welding"], line: "LV" }],
  PaintingLV: [{ depts: ["Painting"], line: "LV" }],
};

/** Whether a ledger row (its department, and whether it is a panel) is the output of a roster department. */
export function countsFor(dept: RosterDept, ledgerDept: string, lv: boolean): boolean {
  return OUTPUT_SOURCE[dept].some((s) => (s.line === "LV") === lv && s.depts.includes(ledgerDept));
}

/** One recorded day of one department. */
export interface ProdDay {
  dateISO: string;
  hours: number; // man-hours the shift log recorded
  people: number; // present that day
  pieces: number; // what the daily log recorded for it that day
  /** Std-hours that output is worth; null where the department has no standard times. */
  earned: number | null;
}

export interface ProdStat {
  days: number;
  manHours: number;
  /** Average present per recorded day. */
  people: number;
  pieces: number;
  /** Man-hours one piece took; null with no pieces. */
  mhPerPiece: number | null;
  earned: number | null;
  /** earned ÷ man-hours; null with no standard times or no hours. */
  efficiency: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function productivityOf(days: readonly ProdDay[]): ProdStat {
  const counted = days.filter((d) => d.hours > 0);
  const manHours = counted.reduce((s, d) => s + d.hours, 0);
  const pieces = counted.reduce((s, d) => s + Math.max(0, d.pieces), 0);
  const priced = counted.every((d) => d.earned !== null) && counted.length > 0;
  const earned = priced ? counted.reduce((s, d) => s + (d.earned ?? 0), 0) : null;
  return {
    days: counted.length,
    manHours: r1(manHours),
    people: counted.length ? r1(counted.reduce((s, d) => s + d.people, 0) / counted.length) : 0,
    pieces,
    mhPerPiece: pieces > 0 ? r2(manHours / pieces) : null,
    earned: earned === null ? null : r1(earned),
    efficiency: earned !== null && manHours > 0 ? earned / manHours : null,
  };
}

export type EfficiencyTone = "ok" | "warn" | "bad";
/** 90% and up is on the standard, 70% and up is short of it, below that is a problem. */
export function efficiencyTone(e: number): EfficiencyTone {
  return e >= 0.9 ? "ok" : e >= 0.7 ? "warn" : "bad";
}
