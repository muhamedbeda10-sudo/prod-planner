import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// A file the assistant made is a button in the chat it was made in, and
// plain text wherever the answer is read away from it — the file is the
// asker's alone.

vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { AiMarkdown } from "@/components/AiMarkdown";

const answer = "Done: [Download plan.xlsx](/api/ai/files/12) · [Print](/ai/print/12)";

describe("the assistant's file links", () => {
  it("are download and print buttons in the person's own chat", () => {
    const html = renderToStaticMarkup(createElement(AiMarkdown, { text: answer }));
    expect(html).toMatch(/<a href="\/api\/ai\/files\/12" download="" class="no-print btn/);
    expect(html).toMatch(/<a href="\/ai\/print\/12" target="_blank" rel="noopener" class="no-print btn/);
  });
  it("are plain text in an answer shared onward", () => {
    const html = renderToStaticMarkup(createElement(AiMarkdown, { text: answer, shared: true }));
    expect(html).not.toContain("href=");
    expect(html).toContain("Download plan.xlsx");
  });
});
