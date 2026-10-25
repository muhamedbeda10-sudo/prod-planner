export type MachineProcess = "laser-flat" | "punching" | "laser-tube" | "laser-roll-blank" | "fin-folding" | "bending" | "other";

export interface MachineConfig {
  code: string;
  name: string;
  dept: string;
  center: string;
  hoursPerDay: number | null;
  active: boolean;
  process: MachineProcess;
  processSource: "confirmed" | "inferred-from-name" | "app-work-centre";
  laserPowerKw: number | null;
  /** usable bed, mm; null = unknown */
  bedMm: { width: number; height: number } | null;
  /** cuttable thickness range per material or overall; null = unknown */
  thicknessMm: { min: number; max: number } | null;
  /** materials it cuts (as the Material tab names them); null = unknown */
  materials: string[] | null;
  controller: string | null;
  /** export profile ids this machine's CAM accepts */
  exportProfiles: string[];
  notes: string;
}

/** Shaped like the planner's MachineRule (lib/domain/machineRules.ts MachineRuleLike)
 *  so the live rows can be passed straight in at integration. */
export interface MachineRuleConfig {
  machineCode: string;
  effect: "only" | "never" | "prefer";
  item?: string | null;
  line?: string | null;
  minThicknessMm?: number | null;
  maxThicknessMm?: number | null;
  material?: string | null;
  minKva?: number | null;
  maxKva?: number | null;
  note?: string | null;
}

export interface MachinesFile {
  source: string;
  machines: MachineConfig[];
  rules: { items: MachineRuleConfig[] };
  queue: { hoursAhead: Record<string, number> };
}

export interface JobFacts {
  material: string;
  thicknessMm: number;
  sheetWidthMm: number;
  sheetHeightMm: number;
  sheets: number;
  /** the planner's component code when known (TN, TC, CF, CB …) */
  item?: string | null;
  line?: "TR" | "LV" | null;
  /** the order's kVA class when known */
  kva?: number | null;
}

export type Compatibility = "compatible" | "conditional" | "unconfirmed" | "incompatible";

export interface MachineAssessment {
  machine: MachineConfig;
  compatibility: Compatibility;
  reasons: string[];
  /** facts the floor must confirm before this machine is trusted for the job */
  toConfirm: string[];
  queueHoursAhead: number | null;
  preferred: boolean;
  /** export profile that can be produced for it today, if any */
  exportProfile: string | null;
  rank: number;
}
