import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Meter } from "@/components/Meter";

const draw = (props: Parameters<typeof Meter>[0]) => renderToStaticMarkup(createElement(Meter, props));

describe("Meter", () => {
  it("fills to its share on a track of its colour", () => {
    const html = draw({ value: 0.4, color: "var(--ok-fg)" });
    expect(html).toContain('class="meter meter-md"');
    expect(html).toContain("--meter-color:var(--ok-fg)");
    expect(html).toContain("width:40%");
  });
  it("never fills past its whole or below empty", () => {
    expect(draw({ value: 1.7 })).toContain("width:100%");
    expect(draw({ value: -0.2 })).toContain("width:0%");
    expect(draw({ value: Number.NaN })).toContain("width:0%");
  });
  it("draws a tick only when it has a mark, clamped like the fill", () => {
    expect(draw({ value: 0.5 })).not.toContain("meter-mark");
    expect(draw({ value: 0.5, mark: 0.8 })).toContain("calc(80% - 1px)");
    expect(draw({ value: 0.5, mark: 3 })).toContain("calc(100% - 1px)");
  });
  it("is a named meter with a label and hidden from a screen reader without one", () => {
    const named = draw({ value: 0.25, label: "Share of the job cut" });
    expect(named).toContain('role="meter"');
    expect(named).toContain('aria-label="Share of the job cut"');
    expect(named).toContain('aria-valuenow="25"');
    expect(draw({ value: 1, label: "Done", valueText: "150%" })).toContain('aria-valuetext="150%"');
    const plain = draw({ value: 0.25 });
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain("role=");
  });
  it("takes a size and the caller's class", () => {
    expect(draw({ value: 0.1, size: "lg", className: "mt-1" })).toContain('class="meter meter-lg mt-1"');
  });
});
