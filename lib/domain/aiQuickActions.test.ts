import { describe, expect, it } from "vitest";
import { AI_QUICK_ACTIONS, composeQuickQuestion, periodText, quickActionsFor } from "./aiQuickActions";

describe("the assistant's quick actions", () => {
  it("each has a unique id, and every select's default is one of its options", () => {
    const ids = AI_QUICK_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of AI_QUICK_ACTIONS) {
      for (const f of a.fields) {
        if (f.type === "select") expect(f.options?.map((o) => o.value)).toContain(f.defaultValue);
      }
    }
  });

  it("shows the automation tile only to whoever may make automations", () => {
    expect(quickActionsFor({ automations: false }).some((a) => a.id === "automation")).toBe(false);
    expect(quickActionsFor({ automations: true }).some((a) => a.id === "automation")).toBe(true);
  });

  it("writes a question for every tile but scan, from its form's defaults", () => {
    for (const a of AI_QUICK_ACTIONS) {
      const defaults = Object.fromEntries(a.fields.map((f) => [f.name, f.defaultValue ?? ""]));
      const q = composeQuickQuestion(a.id, { ...defaults, change: "عامل زيادة", by: "2026-11-15", what: "MOs من غير خامة", mo: "MO/123", kva: "1000", qty: "20" });
      if (a.id === "scan") expect(q).toBeNull();
      else expect(q?.length).toBeGreaterThan(20);
    }
  });

  it("asks what looks wrong from what the app still keeps", () => {
    const q = composeQuickQuestion("problems");
    expect(q).toContain("hold");
    expect(q).toContain("ODOO log");
    expect(q).not.toContain("المراقبة");
  });

  it("writes the report from what was picked", () => {
    const q = composeQuickQuestion("report", { topic: "stops", period: "last7", dept: "Welding", line: "LV", compare: "plan", format: "excel", notes: "  by   shift " });
    expect(q).toContain("توقفات الماكينات");
    expect(q).toContain("آخر 7 أيام");
    expect(q).toContain("لقسم Welding");
    expect(q).toContain("الـ LV");
    expect(q).toContain("بالخطة");
    expect(q).toContain("ملف Excel");
    expect(q).toContain("ملاحظات: by shift");
  });

  it("leaves the line to the screen and every department when not picked", () => {
    const q = composeQuickQuestion("report", { topic: "output", period: "month", dept: "all", line: "screen", compare: "none", format: "summary" })!;
    expect(q).toContain("لكل الأقسام");
    expect(q).not.toContain("TR");
    expect(q).not.toContain("ملاحظات");
  });

  it("needs what a form cannot do without", () => {
    expect(composeQuickQuestion("whatif", { change: "   " })).toBeNull();
    expect(composeQuickQuestion("deadline", { by: "next week" })).toBeNull();
    expect(composeQuickQuestion("deadline", { by: "2026-02-30" })).toBeNull();
    expect(composeQuickQuestion("automation", {})).toBeNull();
    expect(composeQuickQuestion("deadline", { by: "2026-11-15" })).toContain("الأوردرات المتأخرة");
  });
});

describe("the planner's tiles", () => {
  it("asks for the station and rule picked", () => {
    const q = composeQuickQuestion("dispatch", { station: "finish", rule: "EDD" })!;
    expect(q).toContain("الدهان");
    expect(q).toContain("EDD");
    expect(composeQuickQuestion("dispatch", {})).toContain("النسبة الحرجة");
    expect(composeQuickQuestion("io", { station: "cut", weeks: "8" })).toContain("آخر 8 أسابيع");
    expect(composeQuickQuestion("load", { weeks: "2" })).toContain("الأسبوعين");
    expect(composeQuickQuestion("learn", { idea: "dbr" })).toContain("DBR");
    expect(composeQuickQuestion("stock", {})).toContain("رصيد الأودو");
  });
  it("a rush order needs a rating, a whole quantity and a real date", () => {
    expect(composeQuickQuestion("rush", { kva: "1000", qty: "20", by: "2026-11-15" })).toContain("20 محول 1000 kVA");
    expect(composeQuickQuestion("rush", { kva: "1000", qty: "twenty", by: "2026-11-15" })).toBeNull();
    expect(composeQuickQuestion("rush", { kva: "1000", qty: "0", by: "2026-11-15" })).toBeNull();
    expect(composeQuickQuestion("rush", { kva: "", qty: "5", by: "2026-11-15" })).toBeNull();
    expect(composeQuickQuestion("rush", { kva: "1000", qty: "5", by: "soon" })).toBeNull();
  });
  it("tracing or releasing an order needs the order", () => {
    expect(composeQuickQuestion("late", { mo: "  " })).toBeNull();
    expect(composeQuickQuestion("release", {})).toBeNull();
    expect(composeQuickQuestion("late", { mo: "MO/77" })).toContain("MO/77");
    expect(composeQuickQuestion("release", { mo: "MO/77" })).toContain("الـ nesting");
  });
});

describe("periodText", () => {
  it("reads the dates over the period, in order", () => {
    expect(periodText({ period: "week", from: "2026-10-26", to: "2026-10-01" })).toBe("من 2026-10-01 لـ 2026-10-26");
    expect(periodText({ period: "week", from: "2026-10-01" })).toBe("من 2026-10-01 لحد النهارده");
    expect(periodText({ to: "2026-10-01" })).toBe("لحد 2026-10-01");
  });
  it("reads the period picked, this month by default", () => {
    expect(periodText({ period: "yesterday" })).toBe("إمبارح");
    expect(periodText({ period: "bogus" })).toBe("الشهر ده");
    expect(periodText({ period: "week", from: "26/10/2026" })).toBe("الأسبوع ده");
  });
});
