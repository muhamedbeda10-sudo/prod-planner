// The assistant and the What-if Simulator on the person's screen — the pure
// part, shared by the server and the browser:
//
//   simulatorOnScreen  the Simulator's scenario a question carries, from the
//                      browser that has it open beside the chat;
//   SimulatorShow      a scenario the assistant puts on the Simulator — the
//                      chat stream's "screen" event;
//   AssistStep         the scenario each one replaced, kept in the browser so
//                      one click puts it back.

import type { Scenario } from "./whatif";

export const SIM_SCREEN = {
  /** The scenarios kept for "put back the one before". */
  back: 5,
  /** The largest scenario a question carries, as JSON — the Simulator's own
   *  limits (lib/domain/whatifScenario.ts) fit well inside. */
  maxChars: 800_000,
  /** The longest line naming a scenario. */
  label: 200,
} as const;

/** Where the Simulator opens. */
export const SIMULATOR_HREF = "/simulate?view=whatif";

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The scenario on the Simulator a question says is open beside the chat —
 *  as the browser sent it, to be read against today's jobs where it is used —
 *  or null: not open, not a scenario, or too large to be one. */
export function simulatorOnScreen(screen: unknown): Record<string, unknown> | null {
  if (!isPlainObject(screen) || !isPlainObject(screen.simulator)) return null;
  let size: number;
  try {
    size = JSON.stringify(screen.simulator).length;
  } catch {
    return null;
  }
  return size <= SIM_SCREEN.maxChars ? screen.simulator : null;
}

/** A scenario the assistant puts on the Simulator. */
export interface SimulatorShow {
  /** The tool call that put it there. */
  toolUseId: string;
  scenario: Scenario;
  /** One line that names it: "+2 Welding · Fridays on". */
  label: string;
}

/** A "screen" event's payload, as the chat takes it. */
export function isSimulatorShow(v: unknown): v is SimulatorShow {
  return isPlainObject(v) && typeof v.toolUseId === "string" && typeof v.label === "string" && isPlainObject(v.scenario) && Array.isArray(v.scenario.queue);
}

/** A scenario the assistant put on the Simulator: the line naming it, and the
 *  scenario it replaced — null when that was the plant as it stands. */
export interface AssistStep {
  label: string;
  before: object | null;
}

/** The steps kept in the browser, oldest first, from their stored text —
 *  anything unreadable is left out, never guessed. */
export function parseSteps(raw: string): AssistStep[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: AssistStep[] = [];
  for (const s of v) {
    if (!isPlainObject(s) || typeof s.label !== "string" || !(s.before === null || isPlainObject(s.before))) continue;
    out.push({ label: s.label.slice(0, SIM_SCREEN.label), before: s.before });
  }
  return out.slice(-SIM_SCREEN.back);
}

/** One more step — the oldest let go past the limit. */
export function withStep(steps: readonly AssistStep[], step: AssistStep): AssistStep[] {
  return [...steps, { label: step.label.slice(0, SIM_SCREEN.label), before: step.before }].slice(-SIM_SCREEN.back);
}
