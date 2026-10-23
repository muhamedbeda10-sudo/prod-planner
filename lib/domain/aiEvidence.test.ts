import { describe, expect, it } from "vitest";
import { displayTurns } from "./ai";
import { evidenceFromContent, isAiEvidence, isEvidenceAnchor, readEvidence } from "./aiEvidence";

const at = "2026-10-24T08:00:00Z";
describe("saved answer evidence", () => {
  it("preserves numerical results and restores them beside the correct answer", () => {
    const { content, evidence } = readEvidence("tool_1", "Filtered plan", '{"required":10,"complete":4}', [{ label: "MO A", href: "/trace?mo=A&line=LV" }], at);
    expect(JSON.parse(content)).toMatchObject({ data: { required: 10, complete: 4 }, source: { citation: "#ai-source-tool_1" } });
    expect(evidenceFromContent(content, "tool_1")).toEqual(expect.objectContaining(evidence));
    const turns = displayTurns([
      { role: "user", content: "Plan?" },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "get_tracker_summary", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content }] },
      { role: "assistant", content: "4 complete [Source](#ai-source-tool_1)" },
      { role: "user", content: "Next question" },
    ]);
    expect(turns[1].sources).toEqual([expect.objectContaining(evidence)]);
    expect(turns[2].sources).toBeUndefined();
  });
  it("keeps full tool data while bounding the UI preview", () => {
    const data = "x".repeat(20_000);
    const { content, evidence } = readEvidence("tool_2", "Large result", data, [], at);
    expect(JSON.parse(content).data).toBe(data);
    expect(evidence.snapshot).toHaveLength(16_000);
    expect(evidence.truncated).toBe(true);
    expect(evidenceFromContent(content, "tool_2")).toMatchObject({ snapshot: evidence.snapshot, truncated: true });
  });
  it("rejects external or executable links and mismatched or malformed records", () => {
    const { content, evidence } = readEvidence("tool_3", "Read", "No records", ["/tracker", "//evil.test", "https://evil.test", "javascript:alert(1)", "/\\evil", "/trace\n"].map((href) => ({ href, label: "Link" })), at);
    expect(evidence.links).toEqual([{ href: "/tracker", label: "Link" }]);
    expect(isAiEvidence(evidence)).toBe(true);
    expect(isAiEvidence({ ...evidence, links: [{ label: "Bad", href: "//evil.test" }] })).toBe(false);
    expect(evidenceFromContent(content, "other")).toBeNull();
    expect(evidenceFromContent("{}", "tool_3")).toBeNull();
    expect(evidenceFromContent('{"source":null}', "tool_3")).toBeNull();
    expect(evidenceFromContent(content.replace(at, "invalid"), "tool_3")).toBeNull();
    expect(isEvidenceAnchor("#ai-source-tool_3")).toBe(true);
    expect(isEvidenceAnchor("#ai-source-<script>")).toBe(false);
  });
});
