import { describe, expect, it } from "vitest";
import { checkRule, describeRule, machineVerdict, ruleMatches, ruleSentence, type MachineRuleLike, type WorkFacts } from "./machineRules";

const rule = (o: Partial<MachineRuleLike>): MachineRuleLike => ({
  id: 1, machineId: 1, effect: "only", item: null, line: null, minThicknessMm: null, maxThicknessMm: null, material: null, minKva: null, maxKva: null, note: null, ...o,
});
const work = (o: Partial<WorkFacts> = {}): WorkFacts => ({ item: "TN", line: "TR", kva: 1000, thicknessesMm: [3, 5], materials: ["Steel"], ...o });

describe("ruleMatches", () => {
  it("needs every given field to match", () => {
    expect(ruleMatches(rule({ item: "TN", line: "TR" }), work())).toBe(true);
    expect(ruleMatches(rule({ item: "TC" }), work())).toBe(false);
    expect(ruleMatches(rule({ minKva: 1500 }), work())).toBe(false);
    expect(ruleMatches(rule({ minKva: 500, maxKva: 1000 }), work())).toBe(true);
    expect(ruleMatches(rule({}), work())).toBe(true);
  });
  it("matches a thickness range only when every sheet is inside it", () => {
    expect(ruleMatches(rule({ minThicknessMm: 3 }), work())).toBe(true);
    expect(ruleMatches(rule({ minThicknessMm: 4 }), work())).toBe(false);
    expect(ruleMatches(rule({ maxThicknessMm: 5 }), work())).toBe(true);
  });
  it("cannot tell for a line not nested yet", () => {
    expect(ruleMatches(rule({ minThicknessMm: 6 }), work({ thicknessesMm: [], materials: [] }))).toBeNull();
    expect(ruleMatches(rule({ material: "steel" }), work({ materials: [] }))).toBeNull();
    // but an item that does not match is a plain no
    expect(ruleMatches(rule({ item: "TC", minThicknessMm: 6 }), work({ thicknessesMm: [] }))).toBe(false);
  });
  it("reads the material without minding case or spacing", () => {
    expect(ruleMatches(rule({ material: "stainless  steel" }), work({ materials: ["Stainless steel"] }))).toBe(true);
  });
});

describe("machineVerdict", () => {
  it("never wins over everything, and says why in the planner's words", () => {
    const v = machineVerdict([rule({ effect: "prefer", item: "TN" }), rule({ effect: "never", material: "Stainless steel", note: "no stainless on the old laser" })], work({ materials: ["Stainless steel"] }));
    expect(v).toEqual({ allowed: false, preferred: false, why: "no stainless on the old laser" });
  });
  it("a machine with only-rules takes just what one of them matches", () => {
    const rules = [rule({ effect: "only", minThicknessMm: 6 }), rule({ effect: "only", item: "TC" })];
    expect(machineVerdict(rules, work({ thicknessesMm: [6, 8] })).allowed).toBe(true);
    expect(machineVerdict(rules, work({ item: "TC" })).allowed).toBe(true);
    expect(machineVerdict(rules, work()).allowed).toBe(false);
    expect(machineVerdict(rules, work({ thicknessesMm: [] })).why).toContain("not nested yet");
  });
  it("a never-rule that turns on an unknown thickness does not keep the line off", () => {
    expect(machineVerdict([rule({ effect: "never", maxThicknessMm: 2 })], work({ thicknessesMm: [] })).allowed).toBe(true);
  });
  it("prefers when a prefer rule matches", () => {
    expect(machineVerdict([rule({ effect: "prefer", minKva: 1000 })], work())).toEqual({ allowed: true, preferred: true, why: null });
  });
});

describe("a rule in words", () => {
  it("reads as the planner would say it", () => {
    expect(describeRule(rule({ item: "TN", minThicknessMm: 6, maxThicknessMm: 12, material: "Steel", minKva: 1000 }))).toBe("TN, 6–12 mm, Steel, 1000 kVA and up");
    expect(ruleSentence("B4-10", rule({ effect: "never", line: "LV" }))).toBe("B4-10 never takes LV panels");
    expect(ruleSentence("P-01", rule({ effect: "prefer", maxThicknessMm: 3 }))).toBe("P-01 goes first for up to 3 mm");
  });
});

describe("checkRule", () => {
  it("cleans a rule and refuses one that says nothing or contradicts itself", () => {
    expect(checkRule({ effect: "only", item: "tn", material: " Steel " })).toEqual({ ok: true, rule: { effect: "only", item: "TN", line: null, minThicknessMm: null, maxThicknessMm: null, material: "Steel", minKva: null, maxKva: null, note: null } });
    expect(checkRule({ effect: "only" })).toMatchObject({ ok: false });
    expect(checkRule({ effect: "never" })).toMatchObject({ ok: false });
    expect(checkRule({ effect: "prefer" })).toMatchObject({ ok: true });
    expect(checkRule({ effect: "only", minThicknessMm: 8, maxThicknessMm: 3 })).toEqual({ ok: false, error: "The lowest thickness is above the highest." });
    expect(checkRule({ effect: "maybe", item: "TN" })).toMatchObject({ ok: false });
    expect(checkRule({ effect: "only", item: "XX" })).toEqual({ ok: false, error: "Unknown item XX." });
  });
  it("writes the material as the MATERIAL tab does, so the rule meets the nesting's name", () => {
    expect(checkRule({ effect: "never", material: "ss" })).toMatchObject({ ok: true, rule: { material: "Stainless steel" } });
    expect(checkRule({ effect: "never", material: "  gi " })).toMatchObject({ ok: true, rule: { material: "Galvanized steel" } });
    expect(checkRule({ effect: "never", material: "brass" })).toMatchObject({ ok: true, rule: { material: "Brass" } });
  });
});
