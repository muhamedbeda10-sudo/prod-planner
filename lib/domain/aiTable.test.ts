import { describe, expect, it } from "vitest";
import { calloutOf, columnKind, groupedFigure, sectionOf, withoutCalloutMark, withoutLeadingEmoji } from "./aiTable";

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
  it("reads a tip or a note as an info callout", () => {
    expect(calloutOf("💡 Run the 3 mm first")).toBe("info");
    expect(calloutOf("ℹ️ Fridays excluded")).toBe("info");
    expect(withoutCalloutMark("💡 Run the 3 mm first")).toBe("Run the 3 mm first");
    expect(withoutCalloutMark("ℹ️ Fridays excluded")).toBe("Fridays excluded");
  });
});

describe("sectionOf", () => {
  it("reads what a section is about off its heading, in English and in Arabic", () => {
    expect(sectionOf("Summary")).toBe("summary");
    expect(sectionOf("الخلاصة")).toBe("summary");
    expect(sectionOf("Suggestions")).toBe("suggestions");
    expect(sectionOf("اقتراحات")).toBe("suggestions");
    expect(sectionOf("Next steps")).toBe("next");
    expect(sectionOf("الخطوات الجاية")).toBe("next");
    expect(sectionOf("Why it is late")).toBe("causes");
    expect(sectionOf("Late orders")).toBe("risks");
    expect(sectionOf("الأسباب")).toBe("causes");
    expect(sectionOf("Risks")).toBe("risks");
    expect(sectionOf("Material")).toBe("material");
    expect(sectionOf("الجودة")).toBe("quality");
    expect(sectionOf("Load vs capacity")).toBe("status");
    expect(sectionOf("Details")).toBe("details");
    expect(sectionOf("ملاحظات")).toBe("notes");
    expect(sectionOf("Summary of late orders")).toBe("summary");
    expect(sectionOf("خطة الإنتاج")).toBe("schedule");
    expect(sectionOf("الحمل عليه")).toBe("status");
  });
  it("looks past a leading emoji, and names the rest other", () => {
    expect(sectionOf("📊 Figures")).toBe("figures");
    expect(sectionOf("💡 Suggestions")).toBe("suggestions");
    expect(sectionOf("Tank line")).toBe("other");
    expect(sectionOf("")).toBe("other");
  });
  it("takes a leading emoji off a heading, and nothing else", () => {
    expect(withoutLeadingEmoji("📊 Figures")).toBe("Figures");
    expect(withoutLeadingEmoji("⚠️ Risks")).toBe("Risks");
    expect(withoutLeadingEmoji("1️⃣ First")).toBe("First");
    expect(withoutLeadingEmoji("1. First")).toBe("1. First");
    expect(withoutLeadingEmoji("MO 4471 ✅")).toBe("MO 4471 ✅");
  });
});
