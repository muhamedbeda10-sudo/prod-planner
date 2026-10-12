import { describe, expect, it } from "vitest";
import { checkAutomation, describeTrigger, freshRows, nextConditionCheck, nextScheduleRun, recipientsOf, renderMessage, rowKey, type AutomationConfig } from "./automations";

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
      [{ ...base, trigger: "sometimes" }, "schedule or a condition"],
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
    expect(renderMessage("{count} order(s) held — {name}", { name: "Held orders", rows })).toBe("1 order(s) held — Held orders\n\n| mo | dept |\n| --- | --- |\n| MO-1 | Welding |");
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
