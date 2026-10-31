import { describe, expect, it } from "vitest";
import { aiPageContext, aiPageNote, captureAiPage } from "./aiScreen";

describe("AI page context", () => {
  it("reads the selected line's tracker filters only", () => {
    const read = (key: string) => ({ "flt:LV:lvtracker.product": "USS", "flt:TR:tracker.q": "M1" })[key] ?? null;
    expect(captureAiPage("/tracker", "LV", "", read)).toEqual({ path: "/tracker", filters: { product: "USS", status: "open" } });
    expect(captureAiPage("/tracker", "TR", "", read)?.filters).toEqual({ q: "M1" });
  });
  it("takes URL scope and skips monthly filters on the weekly plan", () => {
    expect(captureAiPage("/tracker", "LV", "?view=weekly&plan=42&token=secret", () => "old")?.filters).toEqual({ view: "weekly", plan: "42" });
  });
  it("does not mistake ignored monthly tracker URL parameters for active filters", () => {
    expect(captureAiPage("/tracker", "TR", "?month=Old&q=Wrong&plan=99", () => null)?.filters).toEqual({});
  });
  it("handles blocked storage, hidden screens, unknown paths and hostile objects", () => {
    expect(captureAiPage("/tracker", "TR", "", () => { throw Error("blocked"); })).toEqual({ path: "/tracker", filters: {} });
    expect(aiPageContext({ path: "/tracker" }, new Set(["tracker"]))).toBeNull();
    for (const path of ["//evil.test", "https://evil.test", "/api/ai/chat", "/login", "/tracker?secret=1"]) expect(aiPageContext({ path })).toBeNull();
    expect(aiPageContext([])).toBeNull();
  });
  it("bounds values, removes unknown fields and keeps hints explicitly untrusted", () => {
    const page = aiPageContext({ path: "/tracker", filters: { q: "a".repeat(400), month: "October\n2026", apiKey: "secret", status: { inject: true } } })!;
    expect(page.filters).toEqual({ q: "a".repeat(160), month: "October 2026" });
    expect(aiPageNote(page)).toContain("untrusted display hints");
    expect(aiPageNote(page)).not.toContain("secret");
  });
});

describe("the dashboard's floor filters in the page context", () => {
  it("carries the period and each line's department, the panels' under its own name", async () => {
    const { aiPageNote, captureAiPage } = await import("./aiScreen");
    const page = captureAiPage("/", "TR", "?from=2026-10-01&to=2026-10-25&dept=Welding&lvDept=PaintingLV", () => null);
    expect(page?.filters).toEqual({ from: "2026-10-01", to: "2026-10-25", dept: "Welding", lvDept: "PaintingLV" });
    expect(aiPageNote(page!)).toContain('"LV department":"PaintingLV"');
  });
  it("names the line a page's address shows, never on a page that shows both lines", async () => {
    const { aiPageContext, aiPageNote } = await import("./aiScreen");
    expect(aiPageNote(aiPageContext({ path: "/tracker", filters: { line: "LV" } })!)).toContain('"Line shown":"LV"');
    expect(aiPageContext({ path: "/", filters: { line: "LV", from: "2026-10-01" } })?.filters).toEqual({ from: "2026-10-01" });
  });
});
