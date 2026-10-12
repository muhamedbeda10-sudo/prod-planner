// What a machine takes — the planner's rules (MachineRule), and whether a line
// of work may go on a machine under them. Pure: the facts about a line (its
// item, product line, kVA class, and the sheets its nesting cuts it from) are
// gathered by the caller.
//
//   only   — the machine takes ONLY work matching one of its "only" rules;
//   never  — it never takes work matching this rule;
//   prefer — among the machines allowed, it goes first for matching work.
//
// A rule's every given field must match. Thickness and material come from
// the nesting: a line matches a thickness range only when EVERY sheet it is
// cut from is inside it (the machine must be able to cut all of it), and a
// line not nested yet cannot be shown to match a thickness or material rule —
// so an "only" rule that needs it keeps the line off, and a "never" rule that
// needs it does not.

import { normalizeMaterialType } from "./material";

export const RULE_EFFECTS = ["only", "never", "prefer"] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

export const RULE_ITEMS = ["CF", "TC", "TN", "CB", "AR", "MB", "PNL"] as const;

export interface MachineRuleLike {
  id: number;
  machineId: number;
  effect: string;
  item: string | null;
  line: string | null;
  minThicknessMm: number | null;
  maxThicknessMm: number | null;
  material: string | null;
  minKva: number | null;
  maxKva: number | null;
  note?: string | null;
}

/** A rule as the machines page and the assistant list it — retired ones too. */
export interface MachineRuleView extends MachineRuleLike {
  note: string | null;
  active: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What is known about a line of work. */
export interface WorkFacts {
  item: string;
  line: "TR" | "LV";
  /** The order's kVA class; null when it has none (a panel, an unpriced size). */
  kva: number | null;
  /** The thicknesses of the sheets it is cut from; empty when not nested yet. */
  thicknessesMm: readonly number[];
  /** The materials of those sheets; empty when not nested yet. */
  materials: readonly string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Whether a rule is about this work: true, false, or null when the work's
 *  nesting is not known and the rule turns on it. */
export function ruleMatches(r: MachineRuleLike, w: WorkFacts): boolean | null {
  if (r.item && r.item !== w.item) return false;
  if (r.line && r.line !== w.line) return false;
  if (r.minKva !== null || r.maxKva !== null) {
    if (w.kva === null) return false;
    if (r.minKva !== null && w.kva < r.minKva) return false;
    if (r.maxKva !== null && w.kva > r.maxKva) return false;
  }
  let unknown = false;
  if (r.minThicknessMm !== null || r.maxThicknessMm !== null) {
    if (w.thicknessesMm.length === 0) unknown = true;
    else if (!w.thicknessesMm.every((t) => (r.minThicknessMm === null || t >= r.minThicknessMm - 1e-9) && (r.maxThicknessMm === null || t <= r.maxThicknessMm + 1e-9))) return false;
  }
  if (r.material) {
    if (w.materials.length === 0) unknown = true;
    else if (!w.materials.every((m) => norm(m) === norm(r.material!))) return false;
  }
  return unknown ? null : true;
}

export interface MachineVerdict {
  allowed: boolean;
  preferred: boolean;
  /** Why it is not allowed — the rule's own words where it has them. */
  why: string | null;
}

/** Whether a machine may take this work under its active rules. */
export function machineVerdict(rules: readonly MachineRuleLike[], w: WorkFacts): MachineVerdict {
  const never = rules.find((r) => r.effect === "never" && ruleMatches(r, w) === true);
  if (never) return { allowed: false, preferred: false, why: never.note?.trim() || `never: ${describeRule(never)}` };
  const only = rules.filter((r) => r.effect === "only");
  if (only.length > 0 && !only.some((r) => ruleMatches(r, w) === true)) {
    const unknown = only.some((r) => ruleMatches(r, w) === null);
    return { allowed: false, preferred: false, why: unknown ? "its rules need the sheet's thickness or material, and this line is not nested yet" : `takes only ${only.map(describeRule).join(" or ")}` };
  }
  const preferred = rules.some((r) => r.effect === "prefer" && ruleMatches(r, w) === true);
  return { allowed: true, preferred, why: null };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** A rule as a person reads it: "TN, 6–12 mm, Steel, 1000 kVA and up". */
export function describeRule(r: MachineRuleLike): string {
  const parts: string[] = [];
  if (r.item) parts.push(r.item);
  if (r.line) parts.push(r.line === "LV" ? "LV panels" : "transformers");
  if (r.minThicknessMm !== null && r.maxThicknessMm !== null) parts.push(`${fmt(r.minThicknessMm)}–${fmt(r.maxThicknessMm)} mm`);
  else if (r.minThicknessMm !== null) parts.push(`${fmt(r.minThicknessMm)} mm and up`);
  else if (r.maxThicknessMm !== null) parts.push(`up to ${fmt(r.maxThicknessMm)} mm`);
  if (r.material) parts.push(r.material);
  if (r.minKva !== null && r.maxKva !== null) parts.push(`${r.minKva}–${r.maxKva} kVA`);
  else if (r.minKva !== null) parts.push(`${r.minKva} kVA and up`);
  else if (r.maxKva !== null) parts.push(`up to ${r.maxKva} kVA`);
  return parts.length > 0 ? parts.join(", ") : "all work";
}

/** The rule as one sentence about its machine. */
export function ruleSentence(code: string, r: MachineRuleLike): string {
  const what = describeRule(r);
  if (r.effect === "only") return `${code} takes only ${what}`;
  if (r.effect === "never") return `${code} never takes ${what}`;
  return `${code} goes first for ${what}`;
}

export interface RuleInput {
  effect: string;
  item?: string | null;
  line?: string | null;
  minThicknessMm?: number | null;
  maxThicknessMm?: number | null;
  material?: string | null;
  minKva?: number | null;
  maxKva?: number | null;
  note?: string | null;
}

/** A rule's fields cleaned, or what is wrong with them. */
export function checkRule(i: RuleInput): { ok: true; rule: Omit<MachineRuleLike, "id" | "machineId"> } | { ok: false; error: string } {
  if (!(RULE_EFFECTS as readonly string[]).includes(i.effect)) return { ok: false, error: "The rule must be only, never or prefer." };
  const item = i.item?.trim().toUpperCase() || null;
  if (item && !(RULE_ITEMS as readonly string[]).includes(item)) return { ok: false, error: `Unknown item ${item}.` };
  const line = i.line?.trim().toUpperCase() || null;
  if (line && line !== "TR" && line !== "LV") return { ok: false, error: "The line is TR or LV." };
  const num = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? null : v);
  const minT = num(i.minThicknessMm);
  const maxT = num(i.maxThicknessMm);
  if ((minT !== null && (minT <= 0 || minT > 200)) || (maxT !== null && (maxT <= 0 || maxT > 200))) return { ok: false, error: "A thickness is in millimetres, over 0." };
  if (minT !== null && maxT !== null && minT > maxT) return { ok: false, error: "The lowest thickness is above the highest." };
  const minK = num(i.minKva);
  const maxK = num(i.maxKva);
  if ((minK !== null && (!Number.isInteger(minK) || minK <= 0)) || (maxK !== null && (!Number.isInteger(maxK) || maxK <= 0))) return { ok: false, error: "A kVA is a whole number over 0." };
  if (minK !== null && maxK !== null && minK > maxK) return { ok: false, error: "The lowest kVA is above the highest." };
  // the MATERIAL tab's own name for it: "SS" and "stainless" are Stainless steel
  const material = normalizeMaterialType(i.material) || null;
  if (material && material.length > 60) return { ok: false, error: "Keep the material under 60 characters." };
  const note = i.note?.trim() || null;
  if (note && note.length > 300) return { ok: false, error: "Keep the note under 300 characters." };
  if (i.effect === "only" && !item && !line && minT === null && maxT === null && !material && minK === null && maxK === null) {
    return { ok: false, error: "An \"only\" rule must say what the machine takes." };
  }
  if (i.effect === "never" && !item && !line && minT === null && maxT === null && !material && minK === null && maxK === null) {
    return { ok: false, error: "A \"never\" rule on all work is a retired machine — retire the machine instead." };
  }
  return { ok: true, rule: { effect: i.effect, item, line, minThicknessMm: minT, maxThicknessMm: maxT, material, minKva: minK, maxKva: maxK, note } };
}
