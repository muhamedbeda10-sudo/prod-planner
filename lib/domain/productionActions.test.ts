import { describe, it, expect } from "vitest";
import { gapDays, productionActions } from "./productionActions";
import { formatDate } from "./format";

const hrefs = { stops: "/shifts?view=downtime", shifts: "/shifts", returns: "/worklist/cut", repair: "/worklist/welding", standardTimes: "/admin/standard-times", dailyLog: "/handover" };

describe("what needs intervention in production", () => {
  it("names the open stop, the urgent returns, the slow department and the gaps in the records, worst first", () => {
    const a = productionActions({
      openStops: [{ machine: "B4-10", dept: "Cut", cause: "Breakdown — mechanical", hours: 5.5, sinceISO: "2026-10-25" }, { machine: "L2", dept: "Cut", cause: "No material", hours: 1, sinceISO: "2026-10-26" }],
      depts: [{ label: "Welding", days: 5, efficiency: 0.55, pricedShare: 1 }, { label: "Painting", days: 2, efficiency: 0.2 }, { label: "Fabrication", days: 6, efficiency: 0.4, pricedShare: 0.3 }],
      gapDays: [{ dateISO: "2026-10-22", kind: "output-no-hours" }, { dateISO: "2026-10-23", kind: "hours-no-output" }],
      returns: { open: 3, onUrgent: 1 },
      tanksInRepair: 2,
      pricedShare: 0.6,
      hrefs,
    });
    expect(a.map((x) => x.tone)).toEqual(["bad", "bad", "warn", "warn", "info", "info"]);
    expect(a[0].text).toContain(`2 machines are still stopped — B4-10 (Cut) since ${formatDate("2026-10-25")}, 5 h 30 min so far`);
    expect(a[1].text).toContain("1 return on urgent orders is still open");
    // Welding is judged; Painting has too few days; Fabrication's output is mostly unpriced
    expect(a[2].text).toContain("Welding worked at 55%");
    expect(a[3].text).toContain("2 tanks failed the leak test");
    expect(a[4].text).toContain(`1 day with output but no attendance recorded (${formatDate("2026-10-22")})`);
    expect(a[5].text).toContain(`hours booked but nothing on the Daily log (${formatDate("2026-10-23")})`);
  });
  it("says when the standard hours cover little, and is quiet when there is nothing", () => {
    const a = productionActions({ openStops: [], depts: [], gapDays: [], pricedShare: 0.5, hrefs });
    expect(a).toHaveLength(1);
    expect(a[0].text).toContain("Only 50% of the period's pieces carry standard hours");
    expect(productionActions({ openStops: [], depts: [{ label: "Welding", days: 5, efficiency: 0.95 }], gapDays: [], pricedShare: 1, hrefs })).toEqual([]);
  });
});

describe("the days whose records disagree", () => {
  it("flags output with no hours and hours with no output, never today, by recorded quantity not earned hours", () => {
    const g = gapDays(
      [{ dateISO: "2026-10-22", qty: 3 }, { dateISO: "2026-10-24", qty: 5 }, { dateISO: "2026-10-25", qty: 0 }, { dateISO: "2026-10-26", qty: 2 }], // the 26th is today, still being written
      [{ dateISO: "2026-10-23", workedH: 40 }, { dateISO: "2026-10-23", workedH: 10 }, { dateISO: "2026-10-24", workedH: 30 }, { dateISO: "2026-10-25", workedH: 8 }],
      "2026-10-26",
    );
    expect(g).toEqual([{ dateISO: "2026-10-22", kind: "output-no-hours" }, { dateISO: "2026-10-23", kind: "hours-no-output" }, { dateISO: "2026-10-25", kind: "hours-no-output" }]);
  });
  it("judges the non-urgent returns, the 0.8 priced threshold and the cap of six", () => {
    const a = productionActions({ openStops: [], depts: [{ label: "Welding", days: 5, efficiency: 0.5, pricedShare: 0.8 }], gapDays: [], returns: { open: 3, onUrgent: 0 }, pricedShare: 0.8, hrefs });
    expect(a.map((x) => x.text)).toEqual([expect.stringContaining("Welding worked at 50%"), expect.stringContaining("3 returns still open")]);
    const many = productionActions({
      openStops: [{ machine: "L2", dept: "Cut", cause: "No material", hours: 1, sinceISO: "2026-10-26" }, { machine: "B4-10", dept: "Cut", cause: "Breakdown", hours: 5, sinceISO: "2026-10-25" }],
      depts: [{ label: "Welding", days: 5, efficiency: 0.5 }, { label: "Painting", days: 5, efficiency: 0.4 }],
      gapDays: [{ dateISO: "2026-10-22", kind: "output-no-hours" }, { dateISO: "2026-10-23", kind: "hours-no-output" }],
      returns: { open: 2, onUrgent: 1 }, tanksInRepair: 1, pricedShare: 0.5, hrefs,
    });
    expect(many).toHaveLength(6);
    // the biggest stop is named whatever the order given
    expect(many[0].text).toContain("B4-10");
    expect(many.some((x) => x.text.includes("Only 50%"))).toBe(false);
  });
});
