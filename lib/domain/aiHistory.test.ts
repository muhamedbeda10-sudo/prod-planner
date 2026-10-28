import { describe, expect, it } from "vitest";
import { compactHistory, foldedResult, readContent, withoutLegacySource } from "./aiHistory";

const rows = { columns: ["mo"], rows: Array.from({ length: 400 }, (_, i) => [i]) };
const big = JSON.stringify(rows);
// a read kept from when answers cited their sources
const legacy = JSON.stringify({ data: rows, source: { id: "r1", citation: "#ai-source-r1", links: [] } });
const q = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const sys = { role: "system", content: "context" };
const call = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "query_database", input: {} }] });
const result = (id: string, content: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] });
const answer = { role: "assistant", content: [{ type: "text", text: "Ten." }] };
const contentOf = (m: { content: unknown }) => (m.content as { content: string }[])[0].content;

describe("folding an old chat's look-ups", () => {
  it("folds big results of all but the last questions to a note", () => {
    const chat = [q("One?"), sys, call("a"), result("a", big), answer, q("Two?"), sys, call("b"), result("b", big), answer, q("Three?"), sys, call("c"), result("c", big), answer];
    const out = compactHistory(chat);
    expect(contentOf(out[3])).toMatch(/^\(omitted: /);
    // the last two questions go in full
    expect(out[8]).toBe(chat[8]);
    expect(out[13]).toBe(chat[13]);
    // nothing else changes, and the kept rows are not touched
    expect(out[0]).toBe(chat[0]);
    expect(contentOf(chat[3])).toBe(big);
  });
  it("leaves short results, text and a short chat alone", () => {
    const chat = [q("One?"), sys, call("a"), result("a", "Nothing is late."), answer, q("Two?"), sys, answer, q("Three?"), sys, answer];
    expect(compactHistory(chat)).toEqual(chat);
    expect(compactHistory([q("One?"), sys, call("a"), result("a", big), answer])).toEqual([q("One?"), sys, call("a"), result("a", big), answer]);
  });
  it("sends a read kept with a source to cite without it — folded or in full — so no citation reaches the model", () => {
    const chat = [q("One?"), sys, call("a"), result("a", legacy), answer, q("Two?"), sys, call("b"), result("b", legacy), answer];
    const out = compactHistory(chat, { keepQuestions: 1 });
    expect(contentOf(out[3])).toMatch(/^\(omitted: /);
    expect(contentOf(out[8])).toBe(big);
    expect(JSON.stringify(out)).not.toContain("ai-source-");
  });
  it("folds a plain result to a note", () => {
    expect(foldedResult("x".repeat(2000))).toMatch(/^\(omitted: 2,000 characters/);
  });
});

describe("what a read sends the model", () => {
  it("is the tool's own text, with the app's links beside its data when it has any", () => {
    expect(readContent('{"remaining":6}', [])).toEqual({ content: '{"remaining":6}', data: { remaining: 6 } });
    expect(JSON.parse(readContent('{"remaining":6}', [{ label: "MO A", href: "/trace?mo=A" }]).content)).toEqual({ data: { remaining: 6 }, links: [{ label: "MO A", href: "/trace?mo=A" }] });
    expect(JSON.parse(readContent("No orders.", [{ label: "Tracker", href: "/tracker" }]).content)).toEqual({ data: "No orders.", links: [{ label: "Tracker", href: "/tracker" }] });
    // a sentence is its own data; broken JSON stays as it came
    expect(readContent("{ not json", []).data).toBe("{ not json");
  });
  it("drops an old read's source wrapper and citation, keeping its data and links", () => {
    expect(withoutLegacySource(legacy)).toBe(big);
    const linked = JSON.stringify({ data: "Six left.", source: { id: "r2", citation: "#ai-source-r2", links: [{ label: "MO A", href: "/trace?mo=A" }] } });
    expect(JSON.parse(withoutLegacySource(linked))).toEqual({ data: "Six left.", links: [{ label: "MO A", href: "/trace?mo=A" }] });
    expect(withoutLegacySource(JSON.stringify({ data: "Plain", source: { id: "r3", citation: "#ai-source-r3" } }))).toBe("Plain");
    // anything else goes as it is
    expect(withoutLegacySource(big)).toBe(big);
    expect(withoutLegacySource("see #ai-source-x in text")).toBe("see #ai-source-x in text");
  });
});
