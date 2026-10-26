import { describe, expect, it } from "vitest";
import { calloutOf, columnKind, groupedFigure, withoutCalloutMark } from "./aiTable";

describe("figures in an answer's table", () => {
  it("reads a column's kind off its head", () => {
    expect(columnKind("MO")).toBe("id");
    expect(columnKind("BOM code")).toBe("id");
    expect(columnKind("رقم الأمر")).toBe("id");
    expect(columnKind("Badge no.")).toBe("id");
    expect(columnKind("Year")).toBe("year");
    expect(columnKind("Due date")).toBe("year");
    expect(columnKind("Week")).toBe("year");
    expect(columnKind("Pieces")).toBe("amount");
    expect(columnKind("Plan qty")).toBe("amount");
    expect(columnKind("Order qty")).toBe("amount");
    expect(columnKind("Number of pieces")).toBe("amount");
    expect(columnKind("")).toBe("unknown");
  });
  it("groups amounts by their column, leaves names and bare years", () => {
    expect(groupedFigure("12340", "amount")).toBe("12,340");
    expect(groupedFigure("12340.5 pcs", "unknown")).toBe("12,340.5 pcs");
    expect(groupedFigure("-12340", "amount")).toBe("-12,340");
    expect(groupedFigure("12340%", "amount")).toBe("12,340%");
    expect(groupedFigure("12340", "id")).toBeNull();
    expect(groupedFigure("2026", "unknown")).toBeNull();
    expect(groupedFigure("2026", "year")).toBeNull();
    expect(groupedFigure("2026", "amount")).toBe("2,026");
    // no head: a four-digit figure may be an MO
    expect(groupedFigure("4471", "unknown")).toBeNull();
    expect(groupedFigure("44710", "unknown")).toBe("44,710");
    expect(groupedFigure("999", "amount")).toBeNull();
    expect(groupedFigure("1,234", "amount")).toBeNull();
    expect(groupedFigure("MO 4471", "amount")).toBeNull();
  });
  it("reads a callout's tone off its first mark only", () => {
    expect(calloutOf("  ⚠️ Doubt this")).toBe("warn");
    expect(calloutOf("⚠ Doubt this")).toBe("warn");
    expect(calloutOf("✅ Fine")).toBe("ok");
    expect(calloutOf("🚫 Stop")).toBe("bad");
    expect(calloutOf("❌ Problem")).toBe("bad");
    expect(calloutOf("Fine ✅")).toBeNull();
    expect(withoutCalloutMark("\n❌ Problem")).toBe("Problem");
    expect(withoutCalloutMark("  ⚠️ Doubt this")).toBe("Doubt this");
    expect(withoutCalloutMark("🚫 Stop")).toBe("Stop");
  });
});
