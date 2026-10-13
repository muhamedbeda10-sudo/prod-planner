import { describe, expect, it } from "vitest";
import { checkAutomation, checkWindow, describeTrigger, describeWindow, inAutomationWindow, retimeAutomation, freshRows, nextConditionCheck, nextScheduleRun, recipientsOf, renderMessage, rowKey, rowsForPeople, type AutomationConfig } from "./automations";

const base = { name: "Morning welding report", trigger: "schedule", times: ["07:30"], days: "working", action: "report", prompt: "Welding output vs plan" } as const;
const fridayOrHoliday = (holidays: string[] = []) => (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5 || holidays.includes(iso);
const at = (iso: string) => new Date(iso);

describe("checkAutomation", () => {
  it("cleans a schedule", () => {
    const r = checkAutomation({ ...base, times: ["14:00", "07:30", "07:30"], name: "  Morning   report " });
    expect(r).toMatchObject({ ok: true, config: { name: "Morning report", times: ["07:30", "14:00"], days: "working", weekdays: [], action: "report", message: null, recipientIds: [] } });
  });

  it("refuses what cannot run, saying why", () => {
    const bad: [Parameters<typeof checkAutomation>[0], string][] = [
      [{ ...base, name: "" }, "Give the automation a name"],
      [{ ...base, times: [] }, "at least one time"],
      [{ ...base, times: ["7:30"] }, "HH:MM"],
      [{ ...base, days: "weekdays", weekdays: [] }, "Name the weekdays"],
      [{ ...base, trigger: "condition", conditionSql: "DELETE FROM \"MasterOrder\"" }, "Only a SELECT"],
      [{ ...base, trigger: "condition", conditionSql: "SELECT 1; SELECT 2" }, "One statement only"],
      [{ ...base, trigger: "condition", conditionSql: "SELECT 1", checkEveryMin: 5 }, "checked every"],
      [{ ...base, trigger: "condition", conditionSql: "SELECT 1", activeFrom: "07:00" }, "both ends"],
      [{ ...base, trigger: "condition", conditionSql: "SELECT 1", activeFrom: "19:00", activeTo: "07:00" }, "start before they end"],
      [{ ...base, action: "notify", prompt: undefined }, "Write the message"],
      [{ ...base, action: "act", recipientIds: [4] }, "owner's to approve"],
      [{ ...base, trigger: "sometimes" }, "a schedule, a condition or an event"],
    ];
    for (const [input, msg] of bad) {
      const r = checkAutomation(input);
      expect(r.ok, msg).toBe(false);
      expect(!r.ok && r.error, msg).toContain(msg);
    }
  });

  it("an act automation reports to its owner alone; a message to the people named, or the owner", () => {
    expect(recipientsOf({ action: "act", recipientIds: [] }, 7)).toEqual([7]);
    expect(recipientsOf({ action: "notify", recipientIds: [3, 4] }, 7)).toEqual([3, 4]);
    expect(recipientsOf({ action: "report", recipientIds: [] }, 7)).toEqual([7]);
  });
});

describe("the next scheduled run (Cairo time)", () => {
  const cfg = { times: ["07:30"], days: "working" as const, weekdays: [] };
  it("is today's time while it is still ahead, else the next working day's", () => {
    // Monday 12 Oct 2026, Cairo is UTC+3 (summer time)
    expect(nextScheduleRun(at("2026-10-12T04:00:00Z"), cfg, fridayOrHoliday())).toEqual(at("2026-10-12T04:30:00Z"));
    expect(nextScheduleRun(at("2026-10-12T04:30:00Z"), cfg, fridayOrHoliday())).toEqual(at("2026-10-13T04:30:00Z"));
  });
  it("skips Friday and the holidays on working days, not on every day", () => {
    const thursdayAfter = at("2026-10-15T05:00:00Z");
    expect(nextScheduleRun(thursdayAfter, cfg, fridayOrHoliday())).toEqual(at("2026-10-17T04:30:00Z"));
    expect(nextScheduleRun(thursdayAfter, cfg, fridayOrHoliday(["2026-10-17"]))).toEqual(at("2026-10-18T04:30:00Z"));
    expect(nextScheduleRun(thursdayAfter, { ...cfg, days: "every" }, fridayOrHoliday())).toEqual(at("2026-10-16T04:30:00Z"));
  });
  it("keeps to the factory clock across the end of summer time", () => {
    // Egypt goes back an hour at the end of Thursday 29 Oct 2026: UTC+2 after
    expect(nextScheduleRun(at("2026-10-31T06:00:00Z"), cfg, fridayOrHoliday())).toEqual(at("2026-11-01T05:30:00Z"));
  });
  it("runs on the weekdays named", () => {
    // Sundays and Wednesdays only
    expect(nextScheduleRun(at("2026-10-12T04:00:00Z"), { ...cfg, days: "weekdays", weekdays: [0, 3] }, fridayOrHoliday())).toEqual(at("2026-10-14T04:30:00Z"));
  });
});

describe("the next condition check", () => {
  const cfg = { checkEveryMin: 30, activeFrom: "07:00", activeTo: "19:00" };
  it("is so many minutes on, inside the working hours", () => {
    expect(nextConditionCheck(at("2026-10-12T08:00:00Z"), cfg, fridayOrHoliday())).toEqual(at("2026-10-12T08:30:00Z"));
    // 06:00 Cairo: the hours open at 07:00
    expect(nextConditionCheck(at("2026-10-12T03:00:00Z"), cfg, fridayOrHoliday())).toEqual(at("2026-10-12T04:00:00Z"));
    // 18:50 Cairo on Thursday: past the hours, Friday off — Saturday 07:00
    expect(nextConditionCheck(at("2026-10-15T15:50:00Z"), cfg, fridayOrHoliday())).toEqual(at("2026-10-17T04:00:00Z"));
  });
  it("with no working hours, any time", () => {
    expect(nextConditionCheck(at("2026-10-16T22:00:00Z"), { checkEveryMin: 60, activeFrom: null, activeTo: null }, fridayOrHoliday())).toEqual(at("2026-10-16T23:00:00Z"));
  });
});

describe("a condition's rows", () => {
  it("fire once when they start matching, and again only after they stopped", () => {
    const held = [{ key: "MO-1", mo: "MO-1" }, { key: "MO-2", mo: "MO-2" }];
    expect(freshRows([], held)).toEqual({ keys: ["MO-1", "MO-2"], fresh: held });
    expect(freshRows(["MO-1", "MO-2"], held).fresh).toEqual([]);
    // MO-1 released, then held again
    expect(freshRows(["MO-2"], held).fresh).toEqual([held[0]]);
  });
  it("are known by their key column, or as a whole", () => {
    expect(rowKey({ key: 12, x: 1 })).toBe("12");
    expect(rowKey({ mo: "A", qty: 2 })).toBe("{\"mo\":\"A\",\"qty\":2}");
  });
});

describe("a notify message", () => {
  it("fills in the blanks, and lists the rows under a message that does not place them", () => {
    const rows = [{ key: "1", mo: "MO-1", dept: "Welding" }];
    expect(renderMessage("{count} order(s) held — {name}", { name: "Held orders", rows })).toBe("1 order(s) held — Held orders\n\n- **MO:** MO-1\n- **Dept:** Welding");
    expect(renderMessage("Good morning", { name: "x" })).toBe("Good morning");
  });
});

describe("a trigger in words", () => {
  it("reads as the person set it", () => {
    const c = checkAutomation({ ...base, times: ["07:30", "14:00"] });
    expect(c.ok && describeTrigger(c.config)).toBe("every working day at 07:30, 14:00 (Cairo)");
    const cond = { trigger: "condition", checkEveryMin: 60, activeFrom: "07:00", activeTo: "19:00" } as Pick<AutomationConfig, "trigger" | "checkEveryMin" | "activeFrom" | "activeTo"> as AutomationConfig;
    expect(describeTrigger(cond)).toBe("when its query finds new rows — checked every 1 hour, 07:00–19:00 on working days");
  });
});

describe("the automations' hours", () => {
  // 2026-10-12 is a Monday; Cairo is UTC+3 in October
  const w = (o: Partial<{ from: string | null; to: string | null; weekdays: number[] }> = {}) => ({ from: "07:00", to: "19:00", weekdays: [0, 1, 2, 3, 4, 6], ...o });

  it("checks the hours and the days", () => {
    expect(checkWindow({ from: "07:00", to: "19:00", weekdays: [3, 1, 1] })).toEqual({ ok: true, window: { from: "07:00", to: "19:00", weekdays: [1, 3] } });
    expect(checkWindow({})).toEqual({ ok: true, window: { from: null, to: null, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(checkWindow({ from: "07:00" })).toMatchObject({ ok: false, error: expect.stringContaining("both ends") });
    expect(checkWindow({ from: "7:00", to: "19:00" })).toMatchObject({ ok: false, error: expect.stringContaining("HH:MM") });
    expect(checkWindow({ from: "07:00", to: "07:00" })).toMatchObject({ ok: false });
    expect(checkWindow({ weekdays: [] })).toMatchObject({ ok: false, error: expect.stringContaining("at least one day") });
    expect(checkWindow({ weekdays: [7] })).toMatchObject({ ok: false });
  });

  it("is open inside the hours on a ticked day, the end not included", () => {
    expect(inAutomationWindow(at("2026-10-12T04:00:00Z"), w())).toBe(true); // 07:00 Cairo
    expect(inAutomationWindow(at("2026-10-12T03:59:00Z"), w())).toBe(false); // 06:59
    expect(inAutomationWindow(at("2026-10-12T16:00:00Z"), w())).toBe(false); // 19:00
    expect(inAutomationWindow(at("2026-10-16T08:00:00Z"), w())).toBe(false); // a Friday
    expect(inAutomationWindow(at("2026-10-16T08:00:00Z"), w({ from: null, to: null, weekdays: [5] }))).toBe(true);
  });

  it("runs over midnight when it starts after it ends", () => {
    const night = w({ from: "22:00", to: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(inAutomationWindow(at("2026-10-12T20:00:00Z"), night)).toBe(true); // 23:00
    expect(inAutomationWindow(at("2026-10-12T01:00:00Z"), night)).toBe(true); // 04:00
    expect(inAutomationWindow(at("2026-10-12T09:00:00Z"), night)).toBe(false); // 12:00
  });

  it("reads as a person says it", () => {
    expect(describeWindow(w())).toBe("Sun, Mon, Tue, Wed, Thu, Sat · 07:00–19:00");
    expect(describeWindow({ from: null, to: null, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day · all day");
  });

  it("changes an automation's timing and nothing else", () => {
    const c = checkAutomation(base);
    if (!c.ok) throw new Error(c.error);
    const r = retimeAutomation(c.config, { times: ["09:00"], days: "weekdays", weekdays: [0, 2], checkEveryMin: 15 });
    expect(r).toMatchObject({ ok: true, config: { trigger: "schedule", times: ["09:00"], days: "weekdays", weekdays: [0, 2], action: "report", prompt: base.prompt } });
    expect(retimeAutomation(c.config, { times: [], days: "working" })).toMatchObject({ ok: false });
    const cond = checkAutomation({ ...base, trigger: "condition", conditionSql: 'SELECT 1 AS key' });
    if (!cond.ok) throw new Error(cond.error);
    expect(retimeAutomation(cond.config, { checkEveryMin: 60, activeFrom: "08:00", activeTo: "16:00", times: ["01:00"] }))
      .toMatchObject({ ok: true, config: { trigger: "condition", checkEveryMin: 60, activeFrom: "08:00", activeTo: "16:00", times: [] } });
  });
});

describe("an event automation", () => {
  const ev = { name: "Holds", trigger: "event", eventTypes: ["order.held"], action: "notify", message: "{who}: {detail}" };
  it("is checked: known events, people by id, short words", () => {
    const ok = checkAutomation({ ...ev, eventActorIds: [9, 9], eventMatch: "  SF01/MO/1 " });
    expect(ok.ok && ok.config).toMatchObject({ trigger: "event", eventTypes: ["order.held"], eventActorIds: [9], eventMatch: "SF01/MO/1", times: [], conditionSql: null });
    expect(checkAutomation({ ...ev, eventTypes: [] })).toMatchObject({ ok: false, error: "Say which events fire it." });
    expect(checkAutomation({ ...ev, eventTypes: ["order.burned"] })).toMatchObject({ ok: false, error: expect.stringContaining("not an event the app records") });
    expect(checkAutomation({ ...ev, eventActorIds: [0] })).toMatchObject({ ok: false });
  });
  it("reads as what fires it and by whom", () => {
    const c = checkAutomation({ ...ev, eventTypes: ["order.held", "order.closed"], eventMatch: "Welding" });
    expect(c.ok && describeTrigger(c.config, ["Sara"])).toBe("the moment: order put on hold, order closed by Sara — mentioning “Welding”");
  });
  it("fills an event's blanks in its message, without a table under it", () => {
    expect(renderMessage("{who} — {detail}", { name: "Holds", rows: [{ a: 1 }], fields: { who: "Sara", detail: "Put MO/1 on hold" } })).toBe("Sara — Put MO/1 on hold");
  });
  it("has no timing to change", () => {
    const c = checkAutomation(ev);
    expect(c.ok && retimeAutomation(c.config, { times: ["07:00"] })).toMatchObject({ ok: false });
  });
});

describe("rows as a person reads them", () => {
  const now = new Date("2026-10-13T10:00:00Z");
  it("lists a few rows field by field — names in words, days as the app writes them, empty fields left out", () => {
    const rows = [{ key: "7", by: null, note: "Born from a daily-log row", status: "Pending", qty: 9, odooMo: "", fgCode: "FB-051", soi: "S01328-35", date: "2026-10-12T00:00:00.000Z" }];
    expect(rowsForPeople(rows, { now })).toBe(
      "- **Note:** Born from a daily-log row\n- **Status:** Pending\n- **Qty:** 9\n- **FG code:** FB-051\n- **SOI:** S01328-35\n- **Date:** Mon 12 Oct",
    );
  });
  it("puts many rows in a table without the columns no row fills, and escapes what Markdown would read", () => {
    const rows = [1, 2, 3, 4].map((n) => ({ mo: `MO/${n}`, empty: null, note: n === 1 ? "a | b *c*" : "x" }));
    const out = rowsForPeople(rows, { now });
    expect(out.split("\n").slice(0, 3)).toEqual(["| MO | Note |", "| --- | --- |", "| MO/1 | a \\| b \\*c\\* |"]);
  });
  it("says how many more there were", () => {
    const rows = Array.from({ length: 5 }, (_, n) => ({ mo: `MO/${n}` }));
    expect(rowsForPeople(rows, { max: 4, now })).toContain("…and 1 more.");
  });
});
