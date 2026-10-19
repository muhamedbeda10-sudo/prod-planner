import { describe, expect, it } from "vitest";
import { measureRates, ratesByMachine, type RateHours, type RateOutput } from "./machineRates";

const out = (dateISO: string, machineId: number, item: string, qty: number, stdHours: number): RateOutput => ({ dateISO, machineId, item, qty, stdHours });
const hrs = (dateISO: string, machineId: number, hours: number): RateHours => ({ dateISO, machineId, hours });

describe("measureRates", () => {
  it("gives a machine's whole day to the one item it ran", () => {
    const r = measureRates([out("2026-09-01", 1, "TC", 10, 12)], [hrs("2026-09-01", 1, 15)]);
    expect(r).toEqual([{ machineId: 1, item: "TC", pieces: 10, hours: 15, hoursPerPc: 1.5, days: 1 }]);
  });

  it("splits a day between the items it ran, by the standard hours they earned", () => {
    const r = measureRates(
      [out("2026-09-01", 1, "TN", 4, 12), out("2026-09-01", 1, "TC", 8, 4)],
      [hrs("2026-09-01", 1, 16)]
    );
    const tn = r.find((x) => x.item === "TN")!;
    const tc = r.find((x) => x.item === "TC")!;
    expect(tn.hours).toBe(12); // 12/16 of the day
    expect(tc.hours).toBe(4);
    expect(tn.hoursPerPc).toBe(3);
    expect(tc.hoursPerPc).toBe(0.5);
  });

  it("counts a day once however many log rows recorded the item on it", () => {
    const r = measureRates(
      [out("2026-09-01", 1, "TN", 2, 4), out("2026-09-01", 1, "TN", 3, 6)],
      [hrs("2026-09-01", 1, 10)]
    );
    expect(r).toEqual([{ machineId: 1, item: "TN", pieces: 5, hours: 10, hoursPerPc: 2, days: 1 }]);
  });

  it("measures nothing on a day mixing priced and unpriced items, rather than loading one with the other", () => {
    // 2 tanks (4 std-h) beside 10 arresters (unpriced), 9 h worked: there is
    // no fair split, so the day is left out
    const r = measureRates(
      [out("2026-09-01", 1, "TN", 2, 4), out("2026-09-01", 1, "AR", 10, 0), out("2026-09-02", 1, "TN", 2, 4)],
      [hrs("2026-09-01", 1, 9), hrs("2026-09-02", 1, 6)]
    );
    expect(r).toEqual([{ machineId: 1, item: "TN", pieces: 2, hours: 6, hoursPerPc: 3, days: 1 }]);
  });

  it("splits by pieces when nothing that day carries a standard time", () => {
    const r = measureRates(
      [out("2026-09-01", 1, "AR", 6, 0), out("2026-09-01", 1, "MB", 2, 0)],
      [hrs("2026-09-01", 1, 8)]
    );
    expect(r.find((x) => x.item === "AR")!.hours).toBe(6);
    expect(r.find((x) => x.item === "MB")!.hours).toBe(2);
    expect(r.find((x) => x.item === "MB")!.hoursPerPc).toBe(1);
  });

  it("adds the days up and counts how many it rests on", () => {
    const r = measureRates(
      [out("2026-09-01", 1, "TC", 10, 10), out("2026-09-02", 1, "TC", 10, 10)],
      [hrs("2026-09-01", 1, 15), hrs("2026-09-02", 1, 5)]
    );
    expect(r[0]).toMatchObject({ pieces: 20, hours: 20, hoursPerPc: 1, days: 2 });
  });

  it("ignores a day the shift log never recorded — there is nothing to measure with", () => {
    const r = measureRates([out("2026-09-01", 1, "TC", 10, 10), out("2026-09-02", 1, "TC", 5, 5)], [hrs("2026-09-02", 1, 10)]);
    expect(r[0]).toMatchObject({ pieces: 5, hours: 10, hoursPerPc: 2, days: 1 });
  });

  it("keeps the machines apart and adds a worker's hours on the same machine together", () => {
    const r = measureRates(
      [out("2026-09-01", 1, "TC", 10, 10), out("2026-09-01", 2, "TC", 10, 10)],
      [hrs("2026-09-01", 1, 9), hrs("2026-09-01", 1, 9), hrs("2026-09-01", 2, 5)]
    );
    expect(ratesByMachine(r)[1].TC.hoursPerPc).toBe(1.8); // two workers, 18 h
    expect(ratesByMachine(r)[2].TC.hoursPerPc).toBe(0.5);
  });

  it("says nothing about a machine that produced nothing", () => {
    expect(measureRates([], [hrs("2026-09-01", 1, 9)])).toEqual([]);
    expect(measureRates([out("2026-09-01", 1, "TC", 0, 0)], [hrs("2026-09-01", 1, 9)])).toEqual([]);
  });
});
