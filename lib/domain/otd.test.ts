import { describe, it, expect } from "vitest";
import { computeOtd, type OtdPaintLog } from "./otd";
import { utcDate } from "./dates";

const day = utcDate(2026, 7, 13); // today

function paintAll(mo: string, qty: number, date: Date): OtdPaintLog[] {
  return (["CF", "TC", "TN", "CB"] as const).map((item) => ({ mo, item, qty, date }));
}

describe("computeOtd", () => {
  const orders = [{ mo: "MO-A", planQty: 2 }];
  const schedules = [{ planNo: 28, mo: "MO-A", ovenDate: utcDate(2026, 7, 10) }];

  it("fully painted on or before the promise = on time", () => {
    const stats = computeOtd(orders, schedules, paintAll("MO-A", 2, utcDate(2026, 7, 9)), day);
    expect(stats.onTime).toBe(1);
    expect(stats.otdPct).toBe(1);
  });

  it("finished after the promise = late, with the lateness in days", () => {
    const stats = computeOtd(orders, schedules, paintAll("MO-A", 2, utcDate(2026, 7, 12)), day);
    expect(stats.late).toBe(1);
    expect(stats.worst[0].latenessDays).toBe(2); // 12th vs 10th
  });

  it("promise passed and still unfinished = open-late, lateness grows daily", () => {
    // only 3 of 4 items painted — MIN never reaches planQty
    const partial = paintAll("MO-A", 2, utcDate(2026, 7, 9)).slice(0, 3);
    const stats = computeOtd(orders, schedules, partial, day);
    expect(stats.openLate).toBe(1);
    expect(stats.worst[0].latenessDays).toBe(3); // 13th vs 10th
    expect(stats.otdPct).toBe(0);
  });

  it("future promises are upcoming and not counted in OTD%", () => {
    const stats = computeOtd(orders, [{ planNo: 28, mo: "MO-A", ovenDate: utcDate(2026, 7, 20) }], [], day);
    expect(stats.upcoming).toBe(1);
    expect(stats.due).toBe(0);
    expect(stats.otdPct).toBeNull();
  });

  it("a NEWER plan's re-promise replaces the old date", () => {
    const scheds = [
      { planNo: 27, mo: "MO-A", ovenDate: utcDate(2026, 7, 5) }, // old promise (missed)
      { planNo: 28, mo: "MO-A", ovenDate: utcDate(2026, 7, 12) }, // re-promised
    ];
    const stats = computeOtd(orders, scheds, paintAll("MO-A", 2, utcDate(2026, 7, 11)), day);
    expect(stats.onTime).toBe(1); // judged against 12/07, not 05/07
  });

  it("completion day = when the SLOWEST item reached the quantity", () => {
    const logs: OtdPaintLog[] = [
      ...paintAll("MO-A", 2, utcDate(2026, 7, 8)).slice(0, 3),
      { mo: "MO-A", item: "CB", qty: 1, date: utcDate(2026, 7, 8) },
      { mo: "MO-A", item: "CB", qty: 1, date: utcDate(2026, 7, 12) }, // CB finishes late
    ];
    const stats = computeOtd(orders, schedules, logs, day);
    expect(stats.late).toBe(1);
    expect(stats.worst[0].completedISO).toBe("2026-07-12");
  });

  it("OSP share is satisfied without in-house painting", () => {
    // TN fully outsourced: the other 3 items painted on time close the order
    const logs = paintAll("MO-A", 2, utcDate(2026, 7, 9)).filter((l) => l.item !== "TN");
    const stats = computeOtd(
      [{ mo: "MO-A", planQty: 2, osp: { TN: 2 } }],
      schedules,
      logs,
      day
    );
    expect(stats.onTime).toBe(1);
  });

  it("orders never scheduled in any plan are skipped entirely", () => {
    const stats = computeOtd([{ mo: "MO-X", planQty: 5 }], [], [], day);
    expect(stats.due + stats.upcoming).toBe(0);
  });
});
