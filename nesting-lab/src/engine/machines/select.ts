// Which machine for this nesting? Compatibility first (process, bed, thickness,
// material, rules), then preference and queue. Unknown facts are reported as
// "to confirm", never assumed. Nothing here sends work anywhere.

import type { Compatibility, JobFacts, MachineAssessment, MachineConfig, MachineRuleConfig, MachinesFile } from "./types";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Best first. */
const COMPAT_ORDER: readonly Compatibility[] = ["compatible", "conditional", "unconfirmed", "incompatible"];

/** The same contract as the planner's lib/domain/machineRules.ts ruleMatches:
 *  every given field must match; a kVA rule never matches a job without a kVA. */
function ruleMatches(r: MachineRuleConfig, job: JobFacts): boolean {
  if (r.item && r.item !== (job.item ?? "")) return false;
  if (r.line && r.line !== (job.line ?? "")) return false;
  if ((r.minKva ?? null) !== null || (r.maxKva ?? null) !== null) {
    if (job.kva === null || job.kva === undefined) return false;
    if ((r.minKva ?? null) !== null && job.kva < (r.minKva as number)) return false;
    if ((r.maxKva ?? null) !== null && job.kva > (r.maxKva as number)) return false;
  }
  if ((r.minThicknessMm ?? null) !== null && job.thicknessMm < (r.minThicknessMm as number) - 1e-9) return false;
  if ((r.maxThicknessMm ?? null) !== null && job.thicknessMm > (r.maxThicknessMm as number) + 1e-9) return false;
  if (r.material && norm(r.material) !== norm(job.material)) return false;
  return true;
}

export interface MachineContext {
  /** the planner's active rules for this machine */
  rules: MachineRuleConfig[];
  /** hours already queued on it; null = unknown */
  queueHoursAhead: number | null;
}

export function contextFromFile(m: MachineConfig, file: MachinesFile): MachineContext {
  return { rules: file.rules.items.filter((r) => r.machineCode === m.code), queueHoursAhead: file.queue.hoursAhead[m.code] ?? null };
}

export function assessMachine(m: MachineConfig, job: JobFacts, ctx: MachineContext): MachineAssessment {
  const reasons: string[] = [];
  const toConfirm: string[] = [];
  const state: { compat: Compatibility } = { compat: "compatible" };
  const worsen = (c: Compatibility) => {
    if (COMPAT_ORDER.indexOf(c) > COMPAT_ORDER.indexOf(state.compat)) state.compat = c;
  };
  const compat = () => state.compat;
  if (!m.active) {
    worsen("incompatible");
    reasons.push("retired in the machines list");
  }
  if (m.dept !== "Cut") {
    worsen("incompatible");
    reasons.push(`not a Fabrication machine (${m.dept})`);
  }
  switch (m.process) {
    case "laser-flat":
      reasons.push(m.processSource === "confirmed" ? "flat-sheet laser" : "flat-sheet laser (by its name — confirm)");
      if (m.processSource !== "confirmed") toConfirm.push("that it is a flat-sheet laser");
      break;
    case "punching":
      worsen("conditional");
      reasons.push("punching machine: the nested geometry can go to its CAM, but hole and contour feasibility depend on its tooling, which this prototype does not know");
      toConfirm.push("tool library and station assignment for these contours");
      break;
    case "laser-tube":
      worsen("incompatible");
      reasons.push("tube laser — flat-sheet nesting never goes here");
      break;
    case "laser-roll-blank":
      worsen("incompatible");
      reasons.push("coil-fed blanking line, not a sheet bed");
      break;
    case "fin-folding":
    case "bending":
    case "other":
      worsen("incompatible");
      reasons.push(`${m.center} work centre, not a cutting machine`);
      break;
  }
  if (compat() !== "incompatible") {
    if (m.bedMm) {
      const fits = (m.bedMm.width >= job.sheetWidthMm - 1e-9 && m.bedMm.height >= job.sheetHeightMm - 1e-9) || (m.bedMm.width >= job.sheetHeightMm - 1e-9 && m.bedMm.height >= job.sheetWidthMm - 1e-9);
      if (!fits) {
        worsen("incompatible");
        reasons.push(`bed ${m.bedMm.width}×${m.bedMm.height} mm is smaller than the ${job.sheetWidthMm}×${job.sheetHeightMm} mm sheet`);
      } else reasons.push(`bed ${m.bedMm.width}×${m.bedMm.height} mm takes the sheet`);
    } else {
      worsen("unconfirmed");
      toConfirm.push(`bed size takes a ${job.sheetWidthMm}×${job.sheetHeightMm} mm sheet`);
    }
    if (m.thicknessMm) {
      if (job.thicknessMm < m.thicknessMm.min - 1e-9 || job.thicknessMm > m.thicknessMm.max + 1e-9) {
        worsen("incompatible");
        reasons.push(`cuts ${m.thicknessMm.min}–${m.thicknessMm.max} mm, the job is ${job.thicknessMm} mm`);
      } else reasons.push(`${job.thicknessMm} mm is within its ${m.thicknessMm.min}–${m.thicknessMm.max} mm range`);
    } else {
      worsen("unconfirmed");
      toConfirm.push(`it cuts ${job.thicknessMm} mm ${job.material}`);
    }
    if (m.materials) {
      if (!m.materials.some((x) => norm(x) === norm(job.material))) {
        worsen("incompatible");
        reasons.push(`does not cut ${job.material} (cuts ${m.materials.join(", ")})`);
      }
    } else {
      worsen("unconfirmed");
      if (m.thicknessMm) toConfirm.push(`it cuts ${job.material}`); // else the thickness line above already asks
    }
  }
  // planner rules
  const rules = ctx.rules;
  let preferred = false;
  if (compat() !== "incompatible") {
    const never = rules.find((r) => r.effect === "never" && ruleMatches(r, job));
    if (never) {
      worsen("incompatible");
      reasons.push(never.note?.trim() || "a 'never' rule of the planner excludes this work");
    }
    const only = rules.filter((r) => r.effect === "only");
    if (only.length > 0 && !only.some((r) => ruleMatches(r, job))) {
      worsen("incompatible");
      reasons.push("the planner's 'only' rules do not include this work");
    }
    preferred = rules.some((r) => r.effect === "prefer" && ruleMatches(r, job));
    if (preferred) reasons.push("the planner prefers it for this work");
  }
  const queue = ctx.queueHoursAhead;
  if (compat() !== "incompatible") {
    if (queue === null) toConfirm.push("hours already queued (read from the machine board at integration)");
    else reasons.push(`${queue} h already queued`);
  }
  const exportProfile = m.exportProfiles.length > 0 ? m.exportProfiles[0] : compat() === "incompatible" ? null : "dxf-r2000-mm";
  if (compat() !== "incompatible" && m.exportProfiles.length === 0) reasons.push("no machine-specific program format is configured; a mm DXF (R2000) is what can be handed to its CAM today");
  return { machine: m, compatibility: compat(), reasons, toConfirm, queueHoursAhead: queue, preferred, exportProfile, rank: 0 };
}

/** Job facts for a nesting run — the one place they are derived from settings. */
export function jobFactsOf(settings: { sheet: { material: string; thicknessMm: number; widthMm: number; heightMm: number } }, sheets: number, extra: { item?: string | null; line?: "TR" | "LV" | null; kva?: number | null } = {}): JobFacts {
  return { material: settings.sheet.material, thicknessMm: settings.sheet.thicknessMm, sheetWidthMm: settings.sheet.widthMm, sheetHeightMm: settings.sheet.heightMm, sheets, item: extra.item ?? null, line: extra.line ?? null, kva: extra.kva ?? null };
}

export function rankMachines(job: JobFacts, file: MachinesFile): MachineAssessment[] {
  const list = file.machines.map((m) => assessMachine(m, job, contextFromFile(m, file)));
  list.sort((a, b) => {
    const d = COMPAT_ORDER.indexOf(a.compatibility) - COMPAT_ORDER.indexOf(b.compatibility);
    if (d !== 0) return d;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    const qa = a.queueHoursAhead ?? Infinity;
    const qb = b.queueHoursAhead ?? Infinity;
    if (qa !== qb) return qa - qb;
    const pa = a.machine.laserPowerKw ?? 0;
    const pb = b.machine.laserPowerKw ?? 0;
    if (pa !== pb) return pb - pa;
    return a.machine.code.localeCompare(b.machine.code);
  });
  list.forEach((a, i) => (a.rank = i + 1));
  return list;
}
