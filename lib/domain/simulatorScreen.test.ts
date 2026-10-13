import { describe, expect, it } from "vitest";
import { isSimulatorShow, parseSteps, SIM_SCREEN, simulatorOnScreen, withStep, type AssistStep } from "./simulatorScreen";

describe("simulatorOnScreen", () => {
  it("takes the scenario of a Simulator open beside the chat", () => {
    const sc = { workFridays: true, queue: ["A|TN"] };
    expect(simulatorOnScreen({ simulator: sc })).toBe(sc);
  });

  it("is null when nothing is open, it is not a scenario, or it is too large to be one", () => {
    expect(simulatorOnScreen(undefined)).toBeNull();
    expect(simulatorOnScreen({})).toBeNull();
    expect(simulatorOnScreen({ simulator: "x" })).toBeNull();
    expect(simulatorOnScreen({ simulator: [1, 2] })).toBeNull();
    expect(simulatorOnScreen({ simulator: { queue: ["x".repeat(SIM_SCREEN.maxChars)] } })).toBeNull();
  });
});

describe("isSimulatorShow", () => {
  it("takes a scenario the assistant shows, and nothing else", () => {
    expect(isSimulatorShow({ toolUseId: "toolu_1", label: "Fridays on", scenario: { queue: [] } })).toBe(true);
    expect(isSimulatorShow({ toolUseId: "toolu_1", label: "Fridays on", scenario: {} })).toBe(false);
    expect(isSimulatorShow({ label: "Fridays on", scenario: { queue: [] } })).toBe(false);
    expect(isSimulatorShow(null)).toBe(false);
  });
});

describe("the scenarios the assistant replaced", () => {
  const step = (n: number): AssistStep => ({ label: `step ${n}`, before: n === 0 ? null : { shiftHours: n } });

  it("keep the newest few, oldest first", () => {
    let steps: AssistStep[] = [];
    for (let n = 0; n < SIM_SCREEN.back + 2; n++) steps = withStep(steps, step(n));
    expect(steps.map((s) => s.label)).toEqual(Array.from({ length: SIM_SCREEN.back }, (_, k) => `step ${k + 2}`));
  });

  it("read back from storage — the plant as it stood is null, anything unreadable is left out", () => {
    const kept = JSON.stringify([step(0), step(1), { label: 3, before: null }, { label: "x", before: [1] }, { label: "y" }, "z"]);
    expect(parseSteps(kept)).toEqual([step(0), step(1)]);
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps("{not json")).toEqual([]);
    expect(parseSteps(JSON.stringify({ label: "a", before: null }))).toEqual([]);
  });
});
