import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// A list item that opens on a bold lead reads as two lines: the lead, clear,
// and what it means under it. A list every item of which is "**Label:**
// value" is a panel of fields.

vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { AiMarkdown } from "@/components/AiMarkdown";

const html = (text: string) => renderToStaticMarkup(createElement(AiMarkdown, { text }));

describe("a numbered step that opens on a bold lead", () => {
  it("sets the lead apart from what follows it, with or without its colon", () => {
    const out = html("1. **Check the Daily log** for the hours\n2. **Record attendance:** every day");
    expect(out).toContain('<span class="ai-field-label"><span dir="ltr">Check the Daily log</span></span><span class="ai-field-value"><span dir="ltr">for the hours</span></span>');
    expect(out).toContain('<span class="ai-field-label"><span dir="ltr">Record attendance</span></span><span class="ai-field-value"><span dir="ltr">every day</span></span>');
  });
  it("drops the dash that tied the lead to its words, but not a figure's sign", () => {
    expect(html("1. **Cut** — 94% done\n2. x")).toContain('<span class="ai-field-value"><span dir="ltr">94% done</span></span>');
    expect(html("1. **Change:** -5%\n2. x")).toContain('<span class="ai-field-value"><span dir="ltr">-5%</span></span>');
  });
  it("reads an Arabic lead in its own direction", () => {
    expect(html("1. **راجعوا الـ Daily log** للتصنيع\n2. x")).toContain('<span class="ai-field-label"><span dir="rtl">راجعوا الـ Daily log</span></span>');
  });
  it("leaves an item alone that is all bold, or does not open on bold", () => {
    const out = html("1. **All of it bold**\n2. Some **bold** inside\n3. **Done**.");
    expect(out).not.toContain("ai-field-label");
  });
});

describe("a bullet that opens in bold", () => {
  it("is a lead when a colon or a dash ties it to its words", () => {
    expect(html("- **Cut:** 94% done\n- plain")).toContain('<span class="ai-field-label"><span dir="ltr">Cut</span></span>');
    expect(html("- **Cut** — 94% done\n- plain")).toContain('<span class="ai-field-label"><span dir="ltr">Cut</span></span>');
  });
  it("is the start of its sentence when nothing ties it", () => {
    expect(html("- **3 MOs** are late by 2 days\n- plain")).not.toContain("ai-field-label");
  });
});

describe("a list of fields", () => {
  it("is a panel of fields", () => {
    expect(html("- **Date:** Thu 29 Oct\n- **Qty:** 18")).toContain('<ul role="list" class="ai-fields">');
  });
});
