import { describe, expect, it } from "vitest";
import { AI_CHATS_BULK_MAX, AI_DEFAULT_SUGGESTIONS, chatIdsOf, chatTextOf, depthPlan, followupsOf, hasPageSuggestions, scopeLineOf, suggestionsFor, withoutFollowups, withoutSourceLinks } from "./aiAnswer";

describe("follow-up questions in an answer", () => {
  it("reads the JSON list of the last followups block, at most three, no duplicates", () => {
    const text = 'Done.\n\n```followups\n["إيه اللي واقف في اللحام؟", "Which tanks failed?", "which tanks failed?", "Four", "Five"]\n```\n';
    expect(followupsOf(text)).toEqual(["إيه اللي واقف في اللحام؟", "Which tanks failed?", "Four"]);
  });
  it("takes one question a line when the brackets are missing, and ignores anything else", () => {
    expect(followupsOf("```followups\n- Why?\n2. How?\n```")).toEqual(["Why?", "How?"]);
    expect(followupsOf('```followups\n{"a":1}\n```')).toEqual([]);
    expect(followupsOf("no block")).toEqual([]);
  });
  it("strips the block from what is printed, and a half-written one while streaming", () => {
    expect(withoutFollowups('Answer.\n\n```followups\n["A"]\n```\n')).toBe("Answer.");
    expect(withoutFollowups("Answer.\n\n```followups\n[\"A\"", true)).toBe("Answer.");
    expect(withoutFollowups("Answer.\n\n```chart\n{}\n```", true)).toBe("Answer.\n\n```chart\n{}\n```");
  });
});

describe("the scope line", () => {
  it("reads a Scope line, in either language, and nothing else", () => {
    expect(scopeLineOf("Scope: TR · 1–26 Oct · read 14:32")).toBe("TR · 1–26 Oct · read 14:32");
    expect(scopeLineOf("**النطاق:** TR · أكتوبر")).toBe("TR · أكتوبر");
    expect(scopeLineOf("The scope of the plan is wide.")).toBeNull();
    expect(scopeLineOf(`Scope: ${"x".repeat(201)}`)).toBeNull();
  });
  it("takes the chat's source links out of a shared answer", () => {
    expect(withoutSourceLinks("Ten late ([Source](#ai-source-a)). See [the order](/trace?mo=1).")).toBe("Ten late. See [the order](/trace?mo=1).");
  });
  it("drops a follow-up longer than a line", () => {
    expect(followupsOf(`\`\`\`followups\n["${"x".repeat(161)}", "Short"]\n\`\`\``)).toEqual(["Short"]);
  });
});

describe("the depth of a question", () => {
  it("Standard takes the model routed for the question at medium effort", () => {
    expect(depthPlan("standard", { routed: "claude-haiku-5-5", maxCalls: 14 })).toEqual({ model: "claude-haiku-5-5", effort: "medium", maxCalls: 14 });
    expect(depthPlan("standard", { routed: "claude-opus-5-5", maxCalls: 14 })).toEqual({ model: "claude-opus-5-5", effort: "medium", maxCalls: 14 });
  });
  it("Quick takes the cheapest model at low effort", () => {
    expect(depthPlan("quick", { routed: "claude-opus-5-5", maxCalls: 14 })).toEqual({ model: "claude-haiku-5-5", effort: "low", maxCalls: 14 });
  });
  it("Deep takes the strongest model at high effort with half again the calls, up to the cap", () => {
    expect(depthPlan("deep", { routed: "claude-haiku-5-5", maxCalls: 14 })).toEqual({ model: "claude-opus-5-5", effort: "high", maxCalls: 21 });
    expect(depthPlan("deep", { routed: "claude-haiku-5-5", maxCalls: 28 }).maxCalls).toBe(30);
  });
  it("falls back to an offered model for a routed one the app no longer offers", () => {
    expect(depthPlan("standard", { routed: "claude-3-retired", maxCalls: 14 }).model).toBe("claude-opus-5-5");
  });
});

describe("the suggestions on an empty chat", () => {
  it("puts the screen's own questions first, then the defaults, six in all", () => {
    const s = suggestionsFor("worklist.painting");
    expect(s[0]).toContain("الدهان");
    expect(s).toHaveLength(6);
    expect(new Set(s).size).toBe(6);
    expect(suggestionsFor(null)).toEqual(AI_DEFAULT_SUGGESTIONS);
    expect(hasPageSuggestions("worklist.painting")).toBe(true);
    expect(hasPageSuggestions("analytics")).toBe(false);
    expect(hasPageSuggestions(null)).toBe(false);
    expect(suggestionsFor("nowhere", 4)).toEqual(AI_DEFAULT_SUGGESTIONS.slice(0, 4));
  });
});

describe("an answer as the team chat takes it", () => {
  it("drops charts, follow-ups and source links, and flattens tables and marks", () => {
    const md = "**Ten late** ([Source](#ai-source-a)).\n\n| MO | Days |\n|---|---:|\n| 4471 | 3 |\n\n```chart\n{\"type\":\"kpi\"}\n```\n\n> ⚠️ Check it\n\n```followups\n[\"Why?\"]\n```";
    expect(chatTextOf(md)).toBe("Ten late.\n\nMO · Days\n4471 · 3\n\n⚠️ Check it");
  });
});

describe("chatIdsOf", () => {
  it("keeps whole positive ids once each and drops the rest", () => {
    expect(chatIdsOf([3, 3, 7, 0, -2, 1.5, "4", null, Number.NaN, 9])).toEqual([3, 7, 9]);
  });
  it("reads nothing from what is not a list", () => {
    expect(chatIdsOf("1,2")).toEqual([]);
    expect(chatIdsOf(undefined)).toEqual([]);
  });
  it("stops at the bulk limit", () => {
    const many = Array.from({ length: AI_CHATS_BULK_MAX + 50 }, (_, i) => i + 1);
    expect(chatIdsOf(many)).toHaveLength(AI_CHATS_BULK_MAX);
  });
});
