import { describe, expect, it } from "vitest";
import { compactHistory, foldedResult } from "./aiHistory";

const big = JSON.stringify({ data: { columns: ["mo"], rows: Array.from({ length: 400 }, (_, i) => [i]) }, source: { id: "r1", citation: "#ai-source-r1" } });
const q = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const sys = { role: "system", content: "context" };
const call = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "query_database", input: {} }] });
const result = (id: string, content: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] });
const answer = { role: "assistant", content: [{ type: "text", text: "Ten." }] };

describe("folding an old chat's look-ups", () => {
  it("folds big results of all but the last questions, keeping their source", () => {
    const chat = [q("One?"), sys, call("a"), result("a", big), answer, q("Two?"), sys, call("b"), result("b", big), answer, q("Three?"), sys, call("c"), result("c", big), answer];
    const out = compactHistory(chat);
    const folded = JSON.parse((out[3].content as { content: string }[])[0].content) as { data: string; source: { citation: string } };
    expect(folded.data).toContain("omitted");
    expect(folded.source.citation).toBe("#ai-source-r1");
    // the last two questions go in full
    expect(out[8]).toBe(chat[8]);
    expect(out[13]).toBe(chat[13]);
    // nothing else changes, and the kept rows are not touched
    expect(out[0]).toBe(chat[0]);
    expect((chat[3].content as { content: string }[])[0].content).toBe(big);
  });
  it("leaves short results, text and a short chat alone", () => {
    const chat = [q("One?"), sys, call("a"), result("a", "Nothing is late."), answer, q("Two?"), sys, answer, q("Three?"), sys, answer];
    expect(compactHistory(chat)).toEqual(chat);
    expect(compactHistory([q("One?"), sys, call("a"), result("a", big), answer])).toEqual([q("One?"), sys, call("a"), result("a", big), answer]);
  });
  it("folds a plain result to a note", () => {
    expect(foldedResult("x".repeat(2000))).toMatch(/^\(omitted: 2,000 characters/);
  });
});
