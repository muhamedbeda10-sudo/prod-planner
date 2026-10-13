// The What-if Simulator and the assistant's chat in one browser tab. While
// the Simulator is open it says so here, and what it shows: the chat sends
// that with each question and puts on it the scenarios the assistant shows
// the person. With the Simulator closed, the chat's button leaves one for it
// to open with. Each one the assistant puts there keeps the scenario it
// replaced — in this browser's storage, beside the Simulator's own work in
// progress — so one click puts it back. Client-only module.

import { useMemo, useSyncExternalStore } from "react";
import type { Scenario } from "@/lib/domain/whatif";
import { parseSteps, withStep, type AssistStep } from "@/lib/domain/simulatorScreen";

/** The Simulator's work in progress — what it shows when it opens. */
export const SIM_SCENARIO_KEY = "atc.sim.scenario";
/** The scenarios the assistant replaced on it, oldest first. */
const STEPS_KEY = "atc.sim.assistant";

export interface OpenSimulator {
  /** The scenario on the screen now. */
  scenario(): Scenario;
  /** Put the assistant's scenario on the screen — the one it replaces kept
   *  for one click back. */
  show(scenario: Scenario, label: string): void;
}

let open: OpenSimulator | null = null;
/** The scenario left for the Simulator to open with, on this page load —
 *  storage carries it too, but may be full or blocked. */
let staged: Scenario | null = null;

/** The Simulator on this page is open — until the function it gets back is called. */
export function attachSimulator(s: OpenSimulator): () => void {
  open = s;
  return () => {
    if (open === s) open = null;
  };
}

/** The Simulator open on this page, or null. */
export function openSimulator(): OpenSimulator | null {
  return open;
}

/** The scenario the Simulator would open with: its work in progress, kept
 *  in storage — null when there is none (it opens on the plant as it stands). */
function storedScenario(): object | null {
  try {
    const raw = localStorage.getItem(SIM_SCENARIO_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** With the Simulator closed: leave the assistant's scenario for it to open
 *  with, and keep the one it would have opened with for one click back. */
export function stageOnSimulator(scenario: Scenario, label: string) {
  pushAssistStep(label, staged ?? storedScenario());
  staged = scenario;
  try {
    localStorage.setItem(SIM_SCENARIO_KEY, JSON.stringify(scenario));
  } catch {
    /* full or blocked — this page load carries it */
  }
}

/** The scenario left for the Simulator to open with on this page load, if any. */
export function stagedScenario(): Scenario | null {
  return staged;
}

/** The Simulator has opened with it. */
export function clearStaged() {
  staged = null;
}

// ---- the scenarios the assistant replaced: this browser's storage is the
// source of truth (memory, while it is blocked); the server renders none, and
// the browser takes over after hydration

const listeners = new Set<() => void>();
let memory = "";

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function readSteps(): string {
  try {
    return localStorage.getItem(STEPS_KEY) ?? memory;
  } catch {
    return memory;
  }
}

/** The scenarios the assistant replaced on the Simulator, oldest first. */
export function useAssistSteps(): AssistStep[] {
  const raw = useSyncExternalStore(subscribe, readSteps, () => "");
  return useMemo(() => parseSteps(raw), [raw]);
}

export function setAssistSteps(steps: readonly AssistStep[]) {
  memory = steps.length ? JSON.stringify(steps) : "";
  try {
    if (memory) localStorage.setItem(STEPS_KEY, memory);
    else localStorage.removeItem(STEPS_KEY);
  } catch {
    // full: what storage still holds would hide these
    try {
      localStorage.removeItem(STEPS_KEY);
    } catch {
      /* blocked — this page load keeps them */
    }
  }
  listeners.forEach((l) => l());
}

/** One more scenario the assistant replaced — null for the plant as it stood. */
export function pushAssistStep(label: string, before: object | null) {
  setAssistSteps(withStep(parseSteps(readSteps()), { label, before }));
}
